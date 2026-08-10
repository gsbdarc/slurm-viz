import * as redivis from "redivis";
import { ec2CostSqlExpr } from "../lib/ec2";

const TABLE_NAME = "yen_sacct_dump";
const dataset = redivis.organization("StanfordGSBSandbox").dataset("slurm_stats");
const CACHE_TTL = 300_000;

/**
 * Collapsing the dump's periodic snapshots down to one row per job.
 *
 * PARTITION — keyed on (JobID, Submit), not JobID alone. The Yen's JobID counter was reset to 1 in
 * January 2026, and as of August 2026 it has climbed back into the range the pre-reset data still
 * occupies (434,400–1,030,357). Keying on JobID alone would silently discard one of any two
 * genuinely different jobs that land on the same ID, and the counter has ~595k previously-used IDs
 * still ahead of it. `Submit` separates them: it is fixed at submission and the two eras are ~a
 * year apart, while snapshots of a single job all share it exactly.
 *
 * ORDER — a long-running job appears many times with a growing `ElapsedRaw`. For those rows `End`
 * is NULL and `Start`/`Submit` are identical, so ordering on those three alone is a total tie and
 * ROW_NUMBER picks arbitrarily; the same job would then report wildly different runtimes (and
 * therefore costs) from one query to the next. `End DESC NULLS LAST` prefers a finished record over
 * a mid-flight snapshot, `ElapsedRaw DESC` takes the freshest snapshot of a job still running, and
 * `TO_JSON_STRING` is a final deterministic key so byte-identical duplicates can't reorder either.
 *
 * Known edge: 154 JobIDs have rows whose `Submit` differs (by up to 39 days) — most likely
 * requeues. These are kept as separate jobs rather than collapsed.
 */
const DEDUP_PARTITION = "`JobID`, `Submit`";
const DEDUP_ORDER =
  "`End` DESC NULLS LAST, `ElapsedRaw` DESC NULLS LAST, " +
  "`Start` DESC NULLS LAST, TO_JSON_STRING(t)";

function dedupCte(derivedColumns = "") {
  return `jobs AS (
    SELECT *${derivedColumns}
    FROM (
        SELECT *, ROW_NUMBER() OVER (
            PARTITION BY ${DEDUP_PARTITION} ORDER BY ${DEDUP_ORDER}
        ) AS _rn
        FROM \`${TABLE_NAME}\` AS t
    ) WHERE _rn = 1
)`;
}

const DEDUP_CTE = dedupCte();

const queryCache = new Map();

