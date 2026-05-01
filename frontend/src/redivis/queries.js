import * as redivis from "redivis";

const TABLE_NAME = "yen_sacct_dump";
const dataset = redivis.organization("StanfordGSBSandbox").dataset("slurm_stats");
const CACHE_TTL = 300_000;

const DEDUP_CTE = `jobs AS (
    SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY \`JobID\` ORDER BY \`End\` DESC, \`Start\` DESC, \`Submit\` DESC) AS _rn
        FROM \`${TABLE_NAME}\`
    ) WHERE _rn = 1
)`;

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

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateClause(start, end) {
  const parts = [];
  if (start) parts.push(`\`Submit\` >= '${start}'`);
  if (end) parts.push(`\`Submit\` < '${addDays(end, 1)}'`);
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

function filterConditions(start, end, { state, user, partition } = {}) {
  const conditions = [dateClause(start, end)];
  if (state) conditions.push(`\`State\` LIKE '%${state}%'`);
  if (user) conditions.push(`\`User\` = '${user}'`);
  if (partition) conditions.push(`\`Partition\` = '${partition}'`);
  return conditions.join(" AND ");
}

function parseMemToGb(val) {
  if (val == null) return null;
  const s = String(val).trim();
  if (!s) return null;
  const num = parseFloat(s);
  if (!isNaN(num) && s === String(num))
    return Math.round((num / 1024 ** 3) * 100) / 100;
  const suffix = s.slice(-1).toUpperCase();
  const base = parseFloat(s.slice(0, -1));
  if (isNaN(base)) return null;
  if (suffix === "K") return Math.round((base / 1024 ** 2) * 100) / 100;
  if (suffix === "M") return Math.round((base / 1024) * 100) / 100;
  if (suffix === "G") return Math.round(base * 100) / 100;
  if (suffix === "T") return Math.round(base * 1024 * 100) / 100;
  return null;
}

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
  nodes.delete("");
  nodes.delete("None");
  return nodes;
}

export async function getFilterOptions(start, end) {
  const dc = dateClause(start, end);
  const ck = `filters_${start}_${end}`;

  const [users, partitions, states] = await Promise.all([
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
  ]);

  return {
    users: users.map((r) => r.val),
    partitions: partitions.map((r) => r.val),
    states: states.map((r) => r.val),
  };
}

export async function getSummary(start, end, filters = {}) {
  const where = filterConditions(start, end, filters);
  const ck = `summary_${start}_${end}_${filters.state}_${filters.user}_${filters.partition}`;

  const rows = await runQuery(
    `WITH ${DEDUP_CTE}
     SELECT
         COUNT(*) AS total_jobs,
         COUNT(DISTINCT \`User\`) AS unique_users,
         COUNT(DISTINCT \`Partition\`) AS unique_partitions,
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
    state_counts: stateCounts,
  };
}

export async function getTimeline(start, end, filters = {}) {
  const where = filterConditions(start, end, filters);
  const [gran, expr] = granularity(start, end);
  const ck = `timeline_${start}_${end}_${filters.state}_${filters.user}_${filters.partition}`;

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
  const where = filterConditions(start, end, filters);
  const fk = `jobs_${start}_${end}_${filters.state}_${filters.user}_${filters.partition}`;

  const [countRows, rows] = await Promise.all([
    runQuery(
      `WITH ${DEDUP_CTE} SELECT COUNT(*) AS total FROM jobs WHERE ${where}`,
      `cnt_${fk}`,
    ),
    runQuery(
      `WITH ${DEDUP_CTE}
       SELECT \`JobID\`, \`JobName\`, \`User\`, \`Partition\`, \`State\`, \`NCPUS\`,
              \`ReqMem\`, \`ElapsedRaw\`, \`Submit\`, \`Start\`, \`End\`, \`NodeList\`,
              CASE WHEN \`Start\` IS NOT NULL AND \`Start\` > \`Submit\`
                  THEN TIMESTAMP_DIFF(TIMESTAMP(\`Start\`), TIMESTAMP(\`Submit\`), SECOND)
                  ELSE NULL END AS wait_seconds
       FROM jobs WHERE ${where}
       ORDER BY \`Submit\` DESC LIMIT 500`,
      `rows_${fk}`,
    ),
  ]);

  const total = countRows[0]?.total || 0;
  const jobs = rows.map((r) => {
    const { ReqMem, ...rest } = r;
    return { ...rest, ReqMem_GB: parseMemToGb(ReqMem) };
  });

  return { jobs, total };
}

