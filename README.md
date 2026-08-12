# GSB Slurm Statistics

Web dashboard for visualizing Slurm cluster job data on Stanford GSB's **Yen** servers and on
**Sherlock**, powered by [Redivis](https://redivis.com). A toggle in the header switches the whole
dashboard between the two clusters.

**Live site:** https://gsbdarc.github.io/slurm-viz/

## Features

- **Jobs** — browse, filter, and sort job records; view submission timelines and queue wait times
- **Cluster** — partition utilization, CPU usage, and node counts
- **Users** — top users by CPU hours, job count, and EC2 cost; usage over time
- **Groups** — top PI groups by CPU hours and job count (Sherlock only — see below)
- **EC2 equivalent cost** — every job priced as the cheapest EC2 instance that fits its requested
  CPU / RAM / GPU, billed for elapsed time (Yen only — see below)
- Date range presets (7d / 30d / 90d / 1y) and custom date selection
- Filter by node (e.g. `yen-gpu4`, `sh03-08n27`) and by group across all tabs, plus partition, user,
  and job state

Panels are driven by per-cluster feature flags in
[`frontend/src/lib/clusters.js`](frontend/src/lib/clusters.js), which is the single place a
cluster's table, column names, dedup keys, and capabilities are declared. Adding a third cluster
should mean adding an entry there and nothing else.

## EC2 cost estimates

Shown for **Yen only.** The model bills a job's real elapsed time, which Sherlock's queue snapshots
cannot supply; see "What Sherlock does not support" below.

Costs are an **estimate for comparison, not a quote.** Each job is matched to the cheapest instance
in a hardcoded catalog (`c6i` / `m6i` / `r6i` / `x2idn` / `g5` / `p4d` / `p5`) that satisfies its
`NCPUS`, `ReqMem`, and GPU count from `AllocTRES`, then charged that instance's full on-demand rate
for the job's elapsed time with AWS's 60-second minimum. GPU jobs are only matched to GPU instances.

The figure **excludes** storage, data transfer, networking, and idle capacity, and assumes perfect
bin-packing of one job per instance with no reserved-capacity or savings-plan discounts.

Prices are **hardcoded** in [`frontend/src/lib/ec2.js`](frontend/src/lib/ec2.js) — on-demand Linux,
us-west-2 — with a `PRICING_AS_OF` date. They do not update themselves; re-check them against
[AWS on-demand pricing](https://aws.amazon.com/ec2/pricing/on-demand/) periodically and bump the
date. That file is the single source of truth: the job table prices rows in JS and the SQL
aggregates use a `CASE` generated from the same catalog, so the two cannot drift.

## Authentication

All data access runs in the browser via the [redivis-js](https://www.npmjs.com/package/redivis) library. Each user authenticates independently through a Redivis OAuth popup — no backend or shared credentials.

## Development

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

## Deployment

Build and deploy to GitHub Pages:

```bash
cd frontend
npm run build
npx gh-pages -d dist
```

## Data sources

Both tables live in
[`StanfordGSBSandbox/slurm_stats`](https://redivis.com/StanfordGSBSandbox/datasets/slurm_stats) on
Redivis.

| | Yen (`yen_sacct_dump`) | Sherlock (`sherlock_squeue_dump`) |
|---|---|---|
| Source | `sacct` — job *accounting* | `squeue` — hourly snapshot of the *live queue* |
| Rows per job | many snapshots | many snapshots |
| Terminal states | `COMPLETED` / `FAILED` / `TIMEOUT` … | **never observed** |
| Elapsed time | `ElapsedRaw`, final and authoritative | last-seen runtime — a **lower bound** |
| Scope | whole cluster | the `sh_s-gsb` group only |
| PI group | not recorded | `Group`, a clean hierarchy over users |

Both dumps record a job many times, so every query first collapses them to one row per job with a
`ROW_NUMBER()` CTE. The partition and ordering keys differ per cluster and carry their reasoning in
`clusters.js`; both end in `TO_JSON_STRING(t)` to force a **total order**, without which
`ROW_NUMBER` breaks ties arbitrarily and a job's reported runtime changes between identical queries.

### What Sherlock does not support, and why

`squeue` only ever sees a job while it is still queued or running — a job leaves the queue the
moment it ends. Everything below follows from that, so Sherlock deliberately shows a reduced
dashboard rather than a broken imitation of the Yen one:

- **No EC2 cost.** That model bills real elapsed time. The last runtime observed before a job left
  the queue understates every long job, with no way to say by how much.
- **No job state at all.** Only `RUNNING`, `PENDING`, `COMPLETING` and `CONFIGURING` are ever
  recorded, so a state breakdown describes when the snapshot fired rather than how the work went.
  The state tiles, the "Jobs by State" chart, the state filter and the per-job State column are all
  hidden here rather than inviting a comparison that cannot be made.
- **Every statistic is survivorship-biased.** This is the big one. The collector runs *hourly*, so a
  job submitted, run and finished between two snapshots is never recorded at all. What survives into
  the data skews toward jobs that waited or ran long enough to be caught: counts understate
  throughput, while average runtimes and waits overstate it. The caveat banner quantifies this for
  whatever range and filters are on screen — over the last 30 days, 62% of jobs were seen in only one
  snapshot and 25% were never observed running.

  The hourly figure is measured, not assumed. There is no snapshot timestamp column, but for a job
  seen repeatedly the gaps between consecutive observed runtimes *are* the sampling interval: the
  median is exactly 3600 s, with 425,186 gaps near 60 minutes against 150 near 30.
- **A queued job's partition is a list, not a value.** squeue names every partition the job is
  eligible for, so `Partition` can read `gsb,maggiori,normal,owners`; it resolves to one only once
  the job is placed. Verified as a queued-job artifact: 8,100 `PENDING` and 65 `COMPLETING` jobs
  carry a list, and no `RUNNING` or `CONFIGURING` job does. The dashboard sorts the tokens so
  `athey,normal` and `normal,athey` stop being two labels for one request, which takes 42 distinct
  values down to 28. Note the filter is still an exact match on that canonical value, so filtering
  `gsb` does **not** match the queued job that asked for `gsb,normal`.
- **Runtimes are lower bounds.** `TimeUsed` is the last value seen, in `MM:SS` / `HH:MM:SS` /
  `D-HH:MM:SS` form. There is no snapshot timestamp column, so "the latest snapshot" is expressed as
  "the largest observed runtime" — ordered on the *parsed* seconds, since lexically `9:00` would
  outrank `10:00:00`.
- **No GPU counts.** The dump carries no TRES/GRES column at all.
- **No end time.** `EndTime` exists but is always the scheduler's estimate, since no finished job is
  ever seen; one pending job carries 6,539 different values as the estimate churns. It is not shown.
- **Queue waits exclude pending jobs**, whose `StartTime` is a forecast rather than a fact.
- **CPU and memory are missing before December 2025** — see
  [issue #6](https://github.com/gsbdarc/slurm-viz/issues/6).

### Groups (Sherlock only)

Sherlock work is organised by PI group, so the dump's `Group` column gets a tab of its own and a
filter in the shared bar that narrows every other tab.

Group is a clean hierarchy over users — 23 groups across 91 users, and no user has ever appeared
under two — so aggregating by group is unambiguous, and each user's group can be shown on the Users
tab without a second grouping key. It matches `Account` except for 135 jobs.

Jobs with no group recorded are kept in the table as `(no group recorded)`, so its totals still
reconcile against the summary cards, but are left out of the charts: on a range reaching back before
December 2025 that bucket is around 41% of jobs and would be the tallest bar while telling you
nothing about any group. See [issue #6](https://github.com/gsbdarc/slurm-viz/issues/6).

Yen's sacct dump has no group column, so the tab and the filter do not appear there.

### Sherlock collection pipeline

Recorded here so the provenance lives with the code:

- **Collection:** `/oak/stanford/schools/gsb/private/slurm_stats/squeue_by_group.sh sh_s-gsb`, run
  on Sherlock's scrontab hourly at `30 * * * *` (owner: @alexstorer). Output is PSV files in
  `/oak/stanford/schools/gsb/private/slurm_stats/data/YYYY/MM/`.
- **Transform + Redivis upload:** `squeue-daily-dump.sh` in
  `/oak/stanford/schools/gsb/private/slurm_stats/scripts/` (plus accompanying Python), submitted as
  a recurring Slurm scrontab job at 16:20 PST daily (owner: mpjiang).
- The upload is **raw hourly snapshots** — the transform does not collapse them to per-job rows, so
  the dashboard deduplicates client-side in SQL.

### Derived columns

Notes on the columns the dashboard derives:

- Requested memory is parsed with its unit suffix. sacct's `ReqMem` also carries the older per-CPU
  (`4Gc`) / per-node (`64Gn`) scope markers; a `c` value is multiplied by `NCPUS` to get the job's
  total request, and a bare number is read as raw bytes. squeue's `MinMemory` has no scope marker,
  and a bare number there means megabytes.
- GPU counts come from `gres/gpu=N` in `AllocTRES` (typed forms like `gres/gpu:a30=N` also match).
  The TRES column is resolved by probing the table's schema, so the dashboard still loads — with
  GPU counts of zero — if the dump lacks one.
- `NodeList` stores compact ranges (`yen-gpu[1-3]`, `sh02-01n[02-04,06-13,15]`), so a node cannot be
  matched with `=` or `LIKE`: `LIKE '%yen-gpu4%'` also matches `yen-gpu40`, and nothing matches a
  node hidden inside a range. The filter builds a predicate from the node name in SQL, unnesting the
  bracket bodies so the range comparison is arithmetic rather than textual, and reproducing Slurm's
  zero-padding rule (the width comes from the range's low bound, so `n[5-12]` yields `n5`…`n12` but
  `n[05-12]` yields `n05`…`n12`).

  The node picker's list is therefore only a *suggestion*: filtering never consults it, so a node it
  does not offer still filters correctly if you type the name.
