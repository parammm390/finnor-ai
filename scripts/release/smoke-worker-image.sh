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
  # Owner stores intentionally use private/read-only modes. Give the disposable
  # evidence back to its host owner without weakening those production modes.
  if [[ -d "$evidence/linux-r1-runtime" ]]; then
    if ! docker run --rm --network none --user 0:0 --entrypoint chown \
      --mount "type=bind,source=$evidence/linux-r1-runtime,target=/r1-evidence" \
      "$image" -R "$(id -u):$(id -g)" /r1-evidence; then
      echo "::error::failed to return disposable runtime evidence to its host owner"
      status=1
    fi
  fi
  if [[ -d "$evidence/linux-r3-runtime" ]]; then
    if ! docker run --rm --network none --user 0:0 --entrypoint chown \
      --mount "type=bind,source=$evidence/linux-r3-runtime,target=/r3-evidence" \
      "$image" -R "$(id -u):$(id -g)" /r3-evidence; then
      echo "::error::failed to return disposable R3 evidence to its host owner"
      status=1
    fi
  fi
  if [[ -d "$evidence/linux-r4-runtime" ]]; then
    if ! docker run --rm --network none --user 0:0 --entrypoint chown \
      --mount "type=bind,source=$evidence/linux-r4-runtime,target=/r4-evidence" \
      "$image" -R "$(id -u):$(id -g)" /r4-evidence; then
      echo "::error::failed to return disposable R4 evidence to its host owner"
      status=1
    fi
  fi
  if [[ -d "$evidence/linux-programme-runtime" ]]; then
    if ! docker run --rm --network none --user 0:0 --entrypoint chown \
      --mount "type=bind,source=$evidence/linux-programme-runtime,target=/programme-evidence" \
      "$image" -R "$(id -u):$(id -g)" /programme-evidence; then
      echo "::error::failed to return disposable programme evidence to its host owner"
      status=1
    fi
  fi
  if [[ -d "$evidence/linux-s6-runtime" ]]; then
    if ! docker run --rm --network none --user 0:0 --entrypoint chown \
      --mount "type=bind,source=$evidence/linux-s6-runtime,target=/s6-evidence" \
      "$image" -R "$(id -u):$(id -g)" /s6-evidence; then
      echo "::error::failed to return disposable executor evidence to its host owner"
      status=1
    fi
  fi
  FINNOR_SMOKE_EXIT="$status" FINNOR_SMOKE_EVIDENCE="$evidence" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const directory = process.env.FINNOR_SMOKE_EVIDENCE;
const classes = ["REALTIME", "INTERACTIVE", "BACKGROUND", "HEAVY"];
const successfulClasses = classes.filter(c => fs.existsSync(path.join(directory, `${c}-shutdown.json`)));
const r3Required = fs.existsSync("finnor-os/scripts/r3/run-owner-e2e.mts");
const r3Receipt = r3Required && fs.existsSync(path.join(directory, "linux-r3-runtime", "receipt.json"))
  ? JSON.parse(fs.readFileSync(path.join(directory, "linux-r3-runtime", "receipt.json"), "utf8")) : null;
