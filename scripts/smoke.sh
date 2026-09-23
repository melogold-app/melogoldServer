#!/bin/sh
# shellcheck disable=SC2016 # single-quoted jq filters use jq variables ($id, $v, …) on purpose
# Smoke test of a built Melogold server image (DESIGN §7.1, §10; PLAN M0 step 0.10).
#
#   scripts/smoke.sh [IMAGE]            # default: $MELOGOLD_IMAGE or melogold-server:local
#
# The container runs as in deploy/templates/compose.yaml (DESIGN §7.2): read-only root, tmpfs /tmp, no capabilities,
# no-new-privileges, init, a named volume on /data, 512m of memory, and NO environment variables: only the image's
# own defaults (SQLite in /data, REGISTRATION=first).
#
# Checks:
#   1. image metadata: nonroot user, entrypoint, labels, HEALTHCHECK, no VOLUME; compressed size (SMOKE_MAX_IMAGE_MB);
#   2. the CLI without the server: `version`, `help`;
#   3. start: Docker reports `healthy` (the image's healthcheck works), no error logs, no "/data is not mounted";
#   4. public API: /health, /health/live, /server/info, /openapi.json, /, unknown route 404, Bearer routes 401;
#   5. register -> login -> POST /sync (like.set). While these routes are M0 stubs (501 not_implemented) the step is
#      skipped with a notice, as PLAN M0 allows;
#   6. graceful stop (SIGTERM, exit code 0), a new container on the same volume: same serverId (database and
#      secret.key survived), the old access token still works and the synced like is still there.
#
# Environment (all optional):
#   SMOKE_PORT=18080              host port on 127.0.0.1
#   SMOKE_PLATFORM=               e.g. linux/amd64 to run an emulated image
#   SMOKE_TIMEOUT=120             seconds to wait for `healthy`
#   SMOKE_MAX_IMAGE_MB=80         fail if the gzip-compressed filesystem is larger (MB = 10^6 bytes); 0 = skip
#   SMOKE_EXPECT_VERSION=         expected /health.version (the APP_VERSION build arg)
#   SMOKE_EXPECT_REVISION=        expected git sha (the GIT_SHA build arg); /server/info.revision is its first 7 chars
#   SMOKE_KEEP=1                  keep the container and the volume for inspection
#
# Requires: docker, curl, jq, gzip. POSIX sh.
set -eu

image=${1:-${MELOGOLD_IMAGE:-melogold-server:local}}
port=${SMOKE_PORT:-18080}
platform=${SMOKE_PLATFORM:-}
timeout=${SMOKE_TIMEOUT:-120}
max_image_mb=${SMOKE_MAX_IMAGE_MB:-80}
expect_version=${SMOKE_EXPECT_VERSION:-}
expect_revision=${SMOKE_EXPECT_REVISION:-}
keep=${SMOKE_KEEP:-0}

run_id="$(date +%s)-$$"
name="melogold-smoke-$run_id"
volume="melogold-smoke-$run_id"
base="http://127.0.0.1:$port"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/melogold-smoke.XXXXXX")
started=$(date +%s)
skipped=""
container_started=0
healthy_after=0

# Test data. The hwid and the opId are fixed: every run starts on a fresh volume.
login="smoketest"
password="Nq7-vR2k-Lp9x-Wt4m"
hwid="5e3a0c1f9b8d7e6a5f4c3b2a1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e"
op_id="3f0c1d2e-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
video_id="dQw4w9WgXcQ"

log() { printf 'smoke: %s\n' "$*"; }
ok() { printf 'smoke: ok    %s\n' "$*"; }
skip() {
  printf 'smoke: SKIP  %s\n' "$*"
  skipped="$skipped
  - $*"
}
fail() {
  printf 'smoke: FAIL  %s\n' "$*" >&2
  exit 1
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ] && docker container inspect "$name" >/dev/null 2>&1; then
    printf '\nsmoke: last container logs:\n' >&2
    docker logs --tail 100 "$name" >&2 2>&1 || true
  fi
  if [ "$keep" = "1" ]; then
    log "kept container $name and volume $volume (SMOKE_KEEP=1)"
  else
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker volume rm -f "$volume" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for tool in docker curl jq gzip; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done

# ----- helpers ------------------------------------------------------------------------------------------------------

# docker run with the platform, when one is given.
docker_run() {
  if [ -n "$platform" ]; then
    docker run --platform "$platform" "$@"
  else
    docker run "$@"
  fi
}