export async function getClusterUtilization(start, end) {
  const dc = dateClause(start, end);
  const ck = `cluster_${start}_${end}`;

  const [partitionRows, nodelistRows] = await Promise.all([
    runQuery(
      `WITH ${DEDUP_CTE}
       SELECT
           \`Partition\`,
           COUNT(*) AS job_count,
           SUM(\`NCPUS\`) AS total_cpus,
           AVG(\`NCPUS\`) AS avg_cpus_per_job,
           AVG(CASE
               WHEN \`ReqMem\` IS NULL OR \`ReqMem\` = '' THEN NULL
               WHEN ENDS_WITH(\`ReqMem\`, 'T') THEN SAFE_CAST(SUBSTR(\`ReqMem\`, 1, LENGTH(\`ReqMem\`) - 1) AS FLOAT64) * 1024
               WHEN ENDS_WITH(\`ReqMem\`, 'G') THEN SAFE_CAST(SUBSTR(\`ReqMem\`, 1, LENGTH(\`ReqMem\`) - 1) AS FLOAT64)
               WHEN ENDS_WITH(\`ReqMem\`, 'M') THEN SAFE_CAST(SUBSTR(\`ReqMem\`, 1, LENGTH(\`ReqMem\`) - 1) AS FLOAT64) / 1024
               WHEN ENDS_WITH(\`ReqMem\`, 'K') THEN SAFE_CAST(SUBSTR(\`ReqMem\`, 1, LENGTH(\`ReqMem\`) - 1) AS FLOAT64) / (1024 * 1024)
               ELSE SAFE_CAST(\`ReqMem\` AS FLOAT64) / (1024 * 1024 * 1024)
           END) AS avg_mem_gb,
           AVG(\`ElapsedRaw\`) AS avg_elapsed_seconds,
           AVG(CASE WHEN \`Start\` IS NOT NULL AND \`Start\` > \`Submit\`
               THEN TIMESTAMP_DIFF(TIMESTAMP(\`Start\`), TIMESTAMP(\`Submit\`), SECOND)
               ELSE NULL END) AS avg_wait_seconds
       FROM jobs WHERE ${dc}
       GROUP BY \`Partition\` ORDER BY job_count DESC`,
      ck,
    ),
    runQuery(
      `WITH ${DEDUP_CTE}
       SELECT DISTINCT \`NodeList\` AS nl
       FROM jobs WHERE ${dc} AND \`NodeList\` IS NOT NULL`,
      `${ck}_nodes`,
    ),
  ]);

  const allNodes = new Set();
  for (const r of nodelistRows) {
    for (const n of expandNodelist(r.nl || "")) allNodes.add(n);
  }

  return {
    cpu_by_partition: partitionRows,
    partitions: Object.fromEntries(
      partitionRows.map((r) => [r.Partition, r.job_count]),
    ),
    nodes_used: allNodes.size,
  };
}

export async function getUserSummaries(start, end, { partition } = {}) {
  const conditions = [dateClause(start, end)];
  if (partition) conditions.push(`\`Partition\` = '${partition}'`);
  const where = conditions.join(" AND ");
  const ck = `users_${start}_${end}_${partition}`;

  return runQuery(
    `WITH ${DEDUP_CTE}
     SELECT
         \`User\`,
         COUNT(*) AS job_count,
         SUM(\`NCPUS\`) AS total_cpus,
         SUM(\`ElapsedRaw\`) AS total_elapsed,
         SUM(CAST(\`NCPUS\` AS FLOAT64) * \`ElapsedRaw\`) / 3600 AS cpu_hours,
         SUM(CASE WHEN \`Start\` IS NOT NULL AND \`Start\` > \`Submit\`
             THEN TIMESTAMP_DIFF(TIMESTAMP(\`Start\`), TIMESTAMP(\`Submit\`), SECOND)
             ELSE 0 END) / 3600.0 AS total_wait_hours
     FROM jobs WHERE ${where}
     GROUP BY \`User\` ORDER BY cpu_hours DESC`,
    ck,
  );
}

export async function getWaitTimes(start, end, filters = {}) {
  const conditions = [dateClause(start, end)];
  conditions.push("`Start` IS NOT NULL");
  conditions.push("`Start` > `Submit`");
  if (filters.state) conditions.push(`\`State\` LIKE '%${filters.state}%'`);
  if (filters.user) conditions.push(`\`User\` = '${filters.user}'`);
  if (filters.partition)
    conditions.push(`\`Partition\` = '${filters.partition}'`);
  const where = conditions.join(" AND ");
  const [gran, expr] = granularity(start, end);
  const ck = `wait_${start}_${end}_${filters.state}_${filters.user}_${filters.partition}`;

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

export async function getUsersByPeriod(start, end, { partition } = {}) {
  const conditions = [dateClause(start, end)];
  if (partition) conditions.push(`\`Partition\` = '${partition}'`);
  const where = conditions.join(" AND ");
  const [gran, expr] = granularity(start, end);
  const ck = `users_period_${start}_${end}_${partition}`;

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
