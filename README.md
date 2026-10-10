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

Shown for **Yen only.** Sherlock isn't billed by the hour, so an EC2-equivalent figure would answer a
question nobody is asking there. (The legacy squeue view couldn't have shown one anyway: it has no
real elapsed times.)

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

Test, build, and deploy to GitHub Pages:

```bash
cd frontend
npm run smoke
npm run build
npx gh-pages -d dist
```

**Don't skip `npm run smoke`.** A clean build only proves the code compiles; it never runs a
page. The smoke test renders every tab on every cluster with made-up data, no Redivis login needed,
and exits non-zero if any of them crashes. It exists because on 2026-09-22 a clean build took the
live site down until #12. If it fails, don't deploy.

It checks that pages *render*, not that their numbers are right. When you add a tab or a query,
add it to `smoke/render.jsx` or `smoke/mock-query.js`; the test fails on a query it has no data for.

## Data sources

All tables live in
[`StanfordGSBSandbox/slurm_stats`](https://redivis.com/StanfordGSBSandbox/datasets/slurm_stats) on
Redivis.

| | Yen (`yen_sacct_dump`) | Sherlock (`sherlock_sacct_dump`) | Sherlock (squeue), legacy (`sherlock_squeue_dump`) |
|---|---|---|---|
| Source | `sacct`, job *accounting* | `sacct`, job *accounting* | `squeue`, hourly snapshot of the *live queue* |
| Rows per job | one per daily pull it overlaps | one per daily pull it overlaps | one per hourly snapshot |
| Terminal states | `COMPLETED` / `FAILED` / `TIMEOUT` … | the same | **never observed** |
| Elapsed time | `ElapsedRaw`, final | `ElapsedRaw`, final | last-seen runtime, a **lower bound** |
| Usage (memory, CPU, GPU) | jobs submitted from 2026-01-22 | jobs finished from 2026-04-01 | none |
| History from | 2024-08 | 2025-12-24 | 2025-06 |
| Scope | whole cluster | GSB work (see below) | the `sh_s-gsb` group only |
| PI group | not recorded | `Account` | `Group` |

Every dump records a job more than once, so every query first collapses it to one row per job
with a `ROW_NUMBER()` CTE. The partition and ordering keys differ per cluster and carry their
reasoning in `clusters.js`. All of them end in `TO_JSON_STRING(t)` to force a **total order**:
without it, `ROW_NUMBER` breaks ties arbitrarily and a job's reported runtime changes between
identical queries.

### Sherlock

Since 2026-10-10 ([#14](https://github.com/gsbdarc/slurm-viz/issues/14)), the Sherlock view reads
`sherlock_sacct_dump`. The Yen's sacct pipeline
([gsbdarc/slurm-stats-yens](https://github.com/gsbdarc/slurm-stats-yens)) writes it nightly at 17:30
from Sherlock's scrontab, so the Sherlock view works like the Yen's: real end states, final
runtimes, and memory, CPU and GPU usage. What differs:

- **Scope is GSB work, not the whole cluster.** A job is included if its user is in `sh_s-gsb`, if
  its user has Yen access, or if it was charged to one of 13 GSB PI accounts. Because the rule
  about Yen access is literal, every Sherlock job by someone who can log in to the Yens is in,
  whatever account it was charged to. Filter by group to see one PI's work.
- **History starts 2025-12-24.** Sherlock keeps about six months of job records. Everything earlier
  was already purged when the backfill ran on 2026-10-09.
- **Usage starts with jobs that finished on or after 2026-04-01.** Sherlock purges job *steps*, which
  carry the usage figures, on schedule at six months, while the job records themselves are purged
  late. Earlier jobs have states and runtimes but blank usage columns. Blank means unknown, not
  zero.
- **No GPU memory %, for now.** That needs each node's GPU memory as the denominator, and the
  node-to-model map for Sherlock hasn't been built yet (`sinfo -o "%N %f"`). GPU counts and peak GPU
  utilization are shown.
- **Jobs cancelled before they ever became eligible are not recorded.** These are jobs that were
  held, or blocked on a dependency that never cleared. A date-range `sacct` never returns them. They
  were 2–7% of the jobs squeue saw each month, and they used no resources. The Yen has the same
  blind spot.
- **Partition lists show up as "(never placed)".** Until a job starts, Slurm records every partition
  it was eligible for (`gsb,maggiori,normal`), and a job cancelled before it started keeps that list
  for good. No started job carries a list (0 of 511,935), so the 57 distinct lists are folded into
  one label instead of each appearing as a partition. The jobs still count everywhere.
- **No EC2 cost**, as above.

### Unique users over time

The Users tab's weekly (or daily or monthly) chart counts each user **once per period**, under the
segment where they used the most CPU-hours. Ties go to the segment with more jobs, then to
alphabetical order. The segment is the group on Sherlock and the partition on the Yen. So a bar's
height is that period's true count of unique users. The old chart counted a user in every partition
they touched: on Sherlock its stacks reached 85–110 a week, against 31–36 actual users. The top 8
segments are shown, and the rest are grouped into "Other".

### Groups (Sherlock only)

On Sherlock the PI group is the Slurm `Account` a job was charged to. It gets a tab of its own,
and a filter in the shared bar that narrows every other tab. September 2026 had 24 accounts: the
13 GSB PI accounts, plus others that Yen users charged.

`Account` is not strictly a function of user. As of 2026-10-10, 4 of 119 users had charged two
accounts (10,594 of 518,686 rows). The Groups tab is exact, because it groups by account. The Users
tab shows one account per user, so those 4 appear under one of their two.

The Yen's dump has no usable group (`Account` and `Group` are constant there), so the tab and the
filter don't appear on the Yen.

### The legacy squeue view (being retired)

`Sherlock (squeue)` in the toggle is the old view, backed by `sherlock_squeue_dump`. It stays only
while the two pipelines run side by side, so they can be compared. Remove its entry from
`clusters.js` when the squeue collector is retired. Its limits all follow from one fact: `squeue`
only sees a job while it is still queued or running.

- **Every statistic is survivorship-biased.** The collector runs hourly, so a job submitted, run and
  finished between two snapshots is never recorded. In September 2026 it saw 18,792 jobs, where
  sacct counted 67,186 (sacct's scope is also wider). The caveat banner quantifies the bias for
  whatever is on screen.
- **No job states, no end time, no usage, no GPU counts, no EC2 cost.** Only `RUNNING`, `PENDING`,
  `COMPLETING` and `CONFIGURING` are ever observed. `EndTime` is always the scheduler's estimate.
  The dump has no TRES column.
- **Runtimes are lower bounds**: `TimeUsed` is the last value seen, ordered on the parsed seconds
  (lexically, `9:00` would outrank `10:00:00`).
- **Queue waits exclude pending jobs**, whose `StartTime` is a forecast.
- **CPU, memory and `Group` are missing before December 2025.** See
  [issue #6](https://github.com/gsbdarc/slurm-viz/issues/6).

Provenance:
- **Collection:** `/oak/stanford/schools/gsb/private/slurm_stats/squeue_by_group.sh sh_s-gsb`, run
  hourly at `30 * * * *` from Sherlock's scrontab (owner: @alexstorer).
- **Transform and upload:** `squeue-daily-dump.sh` in
  `/oak/stanford/schools/gsb/private/slurm_stats/scripts/`, from scrontab daily at 16:20 (owner:
  mpjiang).

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