# http METHOD PATH [JSON_BODY]: sets $status; the body is in $tmp/body, the headers in $tmp/headers.
# Optional globals: $token (Authorization: Bearer), $xsp (X-Sync-Protocol).
token=""
xsp=""
http() {
  _method=$1
  _path=$2
  _body=${3-}
  set -- -sS --max-time 30 -o "$tmp/body" -D "$tmp/headers" -w '%{http_code}' -X "$_method" \
    -H 'User-Agent: melogold-linux/0.0.0 (smoke)'
  if [ -n "$token" ]; then set -- "$@" -H "Authorization: Bearer $token"; fi
  if [ -n "$xsp" ]; then set -- "$@" -H "X-Sync-Protocol: $xsp"; fi
  if [ -n "$_body" ]; then set -- "$@" -H 'Content-Type: application/json' --data-binary "$_body"; fi
  status=$(curl "$@" "$base$_path") || status=000
}

body_excerpt() { head -c 600 "$tmp/body" 2>/dev/null || true; }

expect_status() {
  [ "$status" = "$1" ] || fail "$2: expected HTTP $1, got $status: $(body_excerpt)"
}

# expect_json JQ_FILTER WHAT [jq args...]: the filter must yield true on the last body.
expect_json() {
  _filter=$1
  _what=$2
  shift 2
  jq -e "$@" "$_filter" "$tmp/body" >/dev/null 2>&1 || fail "$_what: $(body_excerpt)"
}

# header NAME: the value of a response header of the last request (case-insensitive name).
header() {
  tr -d '\r' <"$tmp/headers" | grep -i "^$1:" | tail -n 1 | sed 's/^[^:]*:[[:space:]]*//'
}

# expect_error STATUS CODE WHAT: an API §2.1 error envelope (exactly the 4 keys unless the code has details).
expect_error() {
  expect_status "$1" "$3"
  expect_json '(.statusCode == $s) and (.code == $c) and (.error | type == "string") and (.message | type == "string")' \
    "$3: error envelope with code $2" --argjson s "$1" --arg c "$2"
}

is_stub() { [ "$status" = "501" ] && jq -e '.code == "not_implemented"' "$tmp/body" >/dev/null 2>&1; }

start_container() {
  container_started=$(date +%s)
  docker_run -d --name "$name" \
    --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --init --memory 512m \
    -v "$volume:/data" -p "127.0.0.1:$port:8080" "$image" >/dev/null
}

wait_healthy() {
  _deadline=$(($(date +%s) + timeout))
  while :; do
    _state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name")
    case $_state in
      "running healthy")
        healthy_after=$(($(date +%s) - container_started))
        return 0
        ;;
      running*) ;;
      *) fail "container is '$_state' instead of running (exit code $(docker inspect -f '{{.State.ExitCode}}' "$name"))" ;;
    esac
    [ "$(date +%s)" -lt "$_deadline" ] || fail "container not healthy after ${timeout}s (state: $_state)"
    sleep 1
  done
}

check_logs() {
  docker logs "$name" >"$tmp/logs" 2>&1
  if grep -q 'is NOT a mounted volume' "$tmp/logs"; then fail "the server did not detect the /data volume"; fi
  if grep -Eq '"level":(50|60)' "$tmp/logs"; then
    grep -E '"level":(50|60)' "$tmp/logs" | head -n 5 >&2
    fail "error-level lines in the server log"
  fi
  if grep -Eqi 'ExperimentalWarning|DeprecationWarning' "$tmp/logs"; then
    grep -Ei 'ExperimentalWarning|DeprecationWarning' "$tmp/logs" | head -n 5 >&2
    fail "Node warnings in the server log"
  fi
}

# ----- 1. image ------------------------------------------------------------------------------------------------------

log "image $image${platform:+ ($platform)}"
docker image inspect "$image" >/dev/null 2>&1 || fail "image $image not found (build it first)"
docker image inspect "$image" --format '{{json .Config}}' >"$tmp/config.json"
jq -e '.User == "65532" or .User == "nonroot" or .User == "65532:65532" or .User == "nonroot:nonroot"' \
  "$tmp/config.json" >/dev/null || fail "image user is not nonroot: $(jq -c .User "$tmp/config.json")"
jq -e '.Entrypoint == ["/usr/local/bin/melogold"] and .Cmd == ["serve"]' "$tmp/config.json" >/dev/null ||
  fail "entrypoint/cmd: $(jq -c '[.Entrypoint, .Cmd]' "$tmp/config.json")"
jq -e '.Labels["org.opencontainers.image.licenses"] == "AGPL-3.0-only" and .Labels["app.melogold.compose-schema"] == "1"
  and (.Labels["org.opencontainers.image.source"] | startswith("https://"))' "$tmp/config.json" >/dev/null ||
  fail "labels: $(jq -c .Labels "$tmp/config.json")"
