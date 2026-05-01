# Yen Cluster Slurm Statistics

Web dashboard for visualizing Slurm cluster job data on Stanford's Yen servers, powered by [Redivis](https://redivis.com).

**Live site:** https://gsbdarc.github.io/slurm-viz/

## Features

- **Jobs** — browse, filter, and sort job records; view submission timelines and queue wait times
- **Cluster** — partition utilization, CPU usage, and node counts
- **Users** — top users by CPU hours and job count, usage over time
- Date range presets (7d / 30d / 90d / 1y) and custom date selection
- Filter by partition, user, and job state

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
