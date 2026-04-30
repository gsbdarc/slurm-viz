from flask import Flask, jsonify, request
from flask_cors import CORS
import redivis_client

app = Flask(__name__)
CORS(app)


@app.before_request
def ensure_auth():
    redivis_client.authenticate()


@app.route("/api/summary")
def summary():
    data = redivis_client.get_summary()
    return jsonify(data)


@app.route("/api/jobs")
def jobs():
    df = redivis_client.get_jobs(
        state=request.args.get("state"),
        user=request.args.get("user"),
        partition=request.args.get("partition"),
        start_date=request.args.get("start_date"),
        end_date=request.args.get("end_date"),
    )
    records = df.head(1000).to_dict(orient="records")
    return jsonify({"jobs": records, "total": len(df)})


@app.route("/api/cluster")
def cluster():
    data = redivis_client.get_cluster_utilization()
    return jsonify(data)


@app.route("/api/users")
def users():
    data = redivis_client.get_user_summaries()
    return jsonify({"users": data})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