jq -e '.Healthcheck.Test == ["CMD", "/nodejs/bin/node", "/app/src/healthcheck.ts"]' "$tmp/config.json" >/dev/null ||
  fail "healthcheck: $(jq -c .Healthcheck "$tmp/config.json")"
jq -e '(.Volumes // {}) == {}' "$tmp/config.json" >/dev/null || fail "the image must not declare VOLUME (DESIGN §7.1)"
jq -e '.Env | index("NODE_ENV=production") and index("DATA_DIR=/data") and index("DATABASE_URL=sqlite:///data/melogold.db")' \
  "$tmp/config.json" >/dev/null || fail "image env: $(jq -c .Env "$tmp/config.json")"
ok "metadata: user 65532, entrypoint melogold serve, labels, healthcheck, no VOLUME"

if [ "$max_image_mb" != "0" ]; then
  # Registries store gzip-compressed layers; the compressed flattened filesystem is a close, store-independent estimate.
  _cid=$(if [ -n "$platform" ]; then docker create --platform "$platform" "$image"; else docker create "$image"; fi)
  _bytes=$(docker export "$_cid" | gzip -6 -c | wc -c | tr -d ' ')
  docker rm "$_cid" >/dev/null
  # No pipefail in POSIX sh before 2024: a failed export shows up as an implausibly small archive.
  [ "$_bytes" -gt 10000000 ] || fail "docker export of $image failed (${_bytes} bytes)"
  _mb=$(awk -v b="$_bytes" 'BEGIN { printf "%.1f", b / 1000000 }')
  [ "$_bytes" -le $((max_image_mb * 1000000)) ] || fail "compressed image is ${_mb} MB, the limit is ${max_image_mb} MB"
  ok "compressed size ~${_mb} MB (limit ${max_image_mb} MB)"
fi

# ----- 2. CLI without the server -------------------------------------------------------------------------------------

_out=$(docker_run --rm --network none --read-only "$image" version) || fail "melogold version exited with $?"
case $_out in
  melogold-server\ *) ok "cli: $_out" ;;
  *) fail "melogold version printed: $_out" ;;
esac
if [ -n "$expect_version" ]; then
  case $_out in *" $expect_version "*) ;; *) fail "version: expected $expect_version in '$_out'" ;; esac
fi
docker_run --rm --network none --read-only "$image" help >"$tmp/help" || fail "melogold help exited with $?"
grep -q 'serve' "$tmp/help" || fail "melogold help does not list serve"
ok "cli: help"

# ----- 3. start ------------------------------------------------------------------------------------------------------

docker volume create "$volume" >/dev/null
start_container
wait_healthy
ok "container healthy ${healthy_after}s after start"

# ----- 4. public API -------------------------------------------------------------------------------------------------

http GET /health
expect_status 200 "GET /health"
expect_json '.status == "ok" and .db == "sqlite" and (.version | type == "string")' "GET /health body"
[ -n "$(header X-Request-Id)" ] || fail "GET /health: no X-Request-Id"
case $(header Cache-Control) in *no-store*) ;; *) fail "GET /health: Cache-Control is '$(header Cache-Control)'" ;; esac
if [ -n "$expect_version" ]; then
  expect_json '.version == $v' "GET /health version" --arg v "$expect_version"
fi
ok "GET /health: $(jq -c . "$tmp/body")"

http GET /health/live
expect_status 200 "GET /health/live"
expect_json '. == {"status": "ok"}' "GET /health/live body"
ok "GET /health/live"

http GET /server/info
expect_status 200 "GET /server/info"
expect_json '.software == "melogold-server" and .apiVersion == 1 and .minApiVersion == 1
  and (.serverId | test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))
  and .registration == "open" and .publicUrl == null and .secureTransport == false and .instanceName == "Melogold"
  and (.features | type == "object") and (.limits.sync.maxOpsPerRequest == 500)
  and (.links.source | startswith("https://")) and (.serverTime | test("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"))' \
  "GET /server/info body"
case $(header Cache-Control) in *max-age=60*) ;; *) fail "GET /server/info: Cache-Control is '$(header Cache-Control)'" ;; esac
if [ -n "$expect_revision" ]; then
  _rev=$(printf '%s' "$expect_revision" | cut -c1-7)
  expect_json '.revision == $r' "GET /server/info revision" --arg r "$_rev"
fi
server_id=$(jq -r .serverId "$tmp/body")
ok "GET /server/info: version $(jq -r .version "$tmp/body"), revision $(jq -r .revision "$tmp/body"), serverId $server_id"

