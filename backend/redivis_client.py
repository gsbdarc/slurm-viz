import time
import json
import hashlib
import base64
import secrets
from datetime import datetime, timedelta
from pathlib import Path
import requests as http_requests
import redivis

CACHE_TTL = 300
REDIVIS_CLIENT_ID = "7YGtYWuQot1TEe0pHB3EPSj5"
REDIVIS_BASE_URL = "https://redivis.com"
AUTH_SCOPE = ["data.data"]
TABLE_REF = "yen_sacct_dump:7mp6"
DATASET_REF = "StanfordGSBSandbox.slurm_stats:3stz"

_credentials_file = Path.home() / ".redivis" / "python_credentials"
_pending_auth = {}
_query_cache = {}


def _parse_mem_to_gb(val):
    if val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    try:
        return round(float(s) / (1024 ** 3), 2)
    except ValueError:
        pass
    suffix = s[-1].upper()
    try:
        num = float(s[:-1])
    except ValueError:
        return None
    if suffix == "K":
        return round(num / (1024 ** 2), 2)
    if suffix == "M":
        return round(num / 1024, 2)
    if suffix == "G":
        return round(num, 2)
    if suffix == "T":
        return round(num * 1024, 2)
    return None


def _run_query(sql, cache_key=None):
    now = time.time()
    if cache_key:
        cache_key = f"{cache_key}_{hashlib.md5(sql.encode()).hexdigest()[:8]}"
    if cache_key and cache_key in _query_cache:
        cached = _query_cache[cache_key]
        if (now - cached["fetched_at"]) < CACHE_TTL:
            return cached["result"]

    q = redivis.query(sql, default_dataset=DATASET_REF)
    df = q.to_pandas_dataframe()
    result = df.to_dict(orient="records")

    if cache_key:
        _query_cache[cache_key] = {"result": result, "fetched_at": now}

    return result


def _date_clause(start, end):
    parts = []
    if start:
        parts.append(f"`Submit` >= '{start}'")
    if end:
        end_exclusive = (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        parts.append(f"`Submit` < '{end_exclusive}'")
    return " AND ".join(parts) if parts else "1=1"


DEDUP_CTE = f"""jobs AS (
    SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY `JobID` ORDER BY `End` DESC, `Start` DESC, `Submit` DESC) AS _rn
        FROM `{TABLE_REF}`
    ) WHERE _rn = 1
)"""


def default_date_range():
    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=30)).strftime("%Y-%m-%d")
    return start, end


def _granularity(start, end):
    try:
        days = (datetime.strptime(end, "%Y-%m-%d") - datetime.strptime(start, "%Y-%m-%d")).days
    except (ValueError, TypeError):
        days = 30
    if days <= 14:
        return "day", "DATE(`Submit`)"
    if days <= 90:
        return "week", "DATE_TRUNC(`Submit`, WEEK)"
    return "month", "DATE_TRUNC(`Submit`, MONTH)"


# --- Auth ---

def get_auth_status():
    if not _credentials_file.is_file():
        return {"authenticated": False}
    try:
        creds = json.loads(_credentials_file.read_text())
        return {"authenticated": "access_token" in creds}
    except Exception:
        return {"authenticated": False}


def remove_auth():
    if _credentials_file.is_file():
        _credentials_file.unlink()
    _query_cache.clear()
    return {"status": "ok"}


def start_auth():
    verifier = secrets.token_urlsafe(64)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .decode()
        .replace("=", "")
    )

    res = http_requests.post(
        f"{REDIVIS_BASE_URL}/oauth/device_authorization",
        headers={"Content-Type": "application/json"},
        json={
            "client_id": REDIVIS_CLIENT_ID,
            "scope": " ".join(AUTH_SCOPE),
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "access_type": "offline",
        },
    )
    res.raise_for_status()
    data = res.json()

    _pending_auth["device_code"] = data["device_code"]
    _pending_auth["verifier"] = verifier
    _pending_auth["interval"] = data.get("interval", 5)

    return {
        "verification_url": data["verification_uri_complete"],
        "status": "pending",
    }


def poll_auth():
    if "device_code" not in _pending_auth:
        return {"status": "no_pending_auth"}

    res = http_requests.post(
        f"{REDIVIS_BASE_URL}/oauth/token",
        data={
            "client_id": REDIVIS_CLIENT_ID,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "device_code": _pending_auth["device_code"],
            "code_verifier": _pending_auth["verifier"],
        },
    )

    if res.status_code == 200:
        creds = res.json()
        _credentials_file.parent.mkdir(exist_ok=True)
        _credentials_file.write_text(json.dumps(creds, indent=2))
        _pending_auth.clear()
        return {"status": "authenticated"}

    if res.status_code == 400 and res.json().get("error") == "authorization_pending":
        return {"status": "pending", "interval": _pending_auth["interval"]}

    return {"status": "error", "error": res.json().get("error_description", res.text)}


