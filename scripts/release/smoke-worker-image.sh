#!/usr/bin/env bash
set -euo pipefail

# Both PR CI and production execute this exact credential-free image gate.
cd "$(git rev-parse --show-toplevel)"
: "${FINNOR_COMMIT_SHA:?Exact worker smoke commit is required}"
: "${FINNOR_BUILD_ID:?Exact worker smoke build is required}"
: "${FINNOR_VERSION:?Exact worker smoke version is required}"
: "${RUNNER_TEMP:?An isolated runner evidence directory is required}"
[[ "$FINNOR_COMMIT_SHA" =~ ^[0-9a-f]{40}$ ]]
for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN VERCEL_TOKEN FINNOR_PROTECTED_DATABASE_ENV; do
  if [[ -n "${!name:-}" ]]; then
    echo "::error::worker image smoke must not receive production credentials ($name)"
    exit 1
  fi
done
evidence="$RUNNER_TEMP/finnor-worker-image-smoke"
mkdir -p "$evidence"
image="finnor-worker:${FINNOR_COMMIT_SHA}"
container_id=""
cleanup() {
  status=$?
  if [[ -n "$container_id" ]]; then
    docker logs "$container_id" > "$evidence/container-failure.log" 2>&1 || true
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
  FINNOR_SMOKE_EXIT="$status" FINNOR_SMOKE_EVIDENCE="$evidence" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const directory = process.env.FINNOR_SMOKE_EVIDENCE;
const classes = ["REALTIME", "INTERACTIVE", "BACKGROUND", "HEAVY"];
const successfulClasses = classes.filter(c => fs.existsSync(path.join(directory, `${c}-shutdown.json`)));
fs.writeFileSync(path.join(directory, "receipt.json"), JSON.stringify({
  schema: "finnor.worker-image-smoke.v1",
  status: process.env.FINNOR_SMOKE_EXIT === "0" && successfulClasses.length === 4 ? "PASS" : "FAIL",
  commitSha: process.env.FINNOR_COMMIT_SHA,
  buildId: process.env.FINNOR_BUILD_ID,
  version: process.env.FINNOR_VERSION,
  dockerfileSha256: crypto.createHash("sha256").update(fs.readFileSync("finnor-os/Dockerfile.worker")).digest("hex"),
  successfulClasses,
  steps: ["Build locked Linux image from canonical layout", "Start each of four compute classes against disposable PostgreSQL", "Verify exact release and class health", "SIGTERM each container and require exit zero"],
  rerun: "bash scripts/release/smoke-worker-image.sh",
  providerDeploymentProof: false,
}, null, 2) + "\n");
NODE
  return "$status"
}
trap cleanup EXIT

docker build --file finnor-os/Dockerfile.worker --tag "$image" .
docker image inspect --format '{{.Id}}' "$image" > "$evidence/image-id.txt"
for attempt in $(seq 1 30); do
  pg_isready --host 127.0.0.1 --port 5432 --username finnor --dbname finnor && break
  sleep 2
done
pg_isready --host 127.0.0.1 --port 5432 --username finnor --dbname finnor
supabase_url="$(node -p "require('./infra/deployment/production.contract.json').topology.database.supabaseUrl")"

for workload_class in REALTIME INTERACTIVE BACKGROUND HEAVY; do
  case "$workload_class" in
    REALTIME) capabilities=jobs,realtime,sse ;;
    INTERACTIVE) capabilities=jobs,orchestration,event-wake,workflow ;;
    BACKGROUND) capabilities=jobs,recovery,connection-health,scheduled-scans,epistemic-v2 ;;
    HEAVY) capabilities=jobs,computer,artifact ;;
  esac
  container_id="$(docker run --detach --network host \
    --env NODE_ENV=test \
    --env FINNOR_ENVIRONMENT=production \
    --env FINNOR_RELEASE_SOURCE=github-actions \
    --env FINNOR_COMMIT_SHA="$FINNOR_COMMIT_SHA" \
    --env FINNOR_BUILD_ID="$FINNOR_BUILD_ID" \
    --env FINNOR_VERSION="$FINNOR_VERSION" \
    --env FINNOR_WORKER_DEPLOYMENT_ID=ecs:container-smoke \
    --env FINNOR_WORKLOAD_CLASS="$workload_class" \
    --env FINNOR_WORKER_CAPABILITIES="$capabilities" \
    --env SECRETS_PROVIDER=env \
    --env DATABASE_URL=postgres://finnor:finnor@127.0.0.1:5432/finnor \
    --env POSTGRES_URL_NON_POOLING=postgres://finnor:finnor@127.0.0.1:5432/finnor \
    --env SUPABASE_URL="$supabase_url" \
    --env CENTROPY_SSE_ALLOWED_ORIGINS=https://finnorai.com \
    --env WORKER_CONCURRENCY=2 \
    --env WORKER_INTERACTIVE_RESERVED_CONCURRENCY=0 \
    --env FINNOR_DB_POOL_MAX=1 "$image")"
  ready=0
  for attempt in $(seq 1 30); do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container_id")" != "true" ]]; then
      echo "::error::$workload_class worker exited before health became available"
      exit 1
    fi
    if curl --fail --silent http://127.0.0.1:8090/healthz > "$evidence/$workload_class-health.json"; then
      if FINNOR_SMOKE_CLASS="$workload_class" node - "$evidence/$workload_class-health.json" <<'NODE'
const fs = require("node:fs");
let body;
try { body = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); } catch { process.exit(1); }
if (body.ok !== true || body.release?.commitSha !== process.env.FINNOR_COMMIT_SHA ||
    body.release?.buildId !== process.env.FINNOR_BUILD_ID || body.release?.version !== process.env.FINNOR_VERSION)
  process.exit(1);
if (process.env.FINNOR_SMOKE_CLASS === "REALTIME") {
  if (body.realtime !== true || !body.capabilities?.includes("jobs") ||
      !body.capabilities?.includes("sse") || body.capabilities?.includes("orchestration")) process.exit(1);
} else if (body.realtime !== false || body.serviceClass !== process.env.FINNOR_SMOKE_CLASS) process.exit(1);
NODE
      then ready=1; break; fi
    fi
    sleep 2
  done
  if [[ "$ready" != 1 ]]; then
    echo "::error::$workload_class worker did not expose exact release/class health"
    exit 1
  fi
  docker logs "$container_id" > "$evidence/$workload_class-container.log" 2>&1
  docker stop --time 30 "$container_id" >/dev/null
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container_id")"
  [[ "$exit_code" == "0" ]]
  printf '{"serviceClass":"%s","exitCode":0,"signal":"SIGTERM"}\n' "$workload_class" > "$evidence/$workload_class-shutdown.json"
  docker rm "$container_id" >/dev/null
  container_id=""
done
