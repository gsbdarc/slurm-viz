# Yen Cluster Slurm Statistics

Web dashboard for visualizing Slurm cluster job data on Stanford's Yen servers, powered by [Redivis](https://redivis.com).

**Live site:** https://gsbdarc.github.io/slurm-viz/

## Features

- **Jobs** — browse, filter, and sort job records; view submission timelines and queue wait times
- **Cluster** — partition utilization, CPU usage, and node counts
- **Users** — top users by CPU hours, job count, and EC2 cost; usage over time
- **EC2 equivalent cost** — every job priced as the cheapest EC2 instance that fits its requested
  CPU / RAM / GPU, billed for elapsed time
- Date range presets (7d / 30d / 90d / 1y) and custom date selection
- Filter by node (e.g. `yen-gpu4`) across all tabs, plus partition, user, and job state

## EC2 cost estimates

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

## Data Source

[`StanfordGSBSandbox/slurm_stats`](https://redivis.com/StanfordGSBSandbox/datasets/slurm_stats) on Redivis (table: `yen_sacct_dump`).

Notes on the columns the dashboard derives:

- `ReqMem` is parsed with its unit suffix and the older per-CPU (`4Gc`) / per-node (`64Gn`) scope
  markers; a `c` value is multiplied by `NCPUS` to get the job's total request. A bare number is
  read as raw bytes.
- GPU counts come from `gres/gpu=N` in `AllocTRES` (typed forms like `gres/gpu:a30=N` also match).
  The TRES column is resolved by probing the table's schema, so the dashboard still loads — with
  GPU counts of zero — if the dump lacks one.
- `NodeList` stores compact ranges (`yen-gpu[1-3]`). The node filter expands the distinct values
  client-side and matches exact strings, so `yen-gpu4` does not also match `yen-gpu40`.