# --- Data queries ---

def get_filter_options(start, end):
    dc = _date_clause(start, end)
    ck = f"filters_{start}_{end}"

    users = _run_query(f"""
        WITH {DEDUP_CTE}
        SELECT DISTINCT `User` AS val FROM jobs
        WHERE {dc} AND `User` IS NOT NULL ORDER BY val
    """, cache_key=f"{ck}_users")

    partitions = _run_query(f"""
        WITH {DEDUP_CTE}
        SELECT DISTINCT `Partition` AS val FROM jobs
        WHERE {dc} AND `Partition` IS NOT NULL ORDER BY val
    """, cache_key=f"{ck}_partitions")

    states = _run_query(f"""
        WITH {DEDUP_CTE}
        SELECT DISTINCT
            CASE
                WHEN `State` IS NULL THEN 'UNKNOWN'
                WHEN `State` LIKE 'CANCELLED%' THEN 'CANCELLED'
                ELSE `State`
            END AS val
        FROM jobs
        WHERE {dc}
        ORDER BY val
    """, cache_key=f"{ck}_states")

    return {
        "users": [r["val"] for r in users],
        "partitions": [r["val"] for r in partitions],
        "states": [r["val"] for r in states],
    }


def get_summary(start, end, state=None, user=None, partition=None):
    conditions = [_date_clause(start, end)]
    if state:
        conditions.append(f"`State` LIKE '%{state}%'")
    if user:
        conditions.append(f"`User` = '{user}'")
    if partition:
        conditions.append(f"`Partition` = '{partition}'")
    where = " AND ".join(conditions)
    cache_key = f"summary_{start}_{end}_{state}_{user}_{partition}"

    rows = _run_query(f"""
        WITH {DEDUP_CTE}
        SELECT
            COUNT(*) AS total_jobs,
            COUNT(DISTINCT `User`) AS unique_users,
            COUNT(DISTINCT `Partition`) AS unique_partitions,
            COUNTIF(`State` = 'COMPLETED') AS completed,
            COUNTIF(`State` = 'FAILED') AS failed,
            COUNTIF(`State` LIKE 'CANCELLED%') AS cancelled,
            COUNTIF(`State` = 'RUNNING') AS running,
            COUNTIF(`State` = 'PENDING') AS pending,
            COUNTIF(`State` = 'TIMEOUT') AS timeout,
            COUNTIF(`State` = 'OUT_OF_MEMORY') AS out_of_memory,
            COUNTIF(`State` = 'NODE_FAIL') AS node_fail
        FROM jobs
        WHERE {where}
    """, cache_key=cache_key)

    r = rows[0] if rows else {}
    state_counts = {}
    for key in ["completed", "failed", "cancelled", "running", "pending", "timeout", "out_of_memory", "node_fail"]:
        val = r.get(key, 0)
        if val:
            state_counts[key.upper().replace("_", " ")] = val

    return {
        "total_jobs": r.get("total_jobs", 0),
        "unique_users": r.get("unique_users", 0),
        "unique_partitions": r.get("unique_partitions", 0),
        "state_counts": state_counts,
    }


def get_timeline(start, end, state=None, user=None, partition=None):
    conditions = [_date_clause(start, end)]
    if state:
        conditions.append(f"`State` LIKE '%{state}%'")
    if user:
        conditions.append(f"`User` = '{user}'")
    if partition:
        conditions.append(f"`Partition` = '{partition}'")
    where = " AND ".join(conditions)
    gran, expr = _granularity(start, end)
    cache_key = f"timeline_{start}_{end}_{state}_{user}_{partition}"

    rows = _run_query(f"""
        WITH {DEDUP_CTE}
        SELECT {expr} AS period, COUNT(*) AS count
        FROM jobs
        WHERE {where}
        GROUP BY period
        ORDER BY period
    """, cache_key=cache_key)

    return {"granularity": gran, "data": rows}


