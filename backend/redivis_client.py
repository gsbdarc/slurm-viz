import time
import redivis
import pandas as pd

CACHE_TTL = 300  # 5 minutes

_cache = {"df": None, "fetched_at": 0}


def authenticate():
    redivis.authenticate()


def _fetch_data():
    now = time.time()
    if _cache["df"] is not None and (now - _cache["fetched_at"]) < CACHE_TTL:
        return _cache["df"]

    org = redivis.organization("StanfordGSBSandbox")
    dataset = org.dataset("slurm_stats")
    table = dataset.table("yen_sacct_dump")
    df = table.to_pandas_dataframe()

    _cache["df"] = df
    _cache["fetched_at"] = now
    return df


def get_data():
    return _fetch_data()


def get_jobs(state=None, user=None, partition=None, start_date=None, end_date=None):
    df = _fetch_data()
    filtered = df.copy()

    if state and "State" in filtered.columns:
        filtered = filtered[filtered["State"].str.contains(state, case=False, na=False)]
    if user and "User" in filtered.columns:
        filtered = filtered[filtered["User"] == user]
    if partition and "Partition" in filtered.columns:
        filtered = filtered[filtered["Partition"] == partition]
    if start_date and "Start" in filtered.columns:
        filtered = filtered[filtered["Start"] >= start_date]
    if end_date and "End" in filtered.columns:
        filtered = filtered[filtered["End"] <= end_date]

    return filtered


def get_cluster_utilization():
    df = _fetch_data()
    result = {}

    if "Partition" in df.columns:
        result["partitions"] = df["Partition"].value_counts().to_dict()

    if "NCPUS" in df.columns:
        by_partition = df.groupby("Partition")["NCPUS"].agg(["sum", "mean", "count"])
        result["cpu_by_partition"] = by_partition.reset_index().to_dict(orient="records")

    if "MaxRSS" in df.columns:
        result["memory_stats"] = {
            "mean": str(df["MaxRSS"].mean()),
            "max": str(df["MaxRSS"].max()),
        }

    if "NodeList" in df.columns:
        result["nodes_used"] = df["NodeList"].nunique()

    return result


def get_user_summaries():
    df = _fetch_data()
    if "User" not in df.columns:
        return []

    agg_cols = {}
    if "JobID" in df.columns:
        agg_cols["JobID"] = "count"
    if "NCPUS" in df.columns:
        agg_cols["NCPUS"] = "sum"
    if "ElapsedRaw" in df.columns:
        agg_cols["ElapsedRaw"] = "sum"

    if not agg_cols:
        return df["User"].value_counts().reset_index().to_dict(orient="records")

    summary = df.groupby("User").agg(agg_cols).reset_index()
    summary.columns = ["User"] + [
        f"{col}_{func}" for col, func in agg_cols.items()
    ]

    if "NCPUS_sum" in summary.columns and "ElapsedRaw_sum" in summary.columns:
        summary["cpu_hours"] = (summary["NCPUS_sum"] * summary["ElapsedRaw_sum"]) / 3600

    return summary.sort_values(
        summary.columns[1], ascending=False
    ).to_dict(orient="records")


def get_summary():
    df = _fetch_data()
    result = {
        "total_jobs": len(df),
        "columns": list(df.columns),
    }

    if "State" in df.columns:
        state_counts = df["State"].value_counts().to_dict()
        result["state_counts"] = {str(k): int(v) for k, v in state_counts.items()}

    if "User" in df.columns:
        result["unique_users"] = df["User"].nunique()

    if "Partition" in df.columns:
        result["unique_partitions"] = df["Partition"].nunique()

    return result
