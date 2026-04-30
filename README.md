# Slurm Viz

Web dashboard for visualizing Slurm cluster data from Redivis.

## Setup

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
flask run
```

On first run, a browser window will open for Redivis OAuth authentication.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

## Data Source

Pulls from the `StanfordGSBSandbox/slurm_stats` dataset on Redivis (table: `yen_sacct_dump`).
