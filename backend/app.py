from flask import Flask, jsonify, request
from flask_cors import CORS
import redivis_client

app = Flask(__name__)
CORS(app)


@app.errorhandler(Exception)
def handle_error(e):
    return jsonify({"error": str(e), "type": type(e).__name__}), 500


@app.route("/api/auth/status")
def auth_status():
    return jsonify(redivis_client.get_auth_status())


@app.route("/api/auth/start", methods=["POST"])
def auth_start():
    return jsonify(redivis_client.start_auth())


@app.route("/api/auth/poll")
def auth_poll():
    return jsonify(redivis_client.poll_auth())


@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    return jsonify(redivis_client.remove_auth())


@app.before_request
def require_auth():
    if request.path.startswith("/api/auth"):
        return
    if not redivis_client.get_auth_status()["authenticated"]:
        return jsonify({"error": "Not authenticated. Click 'Authenticate with Redivis' to log in."}), 401


def _dates():
    default_start, default_end = redivis_client.default_date_range()
    return request.args.get("start", default_start), request.args.get("end", default_end)


@app.route("/api/filters")
def filters():
    start, end = _dates()
    return jsonify(redivis_client.get_filter_options(start, end))


@app.route("/api/summary")
def summary():
    start, end = _dates()
    return jsonify(redivis_client.get_summary(
        start, end,
        state=request.args.get("state"),
        user=request.args.get("user"),
        partition=request.args.get("partition"),
    ))


@app.route("/api/timeline")
def timeline():
    start, end = _dates()
    return jsonify(redivis_client.get_timeline(
        start, end,
        state=request.args.get("state"),
        user=request.args.get("user"),
        partition=request.args.get("partition"),
    ))


@app.route("/api/jobs")
def jobs():
    start, end = _dates()
    data = redivis_client.get_jobs(
        start, end,
        state=request.args.get("state"),
        user=request.args.get("user"),
        partition=request.args.get("partition"),
    )
    return jsonify(data)


@app.route("/api/cluster")
def cluster():
    start, end = _dates()
    return jsonify(redivis_client.get_cluster_utilization(start, end))


@app.route("/api/wait-times")
def wait_times():
    start, end = _dates()
    return jsonify(redivis_client.get_wait_times(
        start, end,
        state=request.args.get("state"),
        user=request.args.get("user"),
        partition=request.args.get("partition"),
    ))


@app.route("/api/users")
def users():
    start, end = _dates()
    return jsonify({"users": redivis_client.get_user_summaries(
        start, end,
        partition=request.args.get("partition"),
    )})


@app.route("/api/users/by-period")
def users_by_period():
    start, end = _dates()
    return jsonify(redivis_client.get_users_by_period(
        start, end,
        partition=request.args.get("partition"),
    ))


@app.route("/api/debug/running")
def debug_running():
    start, end = _dates()
    return jsonify(redivis_client.debug_running(start, end))


if __name__ == "__main__":
    app.run(debug=True, port=5001)
