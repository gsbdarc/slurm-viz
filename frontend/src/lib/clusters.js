/**
 * Cluster registry — the only place a cluster's identity lives.
 *
 * Adding a third cluster should mean adding an entry here and nothing else. Everything downstream
 * (`redivis/queries.js`, the dashboards) reads the table name, the column mapping, the dedup keys,
 * and the feature flags from this file rather than hardcoding sacct's vocabulary.
 *
 * The two clusters we have are not the same *kind* of data, which is why `features` exists:
 *
 *   Yen      `yen_sacct_dump`       sacct    job accounting — terminal states, authoritative runtime
 *   Sherlock `sherlock_squeue_dump` squeue   hourly snapshots of the live queue — neither of those
 *
 * A squeue snapshot can only ever see a job while it is still queued or running, so Sherlock's
 * runtimes are lower bounds and its jobs are never observed in a terminal state. Rather than let
 * those numbers masquerade as the Yen's, Sherlock switches off the features that would silently
 * misreport and shows `caveat` as a standing banner.
 *
 * The Sherlock column names and formats below were confirmed against the live table on 2026-08-11
 * (859,296 rows, submits from 2025-06-02 to 2026-08-10); see the notes on each field.
 */

/** `%M`-style Slurm durations: `MM:SS`, `HH:MM:SS`, or `D-HH:MM:SS`. */
function slurmDurationToSeconds(col) {
  return `(IFNULL(SAFE_CAST(REGEXP_EXTRACT(${col}, r'^(\\d+)-') AS INT64), 0) * 86400
 + CASE
     WHEN REGEXP_CONTAINS(${col}, r'^(?:\\d+-)?\\d+:\\d{2}:\\d{2}$')
       THEN SAFE_CAST(REGEXP_EXTRACT(${col}, r'(\\d+):\\d{2}:\\d{2}$') AS INT64) * 3600
          + SAFE_CAST(REGEXP_EXTRACT(${col}, r'(\\d{2}):\\d{2}$')      AS INT64) * 60
          + SAFE_CAST(REGEXP_EXTRACT(${col}, r'(\\d{2})$')             AS INT64)
     WHEN REGEXP_CONTAINS(${col}, r'^\\d+:\\d{2}$')
       THEN SAFE_CAST(REGEXP_EXTRACT(${col}, r'^(\\d+):') AS INT64) * 60
          + SAFE_CAST(REGEXP_EXTRACT(${col}, r'(\\d{2})$') AS INT64)
     ELSE 0
   END)`;
}

const SHERLOCK_ELAPSED = slurmDurationToSeconds("`TimeUsed`");

/**
 * sacct CPU-time strings (`TotalCPU`): `MM:SS.mmm` under an hour, `[D-]HH:MM:SS` above it. Unlike
 * `slurmDurationToSeconds`, the seconds field may carry a fractional part, and a short job's value
 * is *only* `MM:SS.mmm` — the parser above would read every one of those as 0.
 */
function slurmCpuTimeToSeconds(col) {
  return `(IFNULL(SAFE_CAST(REGEXP_EXTRACT(${col}, r'^(\\d+)-') AS INT64), 0) * 86400
 + CASE
     WHEN REGEXP_CONTAINS(${col}, r'^(?:\\d+-)?\\d+:\\d{2}:\\d{2}(?:\\.\\d+)?$')
       THEN SAFE_CAST(REGEXP_EXTRACT(${col}, r'(\\d+):\\d{2}:\\d{2}(?:\\.\\d+)?$') AS INT64) * 3600
          + SAFE_CAST(REGEXP_EXTRACT(${col}, r'(\\d{2}):\\d{2}(?:\\.\\d+)?$')      AS INT64) * 60
          + SAFE_CAST(REGEXP_EXTRACT(${col}, r'(\\d{2}(?:\\.\\d+)?)$')             AS FLOAT64)
     WHEN REGEXP_CONTAINS(${col}, r'^\\d+:\\d{2}(?:\\.\\d+)?$')
       THEN SAFE_CAST(REGEXP_EXTRACT(${col}, r'^(\\d+):') AS INT64) * 60
          + SAFE_CAST(REGEXP_EXTRACT(${col}, r'(\\d{2}(?:\\.\\d+)?)$') AS FLOAT64)
     ELSE NULL
   END)`;
}