def get_jobs(start, end, state=None, user=None, partition=None):
    conditions = [_date_clause(start, end)]
    if state:
        conditions.append(f"`State` LIKE '%{state}%'")
    if user:
        conditions.append(f"`User` = '{user}'")
    if partition:
        conditions.append(f"`Partition` = '{partition}'")

    where = f"WHERE {' AND '.join(conditions)}"
    filter_key = f"jobs_{start}_{end}_{state}_{user}_{partition}"

    count_rows = _run_query(
        f"WITH {DEDUP_CTE} SELECT COUNT(*) AS total FROM jobs {where}",
        cache_key=f"cnt_{filter_key}",
    )
    total = count_rows[0]["total"] if count_rows else 0

    rows = _run_query(f"""
        WITH {DEDUP_CTE}
        SELECT `JobID`, `JobName`, `User`, `Partition`, `State`, `NCPUS`,
               `ReqMem`, `ElapsedRaw`, `Submit`, `Start`, `End`, `NodeList`,
               CASE WHEN `Start` IS NOT NULL AND `Start` > `Submit`
                   THEN TIMESTAMP_DIFF(TIMESTAMP(`Start`), TIMESTAMP(`Submit`), SECOND)
                   ELSE NULL END AS wait_seconds
        FROM jobs
        {where}
        ORDER BY `Submit` DESC
        LIMIT 500
    """, cache_key=f"rows_{filter_key}")

    rows = [
        {**{k: v for k, v in r.items() if k != "ReqMem"}, "ReqMem_GB": _parse_mem_to_gb(r.get("ReqMem"))}
        for r in rows
    ]

    return {"jobs": rows, "total": total}


def _expand_nodelist(nodelist):
    """Expand Slurm compressed nodelist like 'node[01-04,06],gpu01' into individual node names."""
    import re
    nodes = set()
    if not nodelist:
        return nodes
    for part in re.split(r',(?![^\[]*\])', nodelist):
        part = part.strip()
        m = re.match(r'^(.+?)\[(.+)\]$', part)
        if m:
            prefix, ranges = m.group(1), m.group(2)
            for r in ranges.split(','):
                if '-' in r:
                    lo, hi = r.split('-', 1)
                    width = len(lo)
                    for i in range(int(lo), int(hi) + 1):
                        nodes.add(f"{prefix}{str(i).zfill(width)}")
                else:
                    nodes.add(f"{prefix}{r}")
        else:
            nodes.add(part)
    return nodes


def get_cluster_utilization(start, end):
    dc = _date_clause(start, end)
    cache_key = f"cluster_{start}_{end}"

    partition_rows = _run_query(f"""
        WITH {DEDUP_CTE}
        SELECT
            `Partition`,
            COUNT(*) AS job_count,
            SUM(`NCPUS`) AS total_cpus,
            AVG(`NCPUS`) AS avg_cpus_per_job,
            AVG(CASE
                WHEN `ReqMem` IS NULL OR `ReqMem` = '' THEN NULL
                WHEN ENDS_WITH(`ReqMem`, 'T') THEN SAFE_CAST(SUBSTR(`ReqMem`, 1, LENGTH(`ReqMem`) - 1) AS FLOAT64) * 1024
                WHEN ENDS_WITH(`ReqMem`, 'G') THEN SAFE_CAST(SUBSTR(`ReqMem`, 1, LENGTH(`ReqMem`) - 1) AS FLOAT64)
                WHEN ENDS_WITH(`ReqMem`, 'M') THEN SAFE_CAST(SUBSTR(`ReqMem`, 1, LENGTH(`ReqMem`) - 1) AS FLOAT64) / 1024
                WHEN ENDS_WITH(`ReqMem`, 'K') THEN SAFE_CAST(SUBSTR(`ReqMem`, 1, LENGTH(`ReqMem`) - 1) AS FLOAT64) / (1024 * 1024)
                ELSE SAFE_CAST(`ReqMem` AS FLOAT64) / (1024 * 1024 * 1024)
            END) AS avg_mem_gb,
            AVG(`ElapsedRaw`) AS avg_elapsed_seconds,
            AVG(CASE WHEN `Start` IS NOT NULL AND `Start` > `Submit`
                THEN TIMESTAMP_DIFF(TIMESTAMP(`Start`), TIMESTAMP(`Submit`), SECOND)
                ELSE NULL END) AS avg_wait_seconds
        FROM jobs
        WHERE {dc}
        GROUP BY `Partition`
        ORDER BY job_count DESC
    """, cache_key=cache_key)

    nodelist_rows = _run_query(f"""
        WITH {DEDUP_CTE}
        SELECT DISTINCT `NodeList` AS nl
        FROM jobs
        WHERE {dc} AND `NodeList` IS NOT NULL
    """, cache_key=f"{cache_key}_nodes")

    all_nodes = set()
    for r in nodelist_rows:
        all_nodes.update(_expand_nodelist(r.get("nl", "")))
    all_nodes.discard("")
    all_nodes.discard("None")

    return {
        "cpu_by_partition": partition_rows,
        "partitions": {r["Partition"]: r["job_count"] for r in partition_rows},
        "nodes_used": len(all_nodes),
    }