const r3Passed = !r3Required || r3Receipt?.status === "PASS";
const r4Required = fs.existsSync("finnor-os/scripts/r4/run-integrated.mts");
const r4Passed = !r4Required || fs.existsSync(path.join(directory, "linux-r4-runtime", "results.json"));
const s6Path = path.join(directory, "linux-s6-runtime", "executor", "results.json");
const s6 = fs.existsSync(s6Path) ? JSON.parse(fs.readFileSync(s6Path, "utf8")) : null;
const s6Passed = s6?.results?.length === 5 && s6.results.every(r => r.status === "PASS");
fs.writeFileSync(path.join(directory, "receipt.json"), JSON.stringify({
  schema: "finnor.worker-image-smoke.v1",
  status: process.env.FINNOR_SMOKE_EXIT === "0" && successfulClasses.length === 4 && fs.existsSync(path.join(directory, "linux-r1-runtime", "results.json")) && s6Passed && r3Passed && r4Passed ? "PASS" : "FAIL",
  commitSha: process.env.FINNOR_COMMIT_SHA,
  buildId: process.env.FINNOR_BUILD_ID,
  version: process.env.FINNOR_VERSION,
  dockerfileSha256: crypto.createHash("sha256").update(fs.readFileSync("finnor-os/Dockerfile.worker")).digest("hex"),
  successfulClasses,
  r4Required,
  s6Passed,
  steps: ["Build locked Linux image from canonical layout", "Start each of four compute classes against disposable PostgreSQL", "Verify exact release and class health", "SIGTERM each container and require exit zero", "Run actual compiled API / authenticated R1 / independent checker / S4 / S5 with migration and protocol compatibility from that image", ...(r3Required ? ["Run installed R3 runtime identity/checker and finite authenticated R3 owner queue/restart cases from the exact image"] : []), ...(r4Required ? ["Run the separate installed R4 scientific runtime and authenticated migration / worker / checker / S4 / S5 owner flow with exact image identity"] : [])],
  rerun: "bash scripts/release/smoke-worker-image.sh",
  providerDeploymentProof: false,
}, null, 2) + "\n");
NODE

  exit "$status"
}
trap cleanup EXIT