function hashKey(sql) {
  let h = 0;
  for (let i = 0; i < sql.length; i++) {
    h = ((h << 5) - h + sql.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

async function runQuery(sql, cacheKey) {
  const key = cacheKey ? `${cacheKey}_${hashKey(sql)}` : null;
  if (key && queryCache.has(key)) {
    const cached = queryCache.get(key);
    if (Date.now() - cached.fetchedAt < CACHE_TTL) return cached.result;
  }

  const rows = await dataset.query(sql).listRows();

  if (key) {
    queryCache.set(key, { result: rows, fetchedAt: Date.now() });
  }
  return rows;
}

/** Quote a value as a BigQuery string literal. */
function sqlString(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateClause(start, end) {
  const parts = [];
  if (start) parts.push(`\`Submit\` >= ${sqlString(start)}`);
  if (end) parts.push(`\`Submit\` < ${sqlString(addDays(end, 1))}`);
  return parts.length ? parts.join(" AND ") : "1=1";
}

function granularity(start, end) {
  let days = 30;
  try {
    days = Math.round(
      (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24),
    );
  } catch {}
  if (days <= 14) return ["day", "DATE(`Submit`)"];
  if (days <= 90) return ["week", "DATE_TRUNC(`Submit`, WEEK)"];
  return ["month", "DATE_TRUNC(`Submit`, MONTH)"];
}

export function defaultDateRange() {
  const end = new Date().toISOString().slice(0, 10);
  const start = addDays(end, -30);
  return [start, end];
}

// ---------------------------------------------------------------------------
// Derived SQL fragments (memory, GPUs, EC2 cost)
// ---------------------------------------------------------------------------

const MEM_NUM_SQL = "SAFE_CAST(REGEXP_EXTRACT(`ReqMem`, r'^\\s*([0-9]*\\.?[0-9]+)') AS FLOAT64)";
const MEM_UNIT_SQL =
  "UPPER(IFNULL(REGEXP_EXTRACT(`ReqMem`, r'^\\s*[0-9]*\\.?[0-9]+\\s*([KMGTkmgt])'), ''))";
const MEM_PER_CPU_SQL = "REGEXP_CONTAINS(`ReqMem`, r'[cC]\\s*$')";

/**
 * ReqMem -> GB.
 *
 * Slurm writes a unit suffix and, on older versions, a per-CPU (`4Gc`) or per-node (`64Gn`) scope
 * marker. The scope letter has to be stripped before the unit is read, and `c` means the value is
 * per-CPU and must be multiplied by NCPUS to get the job's total request. A bare number is a raw
 * byte count.
 */
const REQ_MEM_GB_SQL = `(
    CASE
        WHEN \`ReqMem\` IS NULL OR TRIM(\`ReqMem\`) = '' THEN NULL
        ELSE ${MEM_NUM_SQL}
             * CASE ${MEM_UNIT_SQL}
                 WHEN 'K' THEN 1 / (1024 * 1024)
                 WHEN 'M' THEN 1 / 1024
                 WHEN 'G' THEN 1
                 WHEN 'T' THEN 1024
                 ELSE 1 / (1024 * 1024 * 1024)
               END
             * CASE WHEN ${MEM_PER_CPU_SQL} THEN GREATEST(IFNULL(\`NCPUS\`, 1), 1) ELSE 1 END
    END
)`;

/**
 * The TRES column holding GPU allocations, resolved once against the live schema.
 *
 * Slurm dumps vary: some have `AllocTRES`, some only `ReqTRES`, some neither. Probing one row and
 * adapting beats hardcoding a column name that makes every query fail.
 */
let tresColumnPromise = null;

function resolveTresColumn() {
  if (!tresColumnPromise) {
    tresColumnPromise = runQuery(
      `SELECT * FROM \`${TABLE_NAME}\` LIMIT 1`,
      "schema_probe",
    )
      .then((rows) => {
        const cols = new Set(Object.keys(rows[0] || {}));
        for (const candidate of ["AllocTRES", "ReqTRES", "ReqGRES"]) {
          if (cols.has(candidate)) return candidate;
        }
        console.warn(
          "[slurm-viz] No TRES column found in " +
            TABLE_NAME +
            "; GPU counts will be treated as 0 and GPU job costs will be understated.",
        );
        return null;
      })
      .catch((err) => {
        console.warn("[slurm-viz] Schema probe failed, assuming no TRES column:", err);
        return null;
      });
  }
  return tresColumnPromise;
}

/**
 * SQL fragments that depend on the resolved schema: `{ tresColumn, cte, ec2Cost }`.
 *
 * `cte` replaces the plain `DEDUP_CTE` for cost queries — it projects `_mem_gb` and `_gpu_count`
 * once so the ~40-branch cost CASE can reference short column names instead of inlining the whole
 * ReqMem parser in every branch.
 */
async function sqlFragments() {
  const tresColumn = await resolveTresColumn();
  const gpuCount = tresColumn
    ? `IFNULL(SAFE_CAST(REGEXP_EXTRACT(\`${tresColumn}\`, r'gres/gpu[^=,]*=([0-9]+)') AS INT64), 0)`
    : "0";

  return {
    tresColumn,
    cte: dedupCte(`, ${REQ_MEM_GB_SQL} AS _mem_gb, ${gpuCount} AS _gpu_count`),
    ec2Cost: ec2CostSqlExpr({
      cpuExpr: "`NCPUS`",
      memExpr: "`_mem_gb`",
      gpuExpr: "`_gpu_count`",
      elapsedExpr: "`ElapsedRaw`",
    }),
  };
}

// ---------------------------------------------------------------------------
// Node index and filtering
// ---------------------------------------------------------------------------

function expandNodelist(nodelist) {
  const nodes = new Set();
  if (!nodelist) return nodes;
  const parts = nodelist.split(/,(?![^\[]*\])/);
  for (const part of parts) {
    const trimmed = part.trim();
    const m = trimmed.match(/^(.+?)\[(.+)\]$/);
    if (m) {
      const prefix = m[1];
      for (const r of m[2].split(",")) {
        if (r.includes("-")) {
          const [lo, hi] = r.split("-", 2);
          const width = lo.length;
          for (let i = parseInt(lo, 10); i <= parseInt(hi, 10); i++) {
            nodes.add(prefix + String(i).padStart(width, "0"));
          }
        } else {
          nodes.add(prefix + r);
        }
      }
    } else {
      nodes.add(trimmed);
    }
  }
  // sacct writes "None assigned" (and plain "None") for jobs that never landed on a node; those
  // are placeholders, not machines, and must not show up as options in the node filter.
  for (const n of nodes) {
    if (n === "" || n === "None" || n.startsWith("None assigned")) nodes.delete(n);
  }
  return nodes;
}

const nodeIndexCache = new Map();

/**
 * Map every individual node to the raw `NodeList` strings that mention it.
 *
 * `NodeList` stores compact ranges (`yen-gpu[1-3]`), so a node can't be matched with `=` or `LIKE`:
 * `LIKE '%yen-gpu4%'` also matches `yen-gpu40`, and nothing matches a node hidden inside a range.
 * Expanding the (small) set of distinct NodeList values client-side and matching exact strings is
 * exact. Promises are cached so concurrent dashboards share one query.
 */
export function getNodeIndex(start, end, where) {
  const clause = where || dateClause(start, end);
  const key = `${start}_${end}_${hashKey(clause)}`;
  if (nodeIndexCache.has(key)) return nodeIndexCache.get(key);

  const promise = (async () => {
    const rows = await runQuery(
      `WITH ${DEDUP_CTE}
       SELECT DISTINCT \`NodeList\` AS nl FROM jobs
       WHERE ${clause} AND \`NodeList\` IS NOT NULL AND \`NodeList\` != ''`,
      `nodeindex_${key}`,
    );

    const byNode = new Map();
    for (const row of rows) {
      const raw = row.nl;
      for (const node of expandNodelist(raw)) {
        if (!byNode.has(node)) byNode.set(node, []);
        byNode.get(node).push(raw);
      }
    }

    const nodes = [...byNode.keys()].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    );
    return { nodes, byNode };
  })();

  nodeIndexCache.set(key, promise);
  return promise;
}

/** Above this many distinct NodeList strings for one node, fall back to a regex match. */
const MAX_NODE_LITERALS = 1000;

function nodePredicate(index, node) {
  const lists = index.byNode.get(node);
  if (!lists || lists.length === 0) return "1=0";
  if (lists.length > MAX_NODE_LITERALS) {
    console.warn(
      `[slurm-viz] ${node} appears in ${lists.length} distinct NodeList values; ` +
        "falling back to a regex match, which will miss jobs where the node is inside a range.",
    );
    const escaped = node.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return `REGEXP_CONTAINS(\`NodeList\`, r'(^|,)${escaped}($|,)')`;
  }
  return `\`NodeList\` IN (${lists.map(sqlString).join(", ")})`;
}

/**
 * Build a WHERE clause for the given date range and filters.
 *
 * Async because the node predicate needs the node index. `extra` holds any additional literal
 * conditions the caller requires.
 */
async function buildWhere(start, end, filters = {}, extra = []) {
  const { state, user, partition, node } = filters;
  const conditions = [dateClause(start, end), ...extra];
  if (state) conditions.push(`\`State\` LIKE ${sqlString(`%${state}%`)}`);
  if (user) conditions.push(`\`User\` = ${sqlString(user)}`);
  if (partition) conditions.push(`\`Partition\` = ${sqlString(partition)}`);
  if (node) {
    const index = await getNodeIndex(start, end);
    conditions.push(nodePredicate(index, node));
  }
  return conditions.join(" AND ");
}

/** Stable cache-key fragment for a filter set. */
function filterKey(filters = {}) {
  return [filters.state, filters.user, filters.partition, filters.node]
    .map((v) => v || "")
    .join("|");
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getFilterOptions(start, end) {
  const dc = dateClause(start, end);
  const ck = `filters_${start}_${end}`;

  const [users, partitions, states, nodeIndex] = await Promise.all([
    runQuery(
      `WITH ${DEDUP_CTE}
       SELECT DISTINCT \`User\` AS val FROM jobs
       WHERE ${dc} AND \`User\` IS NOT NULL ORDER BY val`,
      `${ck}_users`,
    ),
    runQuery(
      `WITH ${DEDUP_CTE}
       SELECT DISTINCT \`Partition\` AS val FROM jobs
       WHERE ${dc} AND \`Partition\` IS NOT NULL ORDER BY val`,
      `${ck}_partitions`,
    ),
    runQuery(
      `WITH ${DEDUP_CTE}
       SELECT DISTINCT
           CASE
               WHEN \`State\` IS NULL THEN 'UNKNOWN'
               WHEN \`State\` LIKE 'CANCELLED%' THEN 'CANCELLED'
               ELSE \`State\`
           END AS val
       FROM jobs WHERE ${dc} ORDER BY val`,
      `${ck}_states`,
    ),
    getNodeIndex(start, end),
  ]);

  return {
    users: users.map((r) => r.val),
    partitions: partitions.map((r) => r.val),
    states: states.map((r) => r.val),
    nodes: nodeIndex.nodes,
  };
}

export async function getSummary(start, end, filters = {}) {
  const [where, frag] = await Promise.all([
    buildWhere(start, end, filters),
    sqlFragments(),
  ]);
  const ck = `summary_${start}_${end}_${filterKey(filters)}`;

  const rows = await runQuery(
    `WITH ${frag.cte}
     SELECT
         COUNT(*) AS total_jobs,
         COUNT(DISTINCT \`User\`) AS unique_users,
         COUNT(DISTINCT \`Partition\`) AS unique_partitions,
         SUM(${frag.ec2Cost}) AS total_ec2_cost_usd,
         COUNTIF(\`State\` = 'COMPLETED') AS completed,
         COUNTIF(\`State\` = 'FAILED') AS failed,
         COUNTIF(\`State\` LIKE 'CANCELLED%') AS cancelled,
         COUNTIF(\`State\` = 'RUNNING') AS running,
         COUNTIF(\`State\` = 'PENDING') AS pending,
         COUNTIF(\`State\` = 'TIMEOUT') AS timeout,
         COUNTIF(\`State\` = 'OUT_OF_MEMORY') AS out_of_memory,
         COUNTIF(\`State\` = 'NODE_FAIL') AS node_fail
     FROM jobs WHERE ${where}`,
    ck,
  );

  const r = rows[0] || {};
  const stateCounts = {};
  for (const key of [
    "completed",
    "failed",
    "cancelled",
    "running",
    "pending",
    "timeout",
    "out_of_memory",
    "node_fail",
  ]) {
    const val = r[key] || 0;
    if (val) stateCounts[key.toUpperCase().replace(/_/g, " ")] = val;
  }

  return {
    total_jobs: r.total_jobs || 0,
    unique_users: r.unique_users || 0,
    unique_partitions: r.unique_partitions || 0,
    total_ec2_cost_usd: r.total_ec2_cost_usd || 0,
    state_counts: stateCounts,
  };
}

export async function getTimeline(start, end, filters = {}) {
  const where = await buildWhere(start, end, filters);
  const [gran, expr] = granularity(start, end);
  const ck = `timeline_${start}_${end}_${filterKey(filters)}`;

  const rows = await runQuery(
    `WITH ${DEDUP_CTE}
     SELECT ${expr} AS period, COUNT(*) AS count
     FROM jobs WHERE ${where}
     GROUP BY period ORDER BY period`,
    ck,
  );

  return { granularity: gran, data: rows };
}

export async function getJobs(start, end, filters = {}) {
  const [where, frag] = await Promise.all([
    buildWhere(start, end, filters),
    sqlFragments(),
  ]);
  const fk = `jobs_${start}_${end}_${filterKey(filters)}`;

  const [countRows, rows] = await Promise.all([
    runQuery(
      `WITH ${frag.cte}
       SELECT COUNT(*) AS total, SUM(${frag.ec2Cost}) AS total_ec2_cost_usd
       FROM jobs WHERE ${where}`,
      `cnt_${fk}`,
    ),
    runQuery(
      `WITH ${frag.cte}
       SELECT \`JobID\`, \`JobName\`, \`User\`, \`Partition\`, \`State\`, \`NCPUS\`,
              \`ElapsedRaw\`, \`Submit\`, \`Start\`, \`End\`, \`NodeList\`,
              \`_mem_gb\` AS ReqMem_GB,
              \`_gpu_count\` AS gpu_count,
              CASE WHEN \`Start\` IS NOT NULL AND \`Start\` > \`Submit\`
                  THEN TIMESTAMP_DIFF(TIMESTAMP(\`Start\`), TIMESTAMP(\`Submit\`), SECOND)
                  ELSE NULL END AS wait_seconds
       FROM jobs WHERE ${where}
       ORDER BY \`Submit\` DESC LIMIT 500`,
      `rows_${fk}`,
    ),
  ]);

  return {
    jobs: rows,
    total: countRows[0]?.total || 0,
    total_ec2_cost_usd: countRows[0]?.total_ec2_cost_usd || 0,
  };
}

export async function getClusterUtilization(start, end, filters = {}) {
  const [where, frag] = await Promise.all([
    buildWhere(start, end, filters),
    sqlFragments(),
  ]);
  const ck = `cluster_${start}_${end}_${filterKey(filters)}`;

  const [partitionRows, nodeIndex] = await Promise.all([
    runQuery(
      `WITH ${frag.cte}
       SELECT
           \`Partition\`,
           COUNT(*) AS job_count,
           SUM(\`NCPUS\`) AS total_cpus,
           AVG(\`NCPUS\`) AS avg_cpus_per_job,
           AVG(\`_mem_gb\`) AS avg_mem_gb,
           AVG(\`ElapsedRaw\`) AS avg_elapsed_seconds,
           AVG(CASE WHEN \`Start\` IS NOT NULL AND \`Start\` > \`Submit\`
               THEN TIMESTAMP_DIFF(TIMESTAMP(\`Start\`), TIMESTAMP(\`Submit\`), SECOND)
               ELSE NULL END) AS avg_wait_seconds,
           SUM(${frag.ec2Cost}) AS ec2_cost_usd
       FROM jobs WHERE ${where}
       GROUP BY \`Partition\` ORDER BY job_count DESC`,
      ck,
    ),
    getNodeIndex(start, end, where),
  ]);

  return {
    cpu_by_partition: partitionRows,
    partitions: Object.fromEntries(
      partitionRows.map((r) => [r.Partition, r.job_count]),
    ),
    nodes_used: nodeIndex.nodes.length,
  };
}

export async function getUserSummaries(start, end, filters = {}) {
  const [where, frag] = await Promise.all([
    buildWhere(start, end, filters),
    sqlFragments(),
  ]);
  const ck = `users_${start}_${end}_${filterKey(filters)}`;

  return runQuery(
    `WITH ${frag.cte}
     SELECT
         \`User\`,
         COUNT(*) AS job_count,
         SUM(\`NCPUS\`) AS total_cpus,
         SUM(\`ElapsedRaw\`) AS total_elapsed,
         SUM(CAST(\`NCPUS\` AS FLOAT64) * \`ElapsedRaw\`) / 3600 AS cpu_hours,
         SUM(${frag.ec2Cost}) AS ec2_cost_usd,
         SUM(CASE WHEN \`Start\` IS NOT NULL AND \`Start\` > \`Submit\`
             THEN TIMESTAMP_DIFF(TIMESTAMP(\`Start\`), TIMESTAMP(\`Submit\`), SECOND)
             ELSE 0 END) / 3600.0 AS total_wait_hours
     FROM jobs WHERE ${where}
     GROUP BY \`User\` ORDER BY cpu_hours DESC`,
    ck,
  );
}

export async function getWaitTimes(start, end, filters = {}) {
  const where = await buildWhere(start, end, filters, [
    "`Start` IS NOT NULL",
    "`Start` > `Submit`",
  ]);
  const [gran, expr] = granularity(start, end);
  const ck = `wait_${start}_${end}_${filterKey(filters)}`;

  const rows = await runQuery(
    `WITH ${DEDUP_CTE}
     SELECT
         ${expr} AS period,
         AVG(TIMESTAMP_DIFF(TIMESTAMP(\`Start\`), TIMESTAMP(\`Submit\`), SECOND)) / 60.0 AS avg_wait_minutes,
         APPROX_QUANTILES(TIMESTAMP_DIFF(TIMESTAMP(\`Start\`), TIMESTAMP(\`Submit\`), SECOND) / 60.0, 100)[OFFSET(50)] AS median_wait_minutes,
         MAX(TIMESTAMP_DIFF(TIMESTAMP(\`Start\`), TIMESTAMP(\`Submit\`), SECOND)) / 60.0 AS max_wait_minutes
     FROM jobs WHERE ${where}
     GROUP BY period ORDER BY period`,
    ck,
  );

  return { granularity: gran, data: rows };
}

export async function getUsersByPeriod(start, end, filters = {}) {
  const where = await buildWhere(start, end, filters);
  const [gran, expr] = granularity(start, end);
  const ck = `users_period_${start}_${end}_${filterKey(filters)}`;

  const rows = await runQuery(
    `WITH ${DEDUP_CTE}
     SELECT
         ${expr} AS period,
         \`Partition\`,
         COUNT(DISTINCT \`User\`) AS unique_users
     FROM jobs WHERE ${where}
     GROUP BY period, \`Partition\` ORDER BY period`,
    ck,
  );

  return { granularity: gran, data: rows };
}
