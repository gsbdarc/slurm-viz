import * as redivis from "redivis";
import { ec2CostSqlExpr } from "../lib/ec2";

const CACHE_TTL = 300_000;

/**
 * Every query is scoped to a cluster (see `../lib/clusters.js`), which supplies the table, the
 * physical column names, and the dedup keys. SQL therefore refers to columns through `cols()` and
 * aliases them back to the canonical sacct-style names the dashboards read — `JobID`, `NCPUS`,
 * `ElapsedRaw` and friends — so the row shape handed to components is the same whichever cluster is
 * selected, and only this file knows the difference.
 */

/** Backticked physical column names for a cluster, keyed by logical name. */
function cols(cluster) {
  const out = {};
  for (const [logical, physical] of Object.entries(cluster.columns)) {
    out[logical] = physical ? `\`${physical}\`` : null;
  }
  return out;
}

const datasetCache = new Map();

function datasetFor(cluster) {
  if (!datasetCache.has(cluster.id)) {
    datasetCache.set(
      cluster.id,
      redivis.organization(cluster.organization).dataset(cluster.dataset),
    );
  }
  return datasetCache.get(cluster.id);
}

/**
 * Cache-key builder. Every key in this file and in the components goes through it, because a key
 * that forgets the cluster silently serves one cluster's numbers under the other's heading.
 */
export function ck(cluster, ...parts) {
  return [cluster.id, ...parts].join("_");
}

/**
 * The canonical partition, as a raw expression.
 *
 * squeue lists every partition a queued job is eligible for, so the value can be a comma list whose
 * order carries no meaning: `athey,normal` and `normal,athey` are the same request, and sorting the
 * tokens makes them one label instead of two. Gated per cluster because sacct's partition is already
 * singular, and normalising it there would move a headline number for no benefit.
 *
 * Use this only where the `jobs` CTE is not in scope — `buildWhere`, which also has to work against
 * the raw table in `getSamplingStats`. Everywhere else use `partitionRef`.
 */
function partitionExprSql(cluster) {
  const col = cols(cluster).partition;
  if (!cluster.partition?.multiValued) return col;
  return `(SELECT STRING_AGG(TRIM(p), ',' ORDER BY TRIM(p)) FROM UNNEST(SPLIT(${col}, ',')) AS p)`;
}

/** How to name the canonical partition inside the `jobs` CTE, where it is a projected column. */
function partitionRef(cluster) {
  return cluster.partition?.multiValued ? "`_partition`" : cols(cluster).partition;
}

/**
 * Collapse the dump's periodic snapshots down to one row per job.
 *
 * The partition and ordering keys are cluster-specific and carry their own rationale in
 * `clusters.js`; what is common is the shape: ROW_NUMBER over the partition, take `_rn = 1`. The
 * table alias `t` is load-bearing — both clusters' orderings end in `TO_JSON_STRING(t)` to force a
 * total order, without which ROW_NUMBER breaks ties arbitrarily and a job's reported runtime changes
 * between identical queries.
 */
function dedupCte(cluster, derivedColumns = "") {
  // Project the canonical partition once, here, rather than inlining the expression at each use.
  // BigQuery rejects a subquery in GROUP BY ("UNNEST expression references column `Partition` which
  // is neither grouped nor aggregated"), so grouping needs a plain column to point at.
  const partitionCol = cluster.partition?.multiValued
    ? `, ${partitionExprSql(cluster)} AS _partition`
    : "";

  return `jobs AS (
    SELECT *${partitionCol}${derivedColumns}
    FROM (
        SELECT *, ROW_NUMBER() OVER (
            PARTITION BY ${cluster.dedup.partition} ORDER BY ${cluster.dedup.order}
        ) AS _rn
        FROM \`${cluster.table}\` AS t
    ) WHERE _rn = 1
)`;
}

const plainCteCache = new Map();

function plainCte(cluster) {
  if (!plainCteCache.has(cluster.id)) {
    plainCteCache.set(cluster.id, dedupCte(cluster));
  }
  return plainCteCache.get(cluster.id);
}

const queryCache = new Map();