if [[ -n "${FINNOR_WORKER_PREBUILT_IMAGE_ID:-}" ]]; then
  # CI supplies the immutable ID returned by its actual cached BuildKit build,
  # not a boolean skip or an assumed tag. Local reruns still build by default.
  [[ "$FINNOR_WORKER_PREBUILT_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]
  [[ "$(docker image inspect --format '{{.Id}}' "$image")" == "$FINNOR_WORKER_PREBUILT_IMAGE_ID" ]]
  [[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$FINNOR_COMMIT_SHA" ]]
  [[ "$(docker image inspect --format '{{index .Config.Labels "ai.finnor.build-id"}}' "$image")" == "$FINNOR_BUILD_ID" ]]
else
  docker build --file finnor-os/Dockerfile.worker --tag "$image" . --build-arg "FINNOR_BUILD_ID=$FINNOR_BUILD_ID"
fi
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

# Fail at the exact installed isolation boundary before starting costly owner
# campaigns. This uses the final image's default outer security profile/caps.
mkdir -p "$evidence/linux-s6-runtime"
chmod 2770 "$evidence/linux-s6-runtime"
if docker run --rm --network none --user 1000:1000 --group-add "$(id -g)" \
  --env HOME=/tmp --env NODE_ENV=test --env CI=1 \
  --env FINNOR_S6_EXECUTOR_EVIDENCE_DIR=/s6-evidence/executor \
  --mount "type=bind,source=$evidence/linux-s6-runtime,target=/s6-evidence" \
  "$image" node --import=tsx scripts/s6/run-executor-e2e.mts \
  > "$evidence/linux-s6-runtime/runner.log" 2>&1; then
  :
else
  executor_status=$?
  cat "$evidence/linux-s6-runtime/runner.log"
  exit "$executor_status"
fi

# The same final image, including its Python environment and compiled API, must
# execute the owning flow. This is isolated ordinary development, with no network
# access to external providers or production DB and no protected admission flag.
mkdir -p "$evidence/linux-r1-runtime"
chmod 2770 "$evidence/linux-r1-runtime"
image_id="$(cat "$evidence/image-id.txt")"
source_tree="$(git rev-parse 'HEAD^{tree}')"
if docker run --rm --network none --user 1000:1000 --group-add "$(id -g)" \
  --env HOME=/tmp --env NODE_ENV=test --env CI=1 --env LOG_LEVEL=silent \
  --env AUTH_DEV_BYPASS=0 --env FINNOR_P4_PROFILE=ordinary_disposable \
  --env FINNOR_M1_PROFILE=DISPOSABLE_NATIVE --env P3_GOVERNORS=1 \
  --env FINNOR_COMMIT_SHA="$FINNOR_COMMIT_SHA" \
  --env FINNOR_BUILD_ID="$FINNOR_BUILD_ID" --env FINNOR_VERSION="$FINNOR_VERSION" \
  --env FINNOR_RELEASE_SOURCE=ordinary-image-verification \
  --env FINNOR_R1_PACKAGED_SOURCE=1 --env FINNOR_R1_IMAGE_ID="$image_id" \
  --env FINNOR_R1_SOURCE_TREE="$source_tree" --env FINNOR_R1_EVIDENCE_DIR=/r1-evidence \
  --mount "type=bind,source=$evidence/linux-r1-runtime,target=/r1-evidence" \
  "$image" node --import=tsx scripts/r1/run-owners.mts runtime \
  > "$evidence/linux-r1-runtime/runner.log" 2>&1; then
  :
else
  runtime_status=$?
  cat "$evidence/linux-r1-runtime/runner.log"
  exit "$runtime_status"
fi
node - "$evidence/linux-r1-runtime/results.json" <<'NODE'
const fs = require("node:fs");
const receipt = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const required = ["ready-worker-holds-until-dispatch", "positive-owner-reduction"];
if (receipt.status !== "PASS_LOCAL" || receipt.results.length !== required.length ||
    required.some(id => receipt.results.filter(r => r.id === id && r.status === "PASS").length !== 1)) {
  console.error("::error::R1 installed owner proof failed: " + JSON.stringify({status:receipt.status,
    cases:receipt.results.map(r=>({id:r.id,status:r.status,error:String(r.observed?.error??"").slice(0,1024)}))}));
  process.exit(1);
}
NODE


# Exercise the actual P1 isolation/physical-supervisor boundary before expensive
# owner campaigns. No privileged mode, extra capabilities or security overrides.
# A platform refusal fails closed and retains the precise physical receipts.
if [[ -f finnor-os/scripts/r5/run-programme-isolation-e2e.mts ]]; then
  mkdir -p "$evidence/linux-programme-runtime"
  chmod 2770 "$evidence/linux-programme-runtime"
  if docker run --rm --network none --user 1000:1000 --group-add "$(id -g)" \
    --env HOME=/tmp --env NODE_ENV=test --env CI=1 --env LOG_LEVEL=silent \
    --mount "type=bind,source=$evidence/linux-programme-runtime,target=/programme-evidence" \
    "$image" node --import=tsx scripts/r5/run-programme-isolation-e2e.mts /programme-evidence/physical \
    > "$evidence/linux-programme-runtime/runner.log" 2>&1; then
    :
  else
    programme_status=$?
    cat "$evidence/linux-programme-runtime/runner.log"
    exit "$programme_status"
  fi
fi

# R3 must execute its installed runtime and finite authenticated owner/queue
# cases from the exact final image. The selected cases are preregistered in the
# R3 handoff: owner HTTP/auth, durable queue/worker, physical restart and
# unchanged job/deadline identity. Browser evidence remains a separate Work
# surface gate because this minimal worker image has no browser binary.
owner_failures=0
(
if [[ -f finnor-os/scripts/r3/run-owner-e2e.mts ]]; then
  mkdir -p "$evidence/linux-r3-runtime"
  chmod 2770 "$evidence/linux-r3-runtime"
  if docker run --rm --network none --user 1000:1000 --group-add "$(id -g)" \
    --env HOME=/tmp --env TMPDIR=/tmp --env NODE_ENV=test --env CI=1 --env LOG_LEVEL=silent \
    --env AUTH_DEV_BYPASS=0 --env FINNOR_TEST_MANAGED_EXTENSIONS=omit \
    --env FINNOR_R3_PROFILE=ordinary_disposable \
    --env FINNOR_R3_RUNTIME_MANIFEST=/opt/r3-runtime/manifest.json \
    --env FINNOR_R3_UPSTREAM_PYTHON=/opt/r3-upstream-runtime/bin/python \
    --env FINNOR_S3_PYTHON=/opt/r3-upstream-runtime/bin/python \
    --env FINNOR_S5_PYTHON=/opt/r3-upstream-runtime/bin/python \
    --env FINNOR_R3_EVIDENCE_DIR=/r3-evidence/installed \
    --mount "type=bind,source=$evidence/linux-r3-runtime,target=/r3-evidence" \
    "$image" node --import=tsx scripts/r3/check-runtime.mts /r3-evidence/installed \
    > "$evidence/linux-r3-runtime/runtime.log" 2>&1; then
    :
  else
    runtime_status=$?
    cat "$evidence/linux-r3-runtime/runtime.log"
    exit "$runtime_status"
  fi
  if docker run --rm --network none --user 1000:1000 --group-add "$(id -g)" \
    --env HOME=/tmp --env TMPDIR=/tmp --env NODE_ENV=test --env CI=1 --env LOG_LEVEL=silent \
    --env AUTH_DEV_BYPASS=0 --env FINNOR_TEST_MANAGED_EXTENSIONS=omit \
    --env FINNOR_COMMIT_SHA="$FINNOR_COMMIT_SHA" \
    --env FINNOR_BUILD_ID="$FINNOR_BUILD_ID" \
    --env FINNOR_VERSION="$FINNOR_VERSION" \
    --env FINNOR_R3_PROFILE=ordinary_disposable \
    --env FINNOR_R3_RUNTIME_MANIFEST=/opt/r3-runtime/manifest.json \
    --env FINNOR_R3_UPSTREAM_PYTHON=/opt/r3-upstream-runtime/bin/python \
    --env FINNOR_S3_PYTHON=/opt/r3-upstream-runtime/bin/python \
    --env FINNOR_S5_PYTHON=/opt/r3-upstream-runtime/bin/python \
    --env FINNOR_S3_MODEL_STORE=/tmp/r3-models \
    --env FINNOR_S4_POLICY_STORE=/tmp/r3-policies \
    --env WORKER_JOB_LEASE_SECONDS=3 --env OPENBLAS_NUM_THREADS=1 --env OMP_NUM_THREADS=1 \
    --env FINNOR_R3_CASES=authenticated-owner-positive,queued-original-and-r3-physical-restart \
    --env FINNOR_R3_INSTALLED_SOURCE_COMMIT="$FINNOR_COMMIT_SHA" \
    --env FINNOR_R3_EVIDENCE_DIR=/r3-evidence/owner \
    --mount "type=bind,source=$evidence/linux-r3-runtime,target=/r3-evidence" \
    "$image" node --import=tsx scripts/r3/run-owner-e2e.mts \
    > "$evidence/linux-r3-runtime/owner.log" 2>&1; then
    :
  else
    owner_status=$?
    cat "$evidence/linux-r3-runtime/owner.log"
    exit "$owner_status"
  fi
  node - "$evidence/linux-r3-runtime/installed/results.json" "$evidence/linux-r3-runtime/owner/results.json" "$image_id" "$source_tree" "$evidence/linux-r3-runtime" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const installed = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const owner = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const required = ['base-local-migration-upgrade-restart', 'authenticated-owner-positive', 'queued-original-and-r3-physical-restart'];
if (!installed.results?.length || installed.results.some(r => r.status !== "PASS") ||
    !owner.cases?.length || owner.cases.some(r => r.status !== "PASS") ||
    required.some(id => !owner.cases.some(r => r.id === id && r.status === 'PASS')) ||
    owner.qualification !== "SYNTHETIC_ORIGINALS_REAL_HTTP_AUTH_SQL_WORKER_ORDINARY_OWNERS" ||
    owner.protectedAgreement !== false || owner.protectedEffect !== false) {
  console.error("::error::R3 installed runtime/owner proof failed; inspect retained linux-r3-runtime results.json files");
  console.error(JSON.stringify({ cases: owner.cases?.map(r => ({id:r.id,status:r.status})), missing: required.filter(id => !owner.cases?.some(r => r.id === id)) }));
  process.exit(1);
}
fs.writeFileSync(path.join(process.argv[6], "receipt.json"), JSON.stringify({
  schema: "finnor.r3.image-owner-proof.v1", status: "PASS",
  imageId: process.argv[4], sourceTree: process.argv[5],
  installedResults: installed.results, ownerCases: owner.cases,
  qualification: owner.qualification, protectedAgreement: owner.protectedAgreement,
  protectedEffect: owner.protectedEffect
}, null, 2) + "\n");
NODE
fi
) &
owner_pid=$!
if wait "$owner_pid"; then :; else owner_failures=1; fi

# R4 must execute its installed separate runtime and real owners too. Its
# absence on the isolated R1 cut is not permission to skip it on joined cuts.
(
if [[ -f finnor-os/scripts/r4/run-integrated.mts ]]; then
  mkdir -p "$evidence/linux-r4-runtime"
  chmod 2770 "$evidence/linux-r4-runtime"
  if docker run --rm --network none --user 1000:1000 --group-add "$(id -g)" \
    --env HOME=/tmp --env NODE_ENV=test --env CI=1 --env LOG_LEVEL=silent \
    --env AUTH_DEV_BYPASS=0 --env FINNOR_P4_PROFILE=ordinary_disposable \
    --env FINNOR_COMMIT_SHA="$FINNOR_COMMIT_SHA" \
    --env FINNOR_BUILD_ID="$FINNOR_BUILD_ID" --env FINNOR_VERSION="$FINNOR_VERSION" \
    --env FINNOR_RELEASE_SOURCE=ordinary-image-verification \
    --env FINNOR_R4_PACKAGED_SOURCE=1 --env FINNOR_R4_IMAGE_ID="$image_id" \
    --env FINNOR_R4_SOURCE_TREE="$source_tree" \
    --mount "type=bind,source=$evidence/linux-r4-runtime,target=/r4-evidence" \
    "$image" node --import=tsx scripts/r4/run-integrated.mts --output /r4-evidence/owner \
    > "$evidence/linux-r4-runtime/runner.log" 2>&1; then
    :
  else
    runtime_status=$?
    cat "$evidence/linux-r4-runtime/runner.log"
    exit "$runtime_status"
  fi
  # The non-root owner creates private directories. Return only this disposable
  # evidence to the host before reading it, not just later in the EXIT trap.
  docker run --rm --network none --user 0:0 --entrypoint chown \
    --mount "type=bind,source=$evidence/linux-r4-runtime,target=/r4-evidence" \
    "$image" -R "$(id -u):$(id -g)" /r4-evidence
  node - "$evidence/linux-r4-runtime/owner/results.json" "$evidence/linux-r4-runtime/owner/freeze.json" "$image_id" "$source_tree" <<'NODE'
const fs = require("node:fs");
const receipt = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const freeze = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (receipt.results.length !== 5 || receipt.results.some(r => r.status !== "PASS") ||
    freeze.packagedSource !== true || freeze.head !== process.env.FINNOR_COMMIT_SHA ||
    freeze.imageId !== process.argv[4] || freeze.tree !== process.argv[5] ||
    !/^sha256:[0-9a-f]{64}$/.test(freeze.imageId)) {
  console.error("::error::R4 installed owner proof or exact image/source binding failed; inspect retained linux-r4-runtime/owner results.json and freeze.json");
  process.exit(1);
}
NODE
  cp "$evidence/linux-r4-runtime/owner/results.json" "$evidence/linux-r4-runtime/results.json"
fi
) &
owner_pid=$!
if wait "$owner_pid"; then :; else owner_failures=1; fi
exit "$owner_failures"