const YEN_CPU_SECONDS = slurmCpuTimeToSeconds("`TotalCPU`");

export const CLUSTERS = {
  yen: {
    id: "yen",
    label: "Yen",
    title: "Yen Cluster Slurm Statistics",

    organization: "StanfordGSBSandbox",
    dataset: "slurm_stats",
    table: "yen_sacct_dump",

    // Identity mapping: the canonical names the dashboards read *are* sacct's names.
    columns: {
      jobId: "JobID",
      jobName: "JobName",
      user: "User",
      partition: "Partition",
      state: "State",
      ncpus: "NCPUS",
      reqMem: "ReqMem",
      elapsed: "ElapsedRaw",
      submit: "Submit",
      start: "Start",
      end: "End",
      nodeList: "NodeList",
      // The dump now carries `Account` and `Group`, but both are constant on the Yens (`none` and
      // `operator` for every row, per #10), so neither is a usable grouping.
      group: null,
      // Submission provenance. `sacct --format=ALL` collects both, and the exporter keeps them.
      workDir: "WorkDir",
      submitLine: "SubmitLine",
    },

    /**
     * PARTITION — keyed on (JobID, Submit), not JobID alone. The Yen's JobID counter was reset to 1
     * in January 2026, and as of August 2026 it has climbed back into the range the pre-reset data
     * still occupies (434,400–1,030,357). Keying on JobID alone would silently discard one of any
     * two genuinely different jobs that land on the same ID, and the counter has ~595k previously
     * used IDs still ahead of it. `Submit` separates them: it is fixed at submission and the two
     * eras are ~a year apart, while snapshots of a single job all share it exactly.
     *
     * ORDER — a long-running job appears many times with a growing `ElapsedRaw`. For those rows
     * `End` is NULL and `Start`/`Submit` are identical, so ordering on those three alone is a total
     * tie and ROW_NUMBER picks arbitrarily; the same job would then report wildly different runtimes
     * (and therefore costs) from one query to the next. `End DESC NULLS LAST` prefers a finished
     * record over a mid-flight snapshot, `ElapsedRaw DESC` takes the freshest snapshot of a job
     * still running, and `TO_JSON_STRING` is a final deterministic key so byte-identical duplicates
     * can't reorder either.
     *
     * The usage keys come after every field the rest of the dashboard reads, so they only break ties
     * — but those ties are common since the #10 rebuild, which folds usage onto the job row: a job's
     * snapshots can agree on every timing field yet disagree on usage.
     *
     *   `MaxRSSBytes IS NULL`   Left to `TO_JSON_STRING`, 21k jobs landed on a usage-less row.
     *   CPU time, then MaxRSS,  Not the newest snapshot: a later pull can miss a step that finished
     *   both DESC              before its `-S` window, and the fold then totals only the steps it
     *                          saw. Job 562136_1's Sep 7 snapshot is short exactly its step 0's
     *                          26:21, against live sacct. Dropping a step can only lower the totals,
     *                          so the larger snapshot is the complete one. Newest-first
     *                          under-reported CPU for 89 jobs and memory for 52.
     *
     * Verified 2026-09-22 across all 1,257,975 jobs: all 603,151 jobs with usage on any row get it,
     * every one at its maximum CPU time and all but one at its maximum MaxRSS (that job's two
     * snapshots each miss a different step), and no job's elapsed, end, state, CPUs, memory or TRES
     * changed. Spot-checked 17 jobs against `sacct` on yen5: memory exact on all, CPU exact on all.
     *
     * Not `WHERE SnapshotKind = 'daily'`, as the exporter's docs suggest for usage work: the
     * `1-year-snapshot` rows are the only copy of Aug 2024–Aug 2025 (552 of 427,227 also appear in
     * daily rows), so that filter would delete the first year from every tab.
     *
     * Known edge: 154 JobIDs have rows whose `Submit` differs (by up to 39 days) — most likely
     * requeues. These are kept as separate jobs rather than collapsed.
     */
    dedup: {
      partition: "`JobID`, `Submit`",
      order:
        "`End` DESC NULLS LAST, `ElapsedRaw` DESC NULLS LAST, " +
        "`Start` DESC NULLS LAST, `MaxRSSBytes` IS NULL, " +
        `${YEN_CPU_SECONDS} DESC NULLS LAST, \`MaxRSSBytes\` DESC, ` +
        "`SnapshotDate` DESC NULLS LAST, TO_JSON_STRING(t)",
    },

    elapsedSecondsSql: "`ElapsedRaw`",

    /**
     * Column corrections applied inside the dedup CTE, replacing the raw value in place.
     *
     * `User`: two accounts were recorded with a stray trailing `@` (`mborrero@`, `mchyip@`) on 87
     * rows submitted 2025-08-12 – 2025-11-27, in both daily and snapshot pulls. Each shares its UID
     * with the clean name (`getent passwd 432571` → mborrero), so they are one person split across
     * two dropdown entries and two sets of per-user totals. Live sacct cannot show the originals —
     * they predate the January slurmdbd wipe — so the cause is unknown; a transient name-lookup
     * glitch on the cluster fits the window. Stripping the `@` merges them; no clean username
     * contains one.
     */
    cleanColumns: { User: "RTRIM(`User`, '@')" },

    /** sacct records a job's real end state, so every panel means what it says. */
    features: {
      ec2Cost: true,
      nodeFilter: true,
      jobStates: true,
      waitTimes: true,
      memory: true,
      gpus: true,
      groups: false,
      agentDetection: true,
      usage: true,
    },

    /**
     * What a job actually consumed, as opposed to what it asked for (#10). The exporter folds every
     * step's usage onto the job row, taking the peak across steps — `.batch` alone under-reports any
     * job that `srun`s its real work.
     *
     * NULL is not zero. Usage exists only for jobs submitted on or after `since`: slurmdbd was wiped
     * at the 2026-01-21 upgrade, so older rows can never be backfilled. Running and never-started
     * jobs are NULL too.
     *
     * Memory is measured against `ReqMemBytes`, the request as typed — which agrees exactly with the
     * `ReqMem` parse behind the Memory (GB) column (0 mismatches over 677,521 rows), so the % reads
     * against the number beside it. `AllocMemBytes` would be the enforced limit; ~4k jobs peak above
     * their request but only ~10 above their allocation, because Slurm rounds the allocation up to a
     * per-core minimum. So a Mem Used over 100% is real, not a bug.
     *
     * `presentSql` is the one test for "this row has usage", and CPU must be gated on it too:
     * `TotalCPU` is not NULL on rows without usage but `00:00:00` — on all 471,842 completed pre-
     * 2026 jobs, among others — so testing it directly would report 0% CPU for all of history.
     * Where usage is present, a zero `TotalCPU` is rare (102 of 536,161 completed) and genuine.
     */
    usage: {
      presentSql: "`MaxRSSBytes` IS NOT NULL",
      since: "2026-01-22",
      memUsedBytesSql: "`MaxRSSBytes`",
      memReqBytesSql: "`ReqMemBytes`",
      cpuSecondsSql: YEN_CPU_SECONDS,

      /**
       * GPU figures come from Slurm's NVML sampling (`gres/gpuutil`, `gres/gpumem`), every
       * `JobAcctGatherFrequency` = 30s. Both are **peaks, not averages**: `TRESUsageInTot` equalled
       * `TRESUsageInMax` on all 858 GPU steps checked on 2026-09-22, so `GPUUtil` is the busiest
       * 30s sample and `GPUMemBytes` the most GPU memory held. Both are summed over the job's GPUs,
       * hence the division by GPU count downstream. Slurm records no time-averaged utilization.
       *
       * `gpuMinSeconds`: a job shorter than one sampling interval is never sampled and reads 0 —
       * 3,317 of 3,320 sub-30s GPU jobs — so below it the columns are blank, not 0%.
       *
       * `gpuModels`: the GPU memory each node gives a job, from its `GPU_MEMORY` feature
       * (`sinfo -N -p gpu -o "%N %f"`). No job's peak exceeds its node's figure (checked per node,
       * Jan 22 – Sep 21). A job spanning two models has no single denominator and is left blank.
       */
      /**
       * A resized job is split by Slurm into two records under one JobID — the pre-resize one
       * closed as RESIZING, a new one opened with a new `Submit` — so it dedups to two rows. Every
       * step, and so all the CPU time, hangs off the first; the fold copies the same MaxRSS onto
       * both. Job 629511_2: 274% CPU on its 247s RESIZING record, 0% on the 1,222s COMPLETED one,
       * 46% over the whole job, and a 23 GiB peak on both under an enforced 12G limit. No per-row
       * figure is right, so usage is blanked on every record of a resized job: 95 jobs, 5 users,
       * since 2026-07-05. Each such job still counts as two jobs everywhere else; merging each chain
       * into one (summing elapsed and CPU time, taking the larger MaxRSS) would fix that too, but
       * touches the dedup every tab relies on, for 95 of 1.26M jobs, so it has not been done.
       *
       * `withinDays` stops a pre-reset job that reused the same JobID from matching: the eras are
       * a year apart, and no job runs past the 7-day `long` partition limit.
       */
      resized: { state: "RESIZING", withinDays: 7 },

      /**
       * CPU % above this is blanked. A cancelled job's recorded elapsed stops at the cancel, but its
       * steps keep burning CPU until their processes die — seconds, normally (922 of 931 cancelled
       * jobs in a week, none by over 60s), which is enough to push a sub-minute job past 100%. Rare
       * stragglers go further: 51587_204 was cancelled at 103s while its batch step ran to 794s,
       * reading 538%. 585 jobs Jan 22 – Sep 21, 531 of them cancelled. The 5% of headroom keeps
       * ordinary accounting jitter visible rather than hiding it.
       */
      cpuMaxPct: 105,

      gpuUtilSql: "`GPUUtil`",
      gpuMemBytesSql: "`GPUMemBytes`",
      gpuMinSeconds: 30,
      gpuModels: [
        { model: "A30", memGiB: 24, nodes: ["yen-gpu1"] },
        { model: "A40", memGiB: 48, nodes: ["yen-gpu2", "yen-gpu3"] },
        { model: "H200", memGiB: 141, nodes: ["yen-gpu4"] },
      ],
    },

    /**
     * Which AI coding agent submitted a job, or NULL for one a person typed.
     *
     * Every marker is a path the agent itself creates, so a match means the sbatch/srun was issued
     * from inside an agent session rather than by hand:
     *
     *   Claude Code  /tmp/claude-<uid>/<project>/<session-uuid>/scratchpad/...   session scratch
     *                ~/.claude/jobs/<hash>/ , ~/.claude/worktrees/<branch>/      job + worktree dirs
     *   Codex        ~/.codex/worktrees/<uuid>/ , /tmp/codex...                  worktree + scratch
     *
     * Measured over 60 days of this table: 409 jobs, 14 users — 387/13 Claude Code, 22/1 Codex.
     *
     * **Patterns are anchored on purpose.** A bare `claude` substring is unusable: a faculty project
     * here keeps results under `.../structure/claude/...`, and matching it would label ordinary GMM
     * econometrics as agent work. Requiring `/tmp/claude-` + digits, or a dotted `.claude/`, excludes
     * it — verified, 0 of that project's jobs match. Same reasoning for `codex`, where a bare match
     * would catch GPU reservations named `hold-a40-codex`.
     *
     * Gemini CLI is **not** covered: it has a module on this cluster but leaves no `.gemini/` path in
     * any of 142,702 jobs. The only `gemini` hits are human-written job *names*, which is the trap
     * below. Add a marker here if that changes.
     *
     * Job names are deliberately not a marker. One user prefixes theirs `claude_*`, which finds 425
     * jobs but only that one user; the path markers find 409 across 14, overlapping by just 10. A
     * naming convention measures who adopted the convention, not who used an agent.
     *
     * Undercounts by construction: an agent that submits a script living in the project tree, with
     * no scratch path on the command line, leaves no trace. Treat this as a floor, not a census.
     */
    agentDetection: {
      columns: ["workDir", "submitLine"],
      agents: [
        { label: "claude-code", pattern: "(/tmp/claude-[0-9]+/|[.]claude/)" },
        { label: "codex", pattern: "(/tmp/codex|[.]codex/)" },
      ],
    },

    /**
     * `ReqMem` carries a unit suffix and the older per-CPU (`4Gc`) / per-node (`64Gn`) scope
     * markers; a `c` value is multiplied by NCPUS. A bare number is raw bytes.
     */
    memory: { kind: "sacctReqMem" },

    /** Resolved against the live schema — dumps vary in which TRES column they carry. */
    tresColumnCandidates: ["AllocTRES", "ReqTRES", "ReqGRES"],

    /**
     * No `sampling` key: sacct is accounting, not sampling, so runtimes are final and the
     * survivorship-bias metrics would be meaningless here. Run against this table they read 95.5%
     * "single snapshot", which is only sacct recording a finished job once.
     *
     * No `partition.multiValued` either. Three of 1,064,366 Yen rows do carry a comma partition, and
     * canonicalising token order would merge the 8 distinct labels into 6 — arguably more correct,
     * but it would move the `Partitions` headline tile and reshape the pie. Yen parity is the
     * regression contract for the Sherlock work, so that is a deliberate follow-up.
     */

    nodeList: {
      // sacct writes "None assigned" (and plain "None") for jobs that never landed on a node.
      rejectValuePattern: "^None",
      rejectNamePattern: "^\\s*$|^None",
      namePattern: "^[A-Za-z][A-Za-z0-9._-]*$",
      maxTokens: 20000,
    },

    caveat: null,
  },

  sherlock: {
    id: "sherlock",
    label: "Sherlock",
    title: "Sherlock Slurm Statistics (GSB)",

    organization: "StanfordGSBSandbox",
    dataset: "slurm_stats",
    table: "sherlock_squeue_dump",

    columns: {
      jobId: "JobID", // string; array tasks carry a `_N` suffix and count as separate jobs
      jobName: "JobName",
      user: "User",
      partition: "Partition",
      state: "State", // only RUNNING / PENDING / COMPLETING / CONFIGURING are ever observed
      ncpus: "CPUs",
      reqMem: "MinMemory",
      elapsed: "TimeUsed", // string, not seconds — see elapsedSecondsSql
      submit: "SubmitTime",
      start: "StartTime",
      // `EndTime` exists but is documented as "actual or expected". Since a squeue snapshot never
      // sees a finished job, it is *always* the scheduler's estimate — one pending job in the table
      // carries 6,539 different EndTime values as the estimate churns. Mapping it to null keeps an
      // estimate from being displayed as a fact.
      end: null,
      // `NodeList` is the assigned-nodes column and is clean: 0 of 859,296 rows start with "(".
      // The parenthesised pending reasons live in the separate `NodeListReason` column.
      nodeList: "NodeList",
      // A squeue snapshot has no submission-provenance columns, so agent detection is impossible
      // here. Mapped to null so a shared code path emits no SQL against a column Sherlock lacks.
      workDir: null,
      submitLine: null,
      // The PI group, and the dimension GSB work is actually organised by on Sherlock.
      //
      // Verified: group is a function of user — 23 groups over 91 users, and no user has ever
      // appeared under two — so aggregating by group is unambiguous and a user's group can be
      // carried alongside their row without a second grouping key. It matches `Account` except for
      // 135 jobs (group `hlustig`, account `callende`). NULL for 67,955 of 165,906 jobs, every one
      // of them submitted before ~December 2025 — see issue #6.
      group: "Group",
    },

    /**
     * PARTITION — (JobID, SubmitTime). Verified: 859,296 raw rows collapse to 165,906 jobs, exactly
     * the distinct (JobID, SubmitTime) count. JobID alone gives 147,129, so SubmitTime is doing real
     * work separating reused IDs.
     *
     * ORDER — there is **no snapshot timestamp column** in the dump, so "latest snapshot" is not
     * directly expressible. Largest observed runtime is the stand-in, and it has to be ordered on
     * the *parsed* seconds rather than the raw string: `TimeUsed` is written `MM:SS` / `HH:MM:SS` /
     * `D-HH:MM:SS`, so lexical ordering would rank '9:00' above '10:00:00'. Ties are the common case
     * (307,370 rows read '0:00'), which is exactly why `TO_JSON_STRING(t)` is required to make this
     * a total order — without it ROW_NUMBER picks arbitrarily and runtimes change between identical
     * queries, the bug that had to be fixed on the Yen side.
     *
     * Verified against the live table: the deduped row carries the maximum observed elapsed for all
     * 165,906 jobs (0 mismatches).
     */
    dedup: {
      partition: "`JobID`, `SubmitTime`",
      order: `${SHERLOCK_ELAPSED} DESC, TO_JSON_STRING(t)`,
    },

    elapsedSecondsSql: SHERLOCK_ELAPSED,

    /**
     * No EC2 cost: that model bills real elapsed time, and a last-seen runtime would understate
     * every long job without any way to say by how much. No terminal states: they are never
     * observed. If the daily transform ever starts emitting true elapsed times, flip `ec2Cost`.
     *
     * No GPUs: the dump has no TRES/GRES column at all, so GPU counts are unknowable here.
     *
     * No agent detection: that reads submission provenance out of `WorkDir` / `SubmitLine`, and a
     * squeue snapshot carries neither. This is a missing-column limit, not a policy one — if a
     * future Sherlock dump adds them, map the columns and flip the flag.
     */
    features: {
      ec2Cost: false,
      nodeFilter: true,
      agentDetection: false,
      // Only RUNNING / PENDING / COMPLETING / CONFIGURING are ever recorded, so a state breakdown
      // can only ever describe what the sampler happened to catch. Showing it invites comparisons
      // that cannot be made, so state is dropped from this cluster's UI outright.
      jobStates: false,
      waitTimes: true,
      memory: true,
      gpus: false,
      groups: true,
      // squeue reports what a job holds, never what it consumed.
      usage: false,
    },

    /**
     * The collector is a scrontab job running once an hour at :30.
     *
     * Measured rather than taken on trust: there is no snapshot timestamp column, but for a job seen
     * repeatedly the gaps between consecutive observed runtimes *are* the sampling interval — median
     * exactly 3600s, with 425,186 gaps near 60 minutes against 150 near 30.
     *
     * The presence of this key is what marks a cluster's runtimes as lower bounds and turns on the
     * sampling-bias banner. Keying that on sampling rather than on a state flag names the actual
     * cause, and stays correct for a future cluster that records states but is still sampled.
     */
    sampling: { intervalSeconds: 3600, label: "hourly" },

    /**
     * squeue lists every partition a queued job is eligible for, so `Partition` can be a comma list
     * whose order is not meaningful. Verified to be a queued-job artifact: 8,100 PENDING and 65
     * COMPLETING jobs carry a list, and zero RUNNING or CONFIGURING ones do — a job's partition is
     * not resolved until it is placed. Sorting the tokens takes 42 distinct values down to 28.
     */
    partition: { multiValued: true },

    /** squeue's `%m`: a plain size like `24G` or `6000M`, with no per-CPU/per-node scope marker. */
    memory: { kind: "plainSize" },

    tresColumnCandidates: [],

    /**
     * A PENDING job's `StartTime` is the scheduler's *estimated* start, which sits in the future and
     * churns from snapshot to snapshot. Counting it as a queue wait would produce nonsense (often
     * negative), so wait times are restricted to jobs actually observed running.
     */
    waitTimeExtraSql: "`State` NOT IN ('PENDING')",

    nodeList: {
      // Defensive: `NodeList` is clean today, but if the transform ever points at NodeListReason
      // instead, a "(Resources)" value must be dropped whole rather than split on its comma —
      // "(ReqNodeNotAvail, UnavailableNodes:sh03-01n[01-16])" would otherwise mint 16 fake nodes.
      rejectValuePattern: "^\\s*\\(|^None",
      rejectNamePattern: "^\\s*$|^None",
      namePattern: "^sh[0-9]",
      maxTokens: 20000,
    },

    caveat:
      "Sherlock data comes from hourly snapshots of the live queue (squeue), not job accounting. " +
      "A job that is submitted, runs and finishes between two snapshots is never recorded at all, " +
      "so what you see is biased toward long-waiting and long-running jobs: counts understate " +
      "throughput, while average runtimes and waits overstate it. Runtimes are the last value " +
      "observed before a job left the queue, so they are lower bounds, and there is no EC2 cost " +
      "estimate. Coverage is the sh_s-gsb group only, and CPU and memory figures are missing " +
      "entirely for jobs submitted before December 2025 (see issue #6).",
  },
};

export const DEFAULT_CLUSTER = "yen";

export function getCluster(id) {
  return CLUSTERS[id] || CLUSTERS[DEFAULT_CLUSTER];
}

export const CLUSTER_LIST = Object.values(CLUSTERS);