def get_user_summaries(start, end, partition=None):
    conditions = [_date_clause(start, end)]
    if partition:
        conditions.append(f"`Partition` = '{partition}'")
    where = " AND ".join(conditions)
    cache_key = f"users_{start}_{end}_{partition}"

    return _run_query(f"""
        WITH {DEDUP_CTE}
        SELECT
            `User`,
            COUNT(*) AS job_count,
            SUM(`NCPUS`) AS total_cpus,
            SUM(`ElapsedRaw`) AS total_elapsed,
            SUM(CAST(`NCPUS` AS FLOAT64) * `ElapsedRaw`) / 3600 AS cpu_hours,
            SUM(CASE WHEN `Start` IS NOT NULL AND `Start` > `Submit`
                THEN TIMESTAMP_DIFF(TIMESTAMP(`Start`), TIMESTAMP(`Submit`), SECOND)
                ELSE 0 END) / 3600.0 AS total_wait_hours
        FROM jobs
        WHERE {where}
        GROUP BY `User`
        ORDER BY cpu_hours DESC
    """, cache_key=cache_key)


def get_wait_times(start, end, state=None, user=None, partition=None):
    conditions = [_date_clause(start, end)]
    conditions.append("`Start` IS NOT NULL")
    conditions.append("`Start` > `Submit`")
    if state:
        conditions.append(f"`State` LIKE '%{state}%'")
    if user:
        conditions.append(f"`User` = '{user}'")
    if partition:
        conditions.append(f"`Partition` = '{partition}'")
    where = " AND ".join(conditions)
    gran, expr = _granularity(start, end)
    cache_key = f"wait_{start}_{end}_{state}_{user}_{partition}"

    rows = _run_query(f"""
        WITH {DEDUP_CTE}
        SELECT
            {expr} AS period,
            AVG(TIMESTAMP_DIFF(TIMESTAMP(`Start`), TIMESTAMP(`Submit`), SECOND)) / 60.0 AS avg_wait_minutes,
            APPROX_QUANTILES(TIMESTAMP_DIFF(TIMESTAMP(`Start`), TIMESTAMP(`Submit`), SECOND) / 60.0, 100)[OFFSET(50)] AS median_wait_minutes,
            MAX(TIMESTAMP_DIFF(TIMESTAMP(`Start`), TIMESTAMP(`Submit`), SECOND)) / 60.0 AS max_wait_minutes
        FROM jobs
        WHERE {where}
        GROUP BY period
        ORDER BY period
    """, cache_key=cache_key)

    return {"granularity": gran, "data": rows}


def get_users_by_period(start, end, partition=None):
    conditions = [_date_clause(start, end)]
    if partition:
        conditions.append(f"`Partition` = '{partition}'")
    where = " AND ".join(conditions)
    gran, expr = _granularity(start, end)
    cache_key = f"users_period_{start}_{end}_{partition}"

    rows = _run_query(f"""
        WITH {DEDUP_CTE}
        SELECT
            {expr} AS period,
            `Partition`,
            COUNT(DISTINCT `User`) AS unique_users
        FROM jobs
        WHERE {where}
        GROUP BY period, `Partition`
        ORDER BY period
    """, cache_key=cache_key)

    return {"granularity": gran, "data": rows}


def debug_running(start, end):
    dc = _date_clause(start, end)

    raw_running = _run_query(f"""
        SELECT
            COUNT(*) AS total_rows,
            COUNT(DISTINCT `JobID`) AS unique_jobs
        FROM `{TABLE_REF}`
        WHERE {dc} AND `State` = 'RUNNING'
    """)

    deduped_running = _run_query(f"""
        WITH {DEDUP_CTE}
        SELECT
            COUNT(*) AS total_rows,
            COUNT(DISTINCT `JobID`) AS unique_jobs
        FROM jobs
        WHERE {dc} AND `State` = 'RUNNING'
    """)

    return {
        "raw_running": raw_running[0] if raw_running else {},
        "deduped_running": deduped_running[0] if deduped_running else {},
    }