function hashKey(sql) {
  let h = 0;
  for (let i = 0; i < sql.length; i++) {
    h = ((h << 5) - h + sql.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

async function runQuery(cluster, sql, cacheKey) {
  const key = cacheKey ? `${cacheKey}_${hashKey(sql)}` : null;
  if (key && queryCache.has(key)) {
    const cached = queryCache.get(key);
    if (Date.now() - cached.fetchedAt < CACHE_TTL) return cached.result;
  }

  const rows = await datasetFor(cluster).query(sql).listRows();

  if (key) {
    queryCache.set(key, { result: rows, fetchedAt: Date.now() });
  }
  return rows;
}

/** Quote a value as a BigQuery string literal. */
function sqlString(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Interpolate a configured pattern into a BigQuery raw-string regex literal.
 *
 * The patterns come from `clusters.js`, not user input, but a stray quote would silently truncate
 * the literal and change the predicate's meaning, so reject rather than emit broken SQL.
 */
function sqlRegex(pattern) {
  if (pattern.includes("'") || pattern.includes("\\'")) {
    throw new Error(`Unsupported quote in cluster regex pattern: ${pattern}`);
  }
  return `r'${pattern}'`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function dateClause(cluster, start, end) {
  const submit = cols(cluster).submit;
  const parts = [];
  if (start) parts.push(`${submit} >= ${sqlString(start)}`);
  if (end) parts.push(`${submit} < ${sqlString(addDays(end, 1))}`);
  return parts.length ? parts.join(" AND ") : "1=1";
}

function granularity(cluster, start, end) {
  const submit = cols(cluster).submit;
  let days = 30;
  try {
    days = Math.round(
      (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24),
    );
  } catch {}
  if (days <= 14) return ["day", `DATE(${submit})`];
  if (days <= 90) return ["week", `DATE_TRUNC(${submit}, WEEK)`];
  return ["month", `DATE_TRUNC(${submit}, MONTH)`];
}

export function defaultDateRange() {
  const end = new Date().toISOString().slice(0, 10);
  const start = addDays(end, -30);
  return [start, end];
}

// ---------------------------------------------------------------------------
// Derived SQL fragments (memory, GPUs, EC2 cost)
// ---------------------------------------------------------------------------

/**
 * Requested memory -> GB.
 *
 * Two dialects. sacct writes a unit suffix and, on older versions, a per-CPU (`4Gc`) or per-node
 * (`64Gn`) scope marker: the scope letter has to be stripped before the unit is read, and `c` means
 * the value is per-CPU and must be multiplied by NCPUS to get the job's total request. A bare number
 * there is a raw byte count. squeue's `%m` is a plain size (`24G`, `6000M`) with no scope marker,
 * and a bare number means megabytes.
 */
function reqMemGbSql(cluster) {
  const c = cols(cluster);
  if (!c.reqMem) return "CAST(NULL AS FLOAT64)";

  const num = `SAFE_CAST(REGEXP_EXTRACT(${c.reqMem}, r'^\\s*([0-9]*\\.?[0-9]+)') AS FLOAT64)`;
  const unit = `UPPER(IFNULL(REGEXP_EXTRACT(${c.reqMem}, r'^\\s*[0-9]*\\.?[0-9]+\\s*([KMGTkmgt])'), ''))`;
  const perCpu = `REGEXP_CONTAINS(${c.reqMem}, r'[cC]\\s*$')`;

  const sacct = cluster.memory?.kind === "sacctReqMem";
  // No unit: sacct means bytes, squeue means megabytes.
  const bare = sacct ? "1 / (1024 * 1024 * 1024)" : "1 / 1024";
  const scope = sacct
    ? `* CASE WHEN ${perCpu} THEN GREATEST(IFNULL(${c.ncpus}, 1), 1) ELSE 1 END`
    : "";

  return `(
    CASE
        WHEN ${c.reqMem} IS NULL OR TRIM(${c.reqMem}) = '' THEN NULL
        ELSE ${num}
             * CASE ${unit}
                 WHEN 'K' THEN 1 / (1024 * 1024)
                 WHEN 'M' THEN 1 / 1024
                 WHEN 'G' THEN 1
                 WHEN 'T' THEN 1024
                 ELSE ${bare}
               END
             ${scope}
    END
)`;
}

/**
 * The TRES column holding GPU allocations, resolved once per cluster against the live schema.
 *
 * Slurm dumps vary: some have `AllocTRES`, some only `ReqTRES`, some neither. Probing one row and
 * adapting beats hardcoding a column name that makes every query fail. Keyed by cluster because a
 * single module-global slot would let whichever cluster loaded first decide for both.
 */
const tresColumnPromises = new Map();

function resolveTresColumn(cluster) {
  const candidates = cluster.tresColumnCandidates || [];
  if (!candidates.length) return Promise.resolve(null);

  if (!tresColumnPromises.has(cluster.id)) {
    const promise = runQuery(
      cluster,
      `SELECT * FROM \`${cluster.table}\` LIMIT 1`,
      ck(cluster, "schema_probe"),
    )
      .then((rows) => {
        const present = new Set(Object.keys(rows[0] || {}));
        for (const candidate of candidates) {
          if (present.has(candidate)) return candidate;
        }
        console.warn(
          "[slurm-viz] No TRES column found in " +
            cluster.table +
            "; GPU counts will be treated as 0 and GPU job costs will be understated.",
        );
        return null;
      })
      .catch((err) => {
        console.warn("[slurm-viz] Schema probe failed, assuming no TRES column:", err);
        return null;
      });
    tresColumnPromises.set(cluster.id, promise);
  }
  return tresColumnPromises.get(cluster.id);
}

/**
 * SQL fragments that depend on the resolved schema: `{ tresColumn, cte, ec2Cost }`.
 *
 * `cte` replaces the plain dedup CTE for cost queries — it projects `_mem_gb` and `_gpu_count` once
 * so the ~40-branch cost CASE can reference short column names instead of inlining the whole memory
 * parser in every branch. `ec2Cost` is null on clusters without a trustworthy elapsed time; callers
 * must omit the column rather than emit SQL that prices a lower bound as if it were a fact.
 */
async function sqlFragments(cluster) {
  const c = cols(cluster);
  const tresColumn = await resolveTresColumn(cluster);
  const gpuCount = tresColumn
    ? `IFNULL(SAFE_CAST(REGEXP_EXTRACT(\`${tresColumn}\`, r'gres/gpu[^=,]*=([0-9]+)') AS INT64), 0)`
    : "0";

  return {
    tresColumn,
    cte: dedupCte(cluster, `, ${reqMemGbSql(cluster)} AS _mem_gb, ${gpuCount} AS _gpu_count`),
    ec2Cost: cluster.features.ec2Cost
      ? ec2CostSqlExpr({
          cpuExpr: c.ncpus,
          memExpr: "`_mem_gb`",
          gpuExpr: "`_gpu_count`",
          elapsedExpr: cluster.elapsedSecondsSql,
        })
      : null,
  };
}

// ---------------------------------------------------------------------------
// Node index and filtering
// ---------------------------------------------------------------------------

/**
 * The one grammar for a node-list token, shared by the JS expander and the SQL that builds the node
 * index. A token is a name, optionally followed by a bracketed range group: `sh03-08n[27-30,32]`.
 * Keeping a single RE2-compatible pattern means the two cannot drift apart.
 */
const NODE_TOKEN_RE2 = "[^,\\[\\]]+(?:\\[[^\\]]*\\])?";

/**
 * Split a raw node-list value into tokens, or return `[]` if the value is not a node list at all.
 *
 * The whole-value check has to come first. squeue can put a pending reason in this position, and
 * `(ReqNodeNotAvail, UnavailableNodes:sh03-01n[01-16])` contains both a comma and real node names —
 * splitting before rejecting would mint sixteen machines that were never allocated.
 */
function splitNodelistTokens(raw, cfg) {
  if (!raw) return [];
  if (cfg.rejectValuePattern && new RegExp(cfg.rejectValuePattern).test(raw)) return [];
  // `sh03-[01-02]n[01-16]` would need a cross product; the single-group expander below would
  // mis-parse it. None exist in either table today (verified), so drop and count rather than guess.
  if (/\[[^\]]*\][^,]*\[/.test(raw)) {
    multiBracketDropped += 1;
    return [];
  }
  return raw.match(new RegExp(NODE_TOKEN_RE2, "g")) || [];
}

let multiBracketDropped = 0;

/** Expand one token into individual node names, dropping anything that isn't a plausible name. */
function expandNodelistToken(token, cfg) {
  const nodes = new Set();
  const trimmed = token.trim();
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

  const reject = cfg.rejectNamePattern ? new RegExp(cfg.rejectNamePattern) : null;
  const allow = cfg.namePattern ? new RegExp(cfg.namePattern) : null;
  for (const n of nodes) {
    if (n === "" || (reject && reject.test(n)) || (allow && !allow.test(n))) nodes.delete(n);
  }
  return nodes;
}

const nodeNamesCache = new Map();

/**
 * The list of node names to offer in the picker.
 *
 * This is a *discovery* aid only — filtering does not consult it (see `nodeMatchSql`), so a name
 * missing from this list still filters correctly if the user types it. That separation is what lets
 * the query group by token and cap the result: the distinct-token set is one to two orders of
 * magnitude smaller than the distinct node-*list* set, and holding the latter in a browser is what
 * would actually fall over on a large cluster.
 *
 * `ORDER BY n DESC` before the cap is deliberate: a bare LIMIT is non-deterministic, so the picker's
 * contents would reshuffle between loads and truncation would drop arbitrary nodes rather than the
 * rarest ones.
 */
export function getNodeNames(cluster, start, end, where) {
  const c = cols(cluster);
  const cfg = cluster.nodeList || {};
  const clause = where || dateClause(cluster, start, end);
  const key = ck(cluster, start, end, hashKey(clause));
  if (nodeNamesCache.has(key)) return nodeNamesCache.get(key);

  const promise = (async () => {
    if (!cluster.features.nodeFilter || !c.nodeList) {
      return { nodes: [], truncated: false, tokenCount: 0 };
    }

    const max = cfg.maxTokens || 20000;
    const reject = cfg.rejectValuePattern
      ? `AND NOT REGEXP_CONTAINS(${c.nodeList}, ${sqlRegex(cfg.rejectValuePattern)})`
      : "";

    const rows = await runQuery(
      cluster,
      `WITH ${plainCte(cluster)}
       SELECT tok, COUNT(*) AS n
       FROM jobs
       CROSS JOIN UNNEST(REGEXP_EXTRACT_ALL(${c.nodeList}, ${sqlRegex(NODE_TOKEN_RE2)})) AS tok
       WHERE ${clause} AND ${c.nodeList} IS NOT NULL AND ${c.nodeList} != '' ${reject}
       GROUP BY tok ORDER BY n DESC LIMIT ${max + 1}`,
      ck(cluster, "nodeindex", hashKey(clause)),
    );

    const truncated = rows.length > max;
    const names = new Set();
    for (const row of rows.slice(0, max)) {
      for (const node of expandNodelistToken(String(row.tok), cfg)) names.add(node);
    }

    if (multiBracketDropped) {
      console.warn(
        `[slurm-viz] Dropped ${multiBracketDropped} node-list value(s) with nested bracket groups; ` +
          "those jobs are missing from the node picker.",
      );
      multiBracketDropped = 0;
    }

    const nodes = [...names].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    );
    return { nodes, truncated, tokenCount: rows.length };
  })();

  nodeNamesCache.set(key, promise);
  return promise;
}

function escapeRe2(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match one node against a compact Slurm node list, entirely in SQL.
 *
 * A node can't be matched with `=` or `LIKE`: `LIKE '%yen-gpu4%'` also matches `yen-gpu40`, and
 * nothing matches a node hidden inside a range like `sh03-08n[27-30]`. RE2 can't compare numbers,
 * but `UNNEST(REGEXP_EXTRACT_ALL(...))` can pull out the bracket bodies and let SQL do the
 * arithmetic — so the predicate is a fixed ~600 bytes no matter how much data is behind it.
 *
 * The `LPAD` test is what makes this an exact dual of `expandNodelistToken` rather than an
 * approximation: that function pads to the *low bound's* width, so `n[5-12]` yields `n5 … n12` while
 * `n[05-12]` yields `n05 … n12`. Comparing the padded form keeps the two definitions identical.
 */
export function nodeMatchSql(col, node, rejectValuePattern) {
  // The picker accepts free text, so this is the injection guard as well as a sanity check.
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(node)) return "1=0";

  const guard = rejectValuePattern
    ? `NOT REGEXP_CONTAINS(${col}, ${sqlRegex(rejectValuePattern)}) AND `
    : "";
  const exact = `REGEXP_CONTAINS(${col}, r'(?:^|,)${escapeRe2(node)}(?:$|,)')`;

  const m = node.match(/^(.*?)(\d+)$/);
  if (!m) return `(${guard}${exact})`;

  const [, prefix, digits] = m;
  const num = parseInt(digits, 10);
  const lo = `SPLIT(_item, '-')[OFFSET(0)]`;
  const hi = `SPLIT(_item, '-')[OFFSET(1)]`;

  return `(${guard}(${exact} OR EXISTS (
    SELECT 1
    FROM UNNEST(REGEXP_EXTRACT_ALL(${col}, r'(?:^|,)${escapeRe2(prefix)}\\[([^\\]]*)\\]')) AS _body
    CROSS JOIN UNNEST(SPLIT(_body, ',')) AS _item
    WHERE _item = ${sqlString(digits)}
       OR (REGEXP_CONTAINS(_item, r'^[0-9]+-[0-9]+$')
           AND SAFE_CAST(${lo} AS INT64) <= ${num}
           AND SAFE_CAST(${hi} AS INT64) >= ${num}
           AND ${sqlString(digits)} = LPAD(CAST(${num} AS STRING), LENGTH(${lo}), '0'))
  )))`;
}

/** Rows where the job genuinely waited, i.e. where `Start` is a fact rather than a forecast. */
/**
 * Which agent submitted a job, as a STRING expression, or NULL when nothing matched.
 *
 * Reads submission provenance (`WorkDir`, `SubmitLine`) against the per-agent path patterns in
 * `clusters.agentDetection`. Returns `null` for a cluster without the feature so callers can drop
 * the column entirely rather than emit SQL against a table that lacks those columns — Sherlock's
 * squeue dump has neither.
 *
 * Agents are tested in declaration order and the first match wins; the patterns are disjoint in
 * practice, and a CASE keeps one job from being counted under two agents if that ever stops being
 * true.
 *
 * Each source column is tested separately and OR'd, rather than concatenated and tested once: a
 * CONCAT can manufacture a match that spans the join, where one column happens to end `/tmp/claude-`
 * and the next begins with digits. Each is wrapped in IFNULL because `REGEXP_CONTAINS(NULL, ...)` is
 * NULL rather than false, and a NULL disjunct would mask a real match on the other column.
 */
function agentSql(cluster) {
  const cfg = cluster.agentDetection;
  if (!cluster.features?.agentDetection || !cfg) return null;
  const c = cols(cluster);
  const sources = cfg.columns.map((k) => c[k]).filter(Boolean);
  if (!sources.length) return null;
  const whens = cfg.agents
    .map((a) => {
      const test = sources
        .map((col) => `REGEXP_CONTAINS(IFNULL(${col}, ''), ${sqlRegex(a.pattern)})`)
        .join(" OR ");
      return `WHEN ${test} THEN ${sqlString(a.label)}`;
    })
    .join("\n              ");
  return `CASE ${whens}\n              ELSE NULL END`;
}

function waitCondSql(cluster) {
  const c = cols(cluster);
  const parts = [`${c.start} IS NOT NULL`, `${c.start} > ${c.submit}`];
  if (cluster.waitTimeExtraSql) parts.push(cluster.waitTimeExtraSql);
  return parts.join(" AND ");
}

function waitSecondsSql(cluster) {
  const c = cols(cluster);
  return `CASE WHEN ${waitCondSql(cluster)}
              THEN TIMESTAMP_DIFF(TIMESTAMP(${c.start}), TIMESTAMP(${c.submit}), SECOND)
              ELSE NULL END`;
}

/**
 * Build a WHERE clause for the given date range and filters.
 *
 * Still async so call sites keep their `Promise.all` shape, though nothing here awaits any more —
 * the node predicate is derived from the node name alone.
 */
async function buildWhere(cluster, start, end, filters = {}, extra = []) {
  const c = cols(cluster);
  const { state, user, partition, node, group } = filters;
  const conditions = [dateClause(cluster, start, end), ...extra];
  if (state && cluster.features.jobStates) {
    conditions.push(`${c.state} LIKE ${sqlString(`%${state}%`)}`);
  }
  if (user) conditions.push(`${c.user} = ${sqlString(user)}`);
  // Matches the canonical form, so the dropdown and the filter agree. Note this is exact rather than
  // membership: filtering `gsb` does not match the queued job that asked for `gsb,normal`.
  if (partition) conditions.push(`${partitionExprSql(cluster)} = ${sqlString(partition)}`);
  if (node && cluster.features.nodeFilter && c.nodeList) {
    conditions.push(nodeMatchSql(c.nodeList, node, cluster.nodeList?.rejectValuePattern));
  }
  // The `c.group` guard keeps a stale selection from emitting SQL against a column Yen lacks.
  if (group && c.group) conditions.push(`${c.group} = ${sqlString(group)}`);
  // Same guard shape: `agentSql` returns null on a cluster without provenance columns, so a stale
  // toggle carried over from the Yen tab emits nothing rather than failing against Sherlock.
  if (filters.agentOnly) {
    const agent = agentSql(cluster);
    if (agent) conditions.push(`(${agent}) IS NOT NULL`);
  }
  return conditions.join(" AND ");
}

/** Stable cache-key fragment for a filter set. */
function filterKey(filters = {}) {
  return [
    filters.state,
    filters.user,
    filters.partition,
    filters.node,
    filters.group,
    filters.agentOnly ? "agent" : "",
  ]
    .map((v) => v || "")
    .join("|");
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Options for the filter controls, narrowed by whichever global filters are already active.
 *
 * Each list is scoped by the *other* filters but never by itself, the usual faceted-search rule:
 * with a group selected, the user and partition lists should offer only that group's users and
 * partitions, matching the Unique Users and Partitions tiles.
 *
 * The **group list is deliberately never narrowed**. It feeds a plain `<select>`, so if it listed
 * only the group already chosen there would be no way to switch away. The node list is narrowed by
 * group, which is safe for the opposite reason: its control is a free-text combobox, and filtering
 * matches a typed name whether or not the list offers it.
 *
 * Only the global filters (`group`, `node`) participate. The per-tab state/user/partition controls
 * are left out on purpose, so the lists do not shift underfoot as they are used and all four tabs
 * keep sharing one cached result.
 */
export async function getFilterOptions(cluster, start, end, filters = {}) {
  const c = cols(cluster);
  const { group, node } = filters;
  const dc = dateClause(cluster, start, end);
  const base = ck(cluster, "filters", start, end, group || "", node || "");
  const cte = plainCte(cluster);
  const part = partitionRef(cluster);

  const [context, groupScoped] = await Promise.all([
    buildWhere(cluster, start, end, { group, node }),
    buildWhere(cluster, start, end, { group }),
  ]);

  const [users, partitions, states, groups, nodeNames] = await Promise.all([
    runQuery(
      cluster,
      `WITH ${cte}
       SELECT DISTINCT ${c.user} AS val FROM jobs
       WHERE ${context} AND ${c.user} IS NOT NULL ORDER BY val`,
      `${base}_users`,
    ),
    runQuery(
      cluster,
      `WITH ${cte}
       SELECT DISTINCT ${part} AS val FROM jobs
       WHERE ${context} AND ${c.partition} IS NOT NULL ORDER BY val`,
      `${base}_partitions`,
    ),
    cluster.features.jobStates
      ? runQuery(
          cluster,
          `WITH ${cte}
       SELECT DISTINCT
           CASE
               WHEN ${c.state} IS NULL THEN 'UNKNOWN'
               WHEN ${c.state} LIKE 'CANCELLED%' THEN 'CANCELLED'
               ELSE ${c.state}
           END AS val
       FROM jobs WHERE ${context} ORDER BY val`,
          `${base}_states`,
        )
      : Promise.resolve([]),
    c.group
      ? runQuery(
          cluster,
          `WITH ${cte}
       SELECT DISTINCT ${c.group} AS val FROM jobs
       WHERE ${dc} AND ${c.group} IS NOT NULL ORDER BY val`,
          ck(cluster, "filters", start, end, "groups"),
        )
      : Promise.resolve([]),
    getNodeNames(cluster, start, end, groupScoped),
  ]);

  return {
    users: users.map((r) => r.val),
    partitions: partitions.map((r) => r.val),
    states: states.map((r) => r.val),
    groups: groups.map((r) => r.val),
    nodes: nodeNames.nodes,
    nodesTruncated: nodeNames.truncated,
  };
}

export async function getSummary(cluster, start, end, filters = {}) {
  const c = cols(cluster);
  const [where, frag] = await Promise.all([
    buildWhere(cluster, start, end, filters),
    sqlFragments(cluster),
  ]);
  const key = ck(cluster, "summary", start, end, filterKey(filters));

  const selects = [
    "COUNT(*) AS total_jobs",
    `COUNT(DISTINCT ${c.user}) AS unique_users`,
    `COUNT(DISTINCT ${partitionRef(cluster)}) AS unique_partitions`,
  ];
  if (frag.ec2Cost) selects.push(`SUM(${frag.ec2Cost}) AS total_ec2_cost_usd`);
  // A cluster that never observes a job's final state has no state breakdown worth counting.
  if (cluster.features.jobStates) {
    selects.push(
      `COUNTIF(${c.state} = 'COMPLETED') AS completed`,
      `COUNTIF(${c.state} = 'FAILED') AS failed`,
      `COUNTIF(${c.state} LIKE 'CANCELLED%') AS cancelled`,
      `COUNTIF(${c.state} = 'RUNNING') AS running`,
      `COUNTIF(${c.state} = 'PENDING') AS pending`,
      `COUNTIF(${c.state} = 'TIMEOUT') AS timeout`,
      `COUNTIF(${c.state} = 'OUT_OF_MEMORY') AS out_of_memory`,
      `COUNTIF(${c.state} = 'NODE_FAIL') AS node_fail`,
    );
  }

  const rows = await runQuery(
    cluster,
    `WITH ${frag.cte}
     SELECT ${selects.join(",\n         ")}
     FROM jobs WHERE ${where}`,
    key,
  );

  const r = rows[0] || {};
  let stateCounts = null;
  if (cluster.features.jobStates) {
    stateCounts = {};
    for (const stateKey of [
      "completed",
      "failed",
      "cancelled",
      "running",
      "pending",
      "timeout",
      "out_of_memory",
      "node_fail",
    ]) {
      const val = r[stateKey] || 0;
      if (val) stateCounts[stateKey.toUpperCase().replace(/_/g, " ")] = val;
    }
  }

  return {
    total_jobs: r.total_jobs || 0,
    unique_users: r.unique_users || 0,
    unique_partitions: r.unique_partitions || 0,
    total_ec2_cost_usd: frag.ec2Cost ? r.total_ec2_cost_usd || 0 : null,
    state_counts: stateCounts,
  };
}

export async function getTimeline(cluster, start, end, filters = {}) {
  const where = await buildWhere(cluster, start, end, filters);
  const [gran, expr] = granularity(cluster, start, end);
  const key = ck(cluster, "timeline", start, end, filterKey(filters));

  const rows = await runQuery(
    cluster,
    `WITH ${plainCte(cluster)}
     SELECT ${expr} AS period, COUNT(*) AS count
     FROM jobs WHERE ${where}
     GROUP BY period ORDER BY period`,
    key,
  );

  return { granularity: gran, data: rows };
}

export async function getJobs(cluster, start, end, filters = {}) {
  const c = cols(cluster);
  const [where, frag] = await Promise.all([
    buildWhere(cluster, start, end, filters),
    sqlFragments(cluster),
  ]);
  const fk = ck(cluster, "jobs", start, end, filterKey(filters));

  const costTotal = frag.ec2Cost
    ? `, SUM(${frag.ec2Cost}) AS total_ec2_cost_usd`
    : "";

  // Null on clusters without provenance columns, in which case the column is omitted from the
  // SELECT entirely and the dashboard's `agent` guard hides the UI.
  const agent = agentSql(cluster);
  const agentSelect = agent ? `${agent} AS \`Agent\`,` : "";

  const [countRows, rows] = await Promise.all([
    runQuery(
      cluster,
      `WITH ${frag.cte}
       SELECT COUNT(*) AS total${costTotal}
       FROM jobs WHERE ${where}`,
      `cnt_${fk}`,
    ),
    runQuery(
      cluster,
      `WITH ${frag.cte}
       SELECT ${c.jobId} AS \`JobID\`,
              ${c.jobName} AS \`JobName\`,
              ${c.user} AS \`User\`,
              ${partitionRef(cluster)} AS \`Partition\`,
              ${cluster.features.jobStates ? `${c.state} AS \`State\`,` : ""}
              ${c.ncpus} AS \`NCPUS\`,
              ${cluster.elapsedSecondsSql} AS \`ElapsedRaw\`,
              ${c.submit} AS \`Submit\`,
              ${c.start} AS \`Start\`,
              ${c.end || "CAST(NULL AS STRING)"} AS \`End\`,
              ${c.nodeList} AS \`NodeList\`,
              ${agentSelect}
              \`_mem_gb\` AS ReqMem_GB,
              \`_gpu_count\` AS gpu_count,
              ${waitSecondsSql(cluster)} AS wait_seconds
       FROM jobs WHERE ${where}
       ORDER BY ${c.submit} DESC, ${c.jobId} DESC LIMIT 500`,
      `rows_${fk}`,
    ),
  ]);

  return {
    jobs: rows,
    total: countRows[0]?.total || 0,
    total_ec2_cost_usd: frag.ec2Cost ? countRows[0]?.total_ec2_cost_usd || 0 : null,
  };
}

export async function getClusterUtilization(cluster, start, end, filters = {}) {
  const c = cols(cluster);
  const [where, frag] = await Promise.all([
    buildWhere(cluster, start, end, filters),
    sqlFragments(cluster),
  ]);
  const key = ck(cluster, "cluster", start, end, filterKey(filters));

  const costCol = frag.ec2Cost ? `, SUM(${frag.ec2Cost}) AS ec2_cost_usd` : "";

  const [partitionRows, nodeNames] = await Promise.all([
    runQuery(
      cluster,
      `WITH ${frag.cte}
       SELECT
           ${partitionRef(cluster)} AS \`Partition\`,
           COUNT(*) AS job_count,
           SUM(${c.ncpus}) AS total_cpus,
           AVG(${c.ncpus}) AS avg_cpus_per_job,
           AVG(\`_mem_gb\`) AS avg_mem_gb,
           AVG(${cluster.elapsedSecondsSql}) AS avg_elapsed_seconds,
           AVG(${waitSecondsSql(cluster)}) AS avg_wait_seconds${costCol}
       FROM jobs WHERE ${where}
       GROUP BY ${partitionRef(cluster)} ORDER BY job_count DESC`,
      key,
    ),
    getNodeNames(cluster, start, end, where),
  ]);

  return {
    cpu_by_partition: partitionRows,
    partitions: Object.fromEntries(
      partitionRows.map((r) => [r.Partition, r.job_count]),
    ),
    nodes_used: nodeNames.nodes.length,
    nodes_truncated: nodeNames.truncated,
  };
}

export async function getUserSummaries(cluster, start, end, filters = {}) {
  const c = cols(cluster);
  const [where, frag] = await Promise.all([
    buildWhere(cluster, start, end, filters),
    sqlFragments(cluster),
  ]);
  const key = ck(cluster, "users", start, end, filterKey(filters));
  const elapsed = cluster.elapsedSecondsSql;

  const costCol = frag.ec2Cost ? `SUM(${frag.ec2Cost}) AS ec2_cost_usd,` : "";

  // `MAX`, not a second GROUP BY key. Grouping on (user, group) looks safe because group is a
  // function of user, but it isn't in the presence of NULLs: a user with jobs either side of the
  // December 2025 boundary would split into two rows and be counted twice in the table and the
  // top-10 charts. MAX ignores NULLs, so it yields one row per user and back-fills the group over
  // the era that lacks it — correct precisely because group is a function of user. ANY_VALUE would
  // not do: it is free to return the NULL.
  const groupCol = c.group ? `MAX(${c.group}) AS \`Group\`,` : "";

  return runQuery(
    cluster,
    `WITH ${frag.cte}
     SELECT
         ${c.user} AS \`User\`,
         ${groupCol}
         COUNT(*) AS job_count,
         SUM(${c.ncpus}) AS total_cpus,
         SUM(${elapsed}) AS total_elapsed,
         SUM(CAST(${c.ncpus} AS FLOAT64) * ${elapsed}) / 3600 AS cpu_hours,
         ${costCol}
         SUM(IFNULL(${waitSecondsSql(cluster)}, 0)) / 3600.0 AS total_wait_hours
     FROM jobs WHERE ${where}
     GROUP BY ${c.user} ORDER BY cpu_hours DESC`,
    key,
  );
}

/**
 * Per-group aggregates. Empty on clusters with no group column, without emitting SQL.
 *
 * `GROUP` is a BigQuery reserved word: `cols()` hands it back already backticked and the output
 * alias is written explicitly, but the GROUP BY must name the *expression*, never the alias — the
 * same trap `Partition` sprang earlier.
 */
export async function getGroupSummaries(cluster, start, end, filters = {}) {
  const c = cols(cluster);
  if (!c.group) return [];

  const [where, frag] = await Promise.all([
    buildWhere(cluster, start, end, filters),
    sqlFragments(cluster),
  ]);
  const key = ck(cluster, "groups", start, end, filterKey(filters));
  const elapsed = cluster.elapsedSecondsSql;
  const costCol = frag.ec2Cost ? `SUM(${frag.ec2Cost}) AS ec2_cost_usd,` : "";

  // No total_elapsed: summing observed runtimes across a whole group is a number with no
  // interpretation, especially where those runtimes are lower bounds.
  return runQuery(
    cluster,
    `WITH ${frag.cte}
     SELECT
         ${c.group} AS \`Group\`,
         COUNT(*) AS job_count,
         COUNT(DISTINCT ${c.user}) AS user_count,
         SUM(${c.ncpus}) AS total_cpus,
         SUM(CAST(${c.ncpus} AS FLOAT64) * ${elapsed}) / 3600 AS cpu_hours,
         ${costCol}
         SUM(IFNULL(${waitSecondsSql(cluster)}, 0)) / 3600.0 AS total_wait_hours
     FROM jobs WHERE ${where}
     GROUP BY ${c.group} ORDER BY cpu_hours DESC`,
    key,
  );
}

/**
 * How much of the record the sampler actually caught.
 *
 * Only meaningful where the source is periodic snapshots of a live queue: a job that is submitted,
 * runs and finishes between two samples leaves no trace at all, so the visible population is biased
 * toward jobs that waited or ran long enough to be caught. These two figures put a number on that.
 *
 * Runs against the **raw** table rather than the dedup CTE, because the snapshot count per job is
 * exactly what dedup collapses away. That is sound because every condition `buildWhere` emits names
 * a physical column, and `MAX(elapsed)` over the dedup keys equals the deduped row's elapsed —
 * verified across all 165,906 Sherlock jobs. Reusing `dedup.partition` for both the projection and
 * the grouping makes `jobs` equal the deduped job count by construction.
 */
export async function getSamplingStats(cluster, start, end, filters = {}) {
  if (!cluster.sampling) return null;

  const where = await buildWhere(cluster, start, end, filters);
  const key = ck(cluster, "sampling", start, end, filterKey(filters));

  const rows = await runQuery(
    cluster,
    `WITH per_job AS (
       SELECT ${cluster.dedup.partition},
              COUNT(*) AS snaps,
              MAX(${cluster.elapsedSecondsSql}) AS max_elapsed
       FROM \`${cluster.table}\`
       WHERE ${where}
       GROUP BY ${cluster.dedup.partition}
     )
     SELECT COUNT(*) AS jobs,
            COUNTIF(max_elapsed = 0) AS never_ran,
            COUNTIF(snaps = 1) AS single_snapshot
     FROM per_job`,
    key,
  );

  const r = rows[0] || {};
  return {
    jobs: r.jobs || 0,
    never_ran: r.never_ran || 0,
    single_snapshot: r.single_snapshot || 0,
  };
}

export async function getWaitTimes(cluster, start, end, filters = {}) {
  const c = cols(cluster);
  const where = await buildWhere(cluster, start, end, filters, [waitCondSql(cluster)]);
  const [gran, expr] = granularity(cluster, start, end);
  const key = ck(cluster, "wait", start, end, filterKey(filters));
  const diff = `TIMESTAMP_DIFF(TIMESTAMP(${c.start}), TIMESTAMP(${c.submit}), SECOND)`;

  const rows = await runQuery(
    cluster,
    `WITH ${plainCte(cluster)}
     SELECT
         ${expr} AS period,
         AVG(${diff}) / 60.0 AS avg_wait_minutes,
         APPROX_QUANTILES(${diff} / 60.0, 100)[OFFSET(50)] AS median_wait_minutes,
         MAX(${diff}) / 60.0 AS max_wait_minutes
     FROM jobs WHERE ${where}
     GROUP BY period ORDER BY period`,
    key,
  );

  return { granularity: gran, data: rows };
}

/**
 * One row per agent: job count, distinct users, CPU hours, and first/last submission.
 *
 * Jobs with no agent marker are grouped under a NULL agent and returned alongside the rest, so the
 * dashboard can show agent work as a *share* of the range rather than an unanchored count. Callers
 * split the NULL row out; keeping it in one query keeps the two numbers consistent.
 */
export async function getAgentSummaries(cluster, start, end, filters = {}) {
  const c = cols(cluster);
  const agent = agentSql(cluster);
  if (!agent) return [];
  const [where, frag] = await Promise.all([
    buildWhere(cluster, start, end, filters),
    sqlFragments(cluster),
  ]);
  const cost = frag.ec2Cost ? `, SUM(${frag.ec2Cost}) AS ec2_cost_usd` : "";

  return runQuery(
    cluster,
    `WITH ${frag.cte}
     SELECT ${agent} AS agent,
            COUNT(*) AS job_count,
            COUNT(DISTINCT ${c.user}) AS unique_users,
            SUM(${c.ncpus} * ${cluster.elapsedSecondsSql}) / 3600.0 AS cpu_hours,
            MIN(${c.submit}) AS first_submit,
            MAX(${c.submit}) AS last_submit${cost}
     FROM jobs WHERE ${where}
     GROUP BY agent ORDER BY job_count DESC`,
    ck(cluster, "agent_summaries", start, end, filterKey(filters)),
  );
}

/**
 * Agent jobs and distinct agent users per period — the trend series.
 *
 * Only rows with an agent are returned; a NULL-agent bucket would dwarf every agent series on the
 * same axis and make the trend unreadable. The share-of-total figure comes from
 * `getAgentSummaries`, which does keep the NULL row.
 */
export async function getAgentsByPeriod(cluster, start, end, filters = {}) {
  const c = cols(cluster);
  const agent = agentSql(cluster);
  if (!agent) return { granularity: "month", data: [] };
  const where = await buildWhere(cluster, start, end, filters);
  const [gran, expr] = granularity(cluster, start, end);

  const rows = await runQuery(
    cluster,
    `WITH ${plainCte(cluster)}
     SELECT ${expr} AS period,
            ${agent} AS agent,
            COUNT(*) AS job_count,
            COUNT(DISTINCT ${c.user}) AS unique_users
     FROM jobs
     WHERE ${where} AND (${agent}) IS NOT NULL
     GROUP BY period, agent ORDER BY period`,
    ck(cluster, "agents_period", start, end, filterKey(filters)),
  );

  return { granularity: gran, data: rows };
}

/**
 * Per-user agent usage: which agents a user submits with, and how much.
 *
 * Restricted to agent-submitted jobs — a user's non-agent work is already the Users tab's job.
 */
export async function getAgentUsers(cluster, start, end, filters = {}) {
  const c = cols(cluster);
  const agent = agentSql(cluster);
  if (!agent) return [];
  const where = await buildWhere(cluster, start, end, filters);

  return runQuery(
    cluster,
    `WITH ${plainCte(cluster)}
     SELECT ${c.user} AS \`User\`,
            ${agent} AS agent,
            COUNT(*) AS job_count,
            SUM(${c.ncpus} * ${cluster.elapsedSecondsSql}) / 3600.0 AS cpu_hours,
            MAX(${c.submit}) AS last_submit
     FROM jobs
     WHERE ${where} AND (${agent}) IS NOT NULL
     GROUP BY \`User\`, agent ORDER BY job_count DESC`,
    ck(cluster, "agent_users", start, end, filterKey(filters)),
  );
}

export async function getUsersByPeriod(cluster, start, end, filters = {}) {
  const c = cols(cluster);
  const where = await buildWhere(cluster, start, end, filters);
  const [gran, expr] = granularity(cluster, start, end);
  const key = ck(cluster, "users_period", start, end, filterKey(filters));

  const rows = await runQuery(
    cluster,
    `WITH ${plainCte(cluster)}
     SELECT
         ${expr} AS period,
         ${partitionRef(cluster)} AS \`Partition\`,
         COUNT(DISTINCT ${c.user}) AS unique_users
     FROM jobs WHERE ${where}
     GROUP BY period, ${partitionRef(cluster)} ORDER BY period`,
    key,
  );

  return { granularity: gran, data: rows };
}