http GET /openapi.json
expect_status 200 "GET /openapi.json"
expect_json '.openapi == "3.0.3" and (.paths | length > 30)' "GET /openapi.json"
ok "GET /openapi.json: OpenAPI 3.0.3, $(jq '.paths | length' "$tmp/body") paths"

http GET /
expect_status 200 "GET /"
case $(header Content-Type) in text/html*) ;; *) fail "GET /: Content-Type is '$(header Content-Type)'" ;; esac
ok "GET /: html"

http GET /no-such-route
expect_error 404 not_found "GET /no-such-route"
ok "unknown route: 404 not_found"

http GET /auth/me
expect_error 401 unauthorized "GET /auth/me without a token"
token="invalid"
http GET /auth/me
expect_error 401 access_token_invalid "GET /auth/me with Bearer invalid"
token=""
ok "Bearer routes: 401 unauthorized / access_token_invalid"

# ----- 5. register -> login -> sync ----------------------------------------------------------------------------------

device=$(jq -cn --arg hwid "$hwid" '{hwid: $hwid, name: "Smoke test", platform: "linux", clientVersion: "0.0.0"}')
access=""
synced=0
http POST /auth/register "$(jq -cn --arg l "$login" --arg p "$password" --argjson d "$device" \
  '{login: $l, password: $p, device: $d}')"
if is_stub; then
  skip "register/login/sync: POST /auth/register is a stub (501 not_implemented)"
else
  expect_status 201 "POST /auth/register"
  expect_json '(.tokens.accessToken | type == "string") and (.recoveryCode | type == "string") and .serverId == $id' \
    "POST /auth/register body" --arg id "$server_id"
  ok "POST /auth/register: user $(jq -r .user.login "$tmp/body")"

  http POST /auth/login "$(jq -cn --arg l "$login" --arg p "$password" --argjson d "$device" \
    '{login: $l, password: $p, device: $d}')"
  if is_stub; then
    skip "login/sync: POST /auth/login is a stub (501 not_implemented)"
  else
    expect_status 200 "POST /auth/login"
    expect_json '(.tokens.accessToken | type == "string") and .recoveryCode == null' "POST /auth/login body"
    access=$(jq -r .tokens.accessToken "$tmp/body")
    ok "POST /auth/login"

    token=$access
    xsp=1
    at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    http POST /sync "$(jq -cn --arg op "$op_id" --arg at "$at" --arg v "$video_id" \
      '{cursor: "", ops: [{opId: $op, kind: "like.set", at: $at, videoId: $v, liked: true}]}')"
    if is_stub; then
      skip "sync: POST /sync is a stub (501 not_implemented)"
    else
      expect_status 200 "POST /sync"
      expect_json '.results[0].opId == $op and .results[0].status == "applied"' "POST /sync result" --arg op "$op_id"
      synced=1
      ok "POST /sync: like.set applied"
    fi
    token=""
    xsp=""
  fi
fi

check_logs
ok "logs: no errors, no warnings, /data detected as a volume"

# ----- 6. restart on the same volume ---------------------------------------------------------------------------------

docker stop -t 30 "$name" >/dev/null
_code=$(docker inspect -f '{{.State.ExitCode}}' "$name")
[ "$_code" = "0" ] || fail "graceful stop: exit code $_code instead of 0"
ok "SIGTERM: stopped with exit code 0"
docker rm "$name" >/dev/null
start_container
wait_healthy
ok "new container on the same volume healthy ${healthy_after}s after start"

http GET /server/info
expect_status 200 "GET /server/info after restart"
expect_json '.serverId == $id' "serverId survived the restart" --arg id "$server_id"
ok "serverId unchanged: the database survived"

if [ -n "$access" ]; then
  token=$access
  http GET /auth/me
  if is_stub; then
    skip "GET /auth/me after restart: stub (501 not_implemented)"
  else
    expect_status 200 "GET /auth/me with the old access token after restart"
    expect_json '.user.login == $l' "GET /auth/me body" --arg l "$login"
    ok "old access token accepted: secret.key survived"
  fi
  if [ "$synced" = "1" ]; then
    xsp=1
    http POST /sync '{"cursor":""}'
    expect_status 200 "POST /sync (pull) after restart"
    expect_json 'any(.likes[]; .videoId == $v and .liked == true)' "the like survived the restart" --arg v "$video_id"
    ok "POST /sync after restart: the like is still there"
    xsp=""
  fi
  token=""
fi

check_logs
ok "logs after restart: clean"

if [ -n "$skipped" ]; then
  log "skipped (stubs):$skipped"
fi
log "PASS $image${platform:+ ($platform)} in $(($(date +%s) - started))s"
