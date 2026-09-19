#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
COMPOSE_FILE="$ROOT/tools/gate3/compose.yaml"
STATE_DIR="$ROOT/artifacts/gate3"
IMAGE="${GATE3_BACKEND_IMAGE:-smartlearning-backend:qa1-rc-b9bcd2b}"
EXPECTED_IMAGE_ID="${GATE3_EXPECTED_IMAGE_ID:-sha256:8a6fd6da7aa42f3116b739388318f7046226090179dd3ae996043ea136cd6cfd}"
DB_CONTAINER="smart-learning-pg-test"
DB_NETWORK=""
RUN_ID="${GATE3_RUN_ID:-}"
PROJECT=""
NETWORK=""
PUBLISH_NETWORK=""
PUBLISH_NETWORK_CREATED="0"
ARTIFACT_DIR=""
SECRET_DIR=""
LIFECYCLE_STATUS=""
PRESERVE_ON_FAILURE="${GATE3_PRESERVE_ON_FAILURE:-0}"
STARTED_AT_UTC=""
UPDATED_AT_UTC=""
FAILURE_REASON=""
CLEANUP_FAILURES=""
CURRENT_PHASE="initial"
UPDATE_CURRENT="1"
QA_A_PORT="${GATE3_QA_A_PORT:-3101}"
QA_B_PORT="${GATE3_QA_B_PORT:-3102}"

log() { printf '[gate3] %s\n' "$*"; }
fail() { printf '[gate3] ERROR: %s\n' "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "required tool unavailable: $1"; }
valid_run_id() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{7,63}$ ]]; }
compose() {
  RUN_ID="$RUN_ID" \
    GATE3_BACKEND_IMAGE="$IMAGE" \
    GATE3_QA_A_PORT="$QA_A_PORT" \
    GATE3_QA_B_PORT="$QA_B_PORT" \
    GATE3_SECRET_HOST_DIR="${SECRET_DIR:-/tmp/gate3-pending-${RUN_ID}}" \
    docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" "$@"
}

new_run_id() {
  if [[ -z "$RUN_ID" ]]; then
    RUN_ID="$(date -u +%Y%m%d-%H%M%S)-$(openssl rand -hex 3)"
  fi
  valid_run_id "$RUN_ID" || fail "invalid RUN_ID: $RUN_ID"
  PROJECT="gate3-${RUN_ID}"
  ARTIFACT_DIR="$STATE_DIR/$RUN_ID"
  NETWORK="${PROJECT}_gate3"
  PUBLISH_NETWORK="${PROJECT}_gate3-publish"
}

load_state() {
  local run_file requested="${GATE3_RUN_ID:-}"
  if [[ -n "$requested" ]]; then
    valid_run_id "$requested" || fail "invalid GATE3_RUN_ID: $requested"
    run_file="$STATE_DIR/$requested/state.env"
    UPDATE_CURRENT="0"
  else
    run_file="$STATE_DIR/current"
    UPDATE_CURRENT="1"
  fi
  [[ -r "$run_file" ]] || fail "no Gate3 state for run: ${requested:-current}"
  # shellcheck disable=SC1090
  source "$run_file"
  valid_run_id "$RUN_ID" || fail 'invalid persisted RUN_ID'
  [[ -z "$requested" || "$RUN_ID" == "$requested" ]] || fail 'persisted RUN_ID does not match requested run'
  PROJECT="gate3-${RUN_ID}"
  ARTIFACT_DIR="$STATE_DIR/$RUN_ID"
  NETWORK="${PROJECT}_gate3"
  PUBLISH_NETWORK="${PROJECT}_gate3-publish"
  CLEANUP_FAILURES="${CLEANUP_FAILURES:-}"
  CURRENT_PHASE="${CURRENT_PHASE:-unknown}"
  PUBLISH_NETWORK_CREATED="${PUBLISH_NETWORK_CREATED:-0}"
  export RUN_ID GATE3_BACKEND_IMAGE="$IMAGE" GATE3_QA_A_PORT="$QA_A_PORT" GATE3_QA_B_PORT="$QA_B_PORT" GATE3_SECRET_HOST_DIR="${SECRET_DIR:-/tmp/unused}"
}

write_state() {
  umask 077
  mkdir -p "$ARTIFACT_DIR"
  local tmp="$ARTIFACT_DIR/.state.env.$$"
  printf 'RUN_ID=%q\nPROJECT=%q\nARTIFACT_DIR=%q\nSECRET_DIR=%q\nQA_A_PORT=%q\nQA_B_PORT=%q\nDB_CONTAINER=%q\nDB_NETWORK=%q\nNETWORK=%q\nPUBLISH_NETWORK=%q\nPUBLISH_NETWORK_CREATED=%q\nLIFECYCLE_STATUS=%q\nPRESERVE_ON_FAILURE=%q\nSTARTED_AT_UTC=%q\nUPDATED_AT_UTC=%q\nFAILURE_REASON=%q\nCLEANUP_FAILURES=%q\nCURRENT_PHASE=%q\n' \
    "$RUN_ID" "$PROJECT" "$ARTIFACT_DIR" "$SECRET_DIR" "$QA_A_PORT" "$QA_B_PORT" "$DB_CONTAINER" "$DB_NETWORK" "$NETWORK" "$PUBLISH_NETWORK" "$PUBLISH_NETWORK_CREATED" "$LIFECYCLE_STATUS" "$PRESERVE_ON_FAILURE" "$STARTED_AT_UTC" "$UPDATED_AT_UTC" "$FAILURE_REASON" "$CLEANUP_FAILURES" "$CURRENT_PHASE" > "$tmp"
  mv -f -- "$tmp" "$ARTIFACT_DIR/state.env"
  if [[ "$LIFECYCLE_STATUS" != down && "$UPDATE_CURRENT" == 1 ]]; then
    cp "$ARTIFACT_DIR/state.env" "$STATE_DIR/current"
  fi
}

assert_fresh_run_identity() {
  [[ ! -e "$ARTIFACT_DIR" ]] || fail "Gate3 run artifacts already exist: $ARTIFACT_DIR"
  [[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ]] || fail "Gate3 Compose project already exists: $PROJECT"
  ! docker network inspect "$NETWORK" >/dev/null 2>&1 || fail "Gate3 private network already exists: $NETWORK"
  ! docker network inspect "$PUBLISH_NETWORK" >/dev/null 2>&1 || fail "Gate3 publish network already exists: $PUBLISH_NETWORK"
  ! docker volume inspect "${PROJECT}_gate3-secrets" >/dev/null 2>&1 || fail "Gate3 secret volume already exists: ${PROJECT}_gate3-secrets"
}

preflight() {
  [[ "$PRESERVE_ON_FAILURE" == 0 || "$PRESERVE_ON_FAILURE" == 1 ]] || fail 'GATE3_PRESERVE_ON_FAILURE must be 0 or 1'
  require_cmd docker; require_cmd openssl; require_cmd curl; require_cmd jq; require_cmd ss
  [[ -f "$COMPOSE_FILE" ]] || fail "missing Compose file"
  [[ "$PWD" == "$ROOT" ]] || fail "run from backend repository: $ROOT"
  docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable'
  docker compose version >/dev/null 2>&1 || fail 'docker compose is unavailable'
  assert_fresh_run_identity
  docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "backend image missing: $IMAGE"
  docker image inspect "${GATE3_PROBE_IMAGE:-busybox:1.36}" >/dev/null 2>&1 || fail "probe image missing: ${GATE3_PROBE_IMAGE:-busybox:1.36}"
  local image_id image_user uid gid
  image_id="$(docker image inspect "$IMAGE" --format '{{.Id}}')"
  [[ "$image_id" == "$EXPECTED_IMAGE_ID" ]] || fail "image ID mismatch: $image_id"
  image_user="$(docker image inspect "$IMAGE" --format '{{.Config.User}}')"
  [[ "$image_user" == nodejs ]] || fail "image user is not nodejs: $image_user"
  uid="$(docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'id -u nodejs')"
  gid="$(docker run --rm --entrypoint /bin/sh "$IMAGE" -c 'id -g nodejs')"
  [[ "$uid:$gid" == 999:999 ]] || fail "unexpected nodejs identity: $uid:$gid"
  docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || fail "missing external test DB: $DB_CONTAINER"
  local db_name
  db_name="$(docker inspect "$DB_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^POSTGRES_DB=' | cut -d= -f2-)"
  [[ "$db_name" == smartlearning_test ]] || fail "external DB is not smartlearning_test"
  local dev_name
  dev_name="$(docker inspect smartlearning-db --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep '^POSTGRES_DB=' | cut -d= -f2- || true)"
  [[ "$dev_name" != smartlearning_test ]] || fail 'development DB identity overlaps test DB'
  DB_NETWORK="$(docker inspect "$DB_CONTAINER" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' | grep -v '^$' | head -n1)"
  [[ -n "$DB_NETWORK" ]] || fail 'test DB has no network'
  for port in "$QA_A_PORT" "$QA_B_PORT"; do
    [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1024 && port <= 65535)) || fail "invalid port: $port"
    ! (ss -ltn 2>/dev/null | grep -qE ":${port}[[:space:]]") || fail "port already listening: $port"
  done
  mkdir -p "$STATE_DIR"
  [[ -w "$STATE_DIR" ]] || fail 'artifact directory is not writable'
  log "preflight PASS image=$image_id nodejs=$uid:$gid db=$db_name db_network=$DB_NETWORK"
}

capture_lifecycle_start() {
  mkdir -p "$ARTIFACT_DIR"
  {
    printf 'RUN_ID=%s\nUTC=%s\nLOCAL=%s\n' "$RUN_ID" "$(date -u +%FT%TZ)" "$(date +%FT%T%z)"
    printf '\n-- uname --\n'; uname -a
    printf '\n-- uptime --\n'; uptime || true
    printf '\n-- ip addr summary --\n'; ip -brief addr || true
    printf '\n-- ip route --\n'; ip route || true
    printf '\n-- wsl version --\n'; wsl.exe --version 2>&1 || true
    printf '\n-- wsl status --\n'; wsl.exe --status 2>&1 || true
    printf '\n-- docker version --\n'; docker version --format '{{json .}}' 2>&1 || true
    printf '\n-- docker context --\n'; docker context show 2>&1 || true
    printf '\n-- docker info --\n'; docker info --format 'ServerVersion={{.ServerVersion}}\nOperatingSystem={{.OperatingSystem}}\nKernelVersion={{.KernelVersion}}\nName={{.Name}}' 2>&1 || true
    if command -v rdctl >/dev/null 2>&1; then printf '\n-- rdctl version --\n'; rdctl version 2>&1 || true; fi
  } > "$ARTIFACT_DIR/environment.txt"
  : > "$ARTIFACT_DIR/docker-events.jsonl"
  (docker events --format '{{json .}}' --filter "label=com.smartlearning.gate3.run-id=$RUN_ID" \
      --filter type=container --filter type=network > "$ARTIFACT_DIR/docker-events.jsonl" 2>"$ARTIFACT_DIR/docker-events.stderr" || printf 'EVENT_WATCHER_INTERRUPTED\n' >> "$ARTIFACT_DIR/docker-events.jsonl") &
  printf '%s\n' "$!" > "$ARTIFACT_DIR/docker-events.pid"
  printf 'timestamp_utc\tservice\tcontainer_id\tstate\thealth\tdocker\n' > "$ARTIFACT_DIR/heartbeat.tsv"
  (while :; do
     docker info >/dev/null 2>&1 && d=available || d=unavailable
     for service in qa-a qa-b redis; do
       cid="$(compose ps -q "$service" 2>/dev/null || true)"
       if [[ -z "$cid" ]]; then
         state=absent; health=absent
       else
         state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || printf unknown)"
         health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' "$cid" 2>/dev/null || printf unknown)"
       fi
       printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$service" "${cid:-absent}" "$state" "$health" "$d" >> "$ARTIFACT_DIR/heartbeat.tsv"
     done
     sleep 2
   done) &
  printf '%s\n' "$!" > "$ARTIFACT_DIR/heartbeat.pid"
}

allocate_secret_dir() {
  SECRET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gate3-secrets-${RUN_ID}.XXXXXX")"
  chmod 700 "$SECRET_DIR"
  write_state
}

populate_secrets() {
  local db_user db_password encoded_user encoded_password
  db_user="$(docker inspect "$DB_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^POSTGRES_USER=' | cut -d= -f2-)"
  db_password="$(docker inspect "$DB_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^POSTGRES_PASSWORD=' | cut -d= -f2-)"
  [[ -n "$db_user" && -n "$db_password" ]] || fail 'test DB credentials are not available from container metadata'
  encoded_user="$(printf '%s' "$db_user" | jq -sRr @uri)"
  encoded_password="$(printf '%s' "$db_password" | jq -sRr @uri)"
  printf 'postgresql://%s:%s@smart-learning-pg-test:5432/smartlearning_test?schema=public\n' "$encoded_user" "$encoded_password" > "$SECRET_DIR/database_url"
  openssl rand -base64 32 > "$SECRET_DIR/cookie_secret"
  openssl rand -base64 32 > "$SECRET_DIR/login_rate_limit_key_secret"
  chmod 600 "$SECRET_DIR"/*
}

wait_for_qa_health() {
  local service cid
  : > "$ARTIFACT_DIR/private-readiness.txt"
  for service in qa-a qa-b; do
    for _ in $(seq 1 60); do
      cid="$(compose ps -q "$service")"
      [[ -n "$cid" ]] && docker inspect "$cid" --format '{{if eq .State.Health.Status "healthy"}}yes{{end}}' | grep -q yes && break
      sleep 1
    done
    cid="$(compose ps -q "$service")"
    [[ -n "$cid" ]] && docker inspect "$cid" --format '{{if eq .State.Health.Status "healthy"}}yes{{end}}' | grep -q yes || fail "readiness failed on $service"
    docker exec "$cid" node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" || fail "HTTP readiness failed on $service"
    printf '%s docker_health=healthy http_ready=200 db_bearing_readiness=PASS\n' "$service" >> "$ARTIFACT_DIR/private-readiness.txt"
  done
}

sanitized_runtime_inspect() {
  local cid="$1" output="$2"
  docker inspect "$cid" | jq '.[0] | {HostConfig:{NetworkMode:.HostConfig.NetworkMode,PortBindings:.HostConfig.PortBindings,PublishAllPorts:.HostConfig.PublishAllPorts,Links:.HostConfig.Links,ExtraHosts:.HostConfig.ExtraHosts,DNS:.HostConfig.Dns,Privileged:.HostConfig.Privileged,UsernsMode:.HostConfig.UsernsMode},Config:{ExposedPorts:.Config.ExposedPorts,Labels:.Config.Labels,User:.Config.User,Entrypoint:.Config.Entrypoint,Cmd:.Config.Cmd},NetworkSettings:{Ports:.NetworkSettings.Ports,Networks:(.NetworkSettings.Networks|with_entries(.value |= {NetworkID,EndpointID,Gateway,IPAddress,IPPrefixLen,MacAddress})),SandboxID:.NetworkSettings.SandboxID,SandboxKey:.NetworkSettings.SandboxKey},State:{Status:.State.Status,Health:.State.Health.Status}}' > "$output"
}

capture_route() {
  local cid="$1" output="$2"
  docker exec "$cid" node -e '
const fs=require("fs");
const lines=fs.readFileSync("/proc/net/route","utf8").trim().split(/\n/).slice(1);
const decode=(hex)=>{const bytes=hex.match(/../g).map(v=>parseInt(v,16)).reverse();return bytes.join(".")};
const routes=lines.filter(Boolean).map(line=>{const c=line.trim().split(/\s+/);return {iface:c[0],destinationHex:c[1],gatewayHex:c[2],gateway:decode(c[2]),flags:c[3],maskHex:c[7]}});
process.stdout.write(JSON.stringify({routes,defaults:routes.filter(r=>r.destinationHex==="00000000")},null,2)+"\n");
' > "$output"
}

assert_private_boundaries() {
  local redis_id db_networks
  redis_id="$(compose ps -q redis)"
  [[ -n "$redis_id" ]] || fail 'missing Redis container'
  docker inspect "$redis_id" --format '{{json .NetworkSettings.Networks}}' | jq -e --arg internal "$NETWORK" --arg publish "$PUBLISH_NETWORK" 'has($internal) and (keys | length == 1) and (has($publish) | not)' >/dev/null || fail 'Redis network boundary mismatch'
  db_networks="$(docker inspect "$DB_CONTAINER" --format '{{json .NetworkSettings.Networks}}')"
  printf '%s\n' "$db_networks" | jq -e --arg internal "$NETWORK" --arg publish "$PUBLISH_NETWORK" 'has($internal) and (has($publish) | not)' >/dev/null || fail 'DB network boundary mismatch'
}

private_runtime_topology_check() {
  local service expected_port cid inspect networks requested_ip requested_port
  for service in qa-a qa-b; do
    expected_port="$QA_A_PORT"
    [[ "$service" == qa-b ]] && expected_port="$QA_B_PORT"
    cid="$(compose ps -q "$service")"
    [[ -n "$cid" ]] || fail "missing container for $service"
    inspect="$(docker inspect "$cid")"
    sanitized_runtime_inspect "$cid" "$ARTIFACT_DIR/${service}-runtime-private.json"
    networks="$(printf '%s\n' "$inspect" | jq -r '.[0].NetworkSettings.Networks | keys[]' | sort)"
    [[ "$networks" == "$NETWORK" ]] || fail "$service private network membership mismatch: $networks"
    printf '%s\n' "$inspect" | jq -e --arg network "$NETWORK" '.[0].State.Status == "running" and .[0].State.Health.Status == "healthy" and (.[0].NetworkSettings.Networks[$network].Gateway // "") == ""' >/dev/null || fail "$service private runtime state mismatch"
    requested_ip="$(printf '%s\n' "$inspect" | jq -r '.[0].HostConfig.PortBindings["3000/tcp"][0].HostIp // empty')"
    requested_port="$(printf '%s\n' "$inspect" | jq -r '.[0].HostConfig.PortBindings["3000/tcp"][0].HostPort // empty')"
    [[ "$requested_ip" == 127.0.0.1 && "$requested_port" == "$expected_port" ]] || fail "$service requested binding mismatch: $requested_ip:$requested_port"
    capture_route "$cid" "$ARTIFACT_DIR/${service}-route-private.json"
    jq -e '.defaults | length == 0' "$ARTIFACT_DIR/${service}-route-private.json" >/dev/null || fail "$service unexpectedly has a private-phase default route"
  done
  assert_private_boundaries
  docker network inspect "$NETWORK" > "$ARTIFACT_DIR/backend-network-private.json"
  if docker network inspect "$PUBLISH_NETWORK" > "$ARTIFACT_DIR/publish-network-private.json" 2>"$ARTIFACT_DIR/publish-network-private.stderr"; then
    jq -e '.[0].Containers == null or (.[0].Containers | length == 0)' "$ARTIFACT_DIR/publish-network-private.json" >/dev/null || fail 'publish network has members before QA attachment'
  fi
  docker inspect "$DB_CONTAINER" --format '{{json .NetworkSettings.Networks}}' > "$ARTIFACT_DIR/db-networks-private.json"
  printf 'phase=private\nbackend_network=%s\npublish_network=%s\nqa_publish_member=NO\nredis_publish_member=NO\ndb_publish_member=NO\n' "$NETWORK" "$PUBLISH_NETWORK" > "$ARTIFACT_DIR/topology-private.txt"
}

ensure_publish_network() {
  if docker network inspect "$PUBLISH_NETWORK" >/dev/null 2>&1; then
    fail "publish network already exists before this run created it: $PUBLISH_NETWORK"
  fi
  docker network create --driver bridge \
    --label com.docker.compose.project="$PROJECT" \
    --label com.docker.compose.network=gate3-publish \
    --label com.smartlearning.gate3='true' \
    --label com.smartlearning.gate3.run-id="$RUN_ID" \
    "$PUBLISH_NETWORK" >/dev/null
  PUBLISH_NETWORK_CREATED=1
  write_state
}

attach_qa_publish_network() {
  local service cid
  ensure_publish_network
  assert_private_boundaries
  : > "$ARTIFACT_DIR/publish-attachment.tsv"
  for service in qa-a qa-b; do
    cid="$(compose ps -q "$service")"
    [[ -n "$cid" ]] || fail "missing container for $service"
    docker inspect "$cid" --format '{{if and (eq .State.Status "running") (eq .State.Health.Status "healthy")}}yes{{end}}' | grep -q yes || fail "$service is not healthy before publish attachment"
    if docker inspect "$cid" --format '{{json .NetworkSettings.Networks}}' | jq -e --arg publish "$PUBLISH_NETWORK" 'has($publish)' >/dev/null; then
      printf '%s\t%s\talready-attached\n' "$service" "$cid" >> "$ARTIFACT_DIR/publish-attachment.tsv"
      continue
    fi
    docker network connect "$PUBLISH_NETWORK" "$cid"
    printf '%s\t%s\tattached\n' "$service" "$cid" >> "$ARTIFACT_DIR/publish-attachment.tsv"
  done
}

published_runtime_topology_check() {
  local service expected_port cid inspect networks expected_networks ports binding host_ip host_port publish_gateway route_gateway
  for service in qa-a qa-b; do
    expected_port="$QA_A_PORT"
    [[ "$service" == qa-b ]] && expected_port="$QA_B_PORT"
    cid="$(compose ps -q "$service")"
    [[ -n "$cid" ]] || fail "missing container for $service"
    inspect="$(docker inspect "$cid")"
    sanitized_runtime_inspect "$cid" "$ARTIFACT_DIR/${service}-runtime-published.json"
    networks="$(printf '%s\n' "$inspect" | jq -r '.[0].NetworkSettings.Networks | keys[]' | sort)"
    expected_networks="$(printf '%s\n%s\n' "$NETWORK" "$PUBLISH_NETWORK" | sort)"
    [[ "$networks" == "$expected_networks" ]] || fail "$service published network membership mismatch: $networks"
    printf '%s\n' "$inspect" | jq -e --arg internal "$NETWORK" '((.[0].NetworkSettings.Networks[$internal].Gateway // "") == "")' >/dev/null || fail "$service internal network unexpectedly has a gateway"
    publish_gateway="$(printf '%s\n' "$inspect" | jq -r --arg publish "$PUBLISH_NETWORK" '.[0].NetworkSettings.Networks[$publish].Gateway // empty')"
    [[ -n "$publish_gateway" ]] || fail "$service publish gateway is missing"
    capture_route "$cid" "$ARTIFACT_DIR/${service}-route-published.json"
    [[ "$(jq -r '.defaults | length' "$ARTIFACT_DIR/${service}-route-published.json")" == 1 ]] || fail "$service published phase does not have exactly one default route"
    route_gateway="$(jq -r '.defaults[0].gateway' "$ARTIFACT_DIR/${service}-route-published.json")"
    [[ "$route_gateway" == "$publish_gateway" ]] || fail "$service default route gateway mismatch: $route_gateway != $publish_gateway"
    ports="$(printf '%s\n' "$inspect" | jq -e '.[0].NetworkSettings.Ports["3000/tcp"]')" || fail "$service published port is not materialized"
    binding="$(printf '%s\n' "$ports" | jq -e '.[0]')" || fail "$service published binding is missing"
    host_ip="$(printf '%s\n' "$binding" | jq -r '.HostIp')"
    host_port="$(printf '%s\n' "$binding" | jq -r '.HostPort')"
    [[ "$host_ip" == 127.0.0.1 && "$host_port" == "$expected_port" ]] || fail "$service published binding mismatch: $host_ip:$host_port"
    [[ "$(compose port "$service" 3000)" == "127.0.0.1:$expected_port" ]] || fail "$service compose port mismatch"
  done
  assert_private_boundaries
  docker network inspect "$NETWORK" > "$ARTIFACT_DIR/backend-network-published.json"
  docker network inspect "$PUBLISH_NETWORK" > "$ARTIFACT_DIR/publish-network-published.json"
  docker inspect "$DB_CONTAINER" --format '{{json .NetworkSettings.Networks}}' > "$ARTIFACT_DIR/db-networks-published.json"
  printf 'phase=published\nbackend_network=%s\npublish_network=%s\nqa_publish_member=YES\nredis_publish_member=NO\ndb_publish_member=NO\n' "$NETWORK" "$PUBLISH_NETWORK" > "$ARTIFACT_DIR/topology-published.txt"
}

metadata_check() {
  for service in qa-a qa-b; do
    local cid metadata
    cid="$(compose ps -q "$service")"
    [[ -n "$cid" ]] || fail "missing container for $service"
    metadata="$(docker inspect "$cid")"
    for forbidden in DATABASE_URL COOKIE_SECRET LOGIN_RATE_LIMIT_KEY_SECRET; do
      if printf '%s' "$metadata" | jq -e --arg key "$forbidden" '.[0].Config.Env[]? | startswith($key+"=")' >/dev/null; then
        printf 'GATE3 SECRET METADATA EXPOSURE service=%s key=%s\n' "$service" "$forbidden" >> "$ARTIFACT_DIR/security.txt"
        fail 'GATE3 SECRET METADATA EXPOSURE'
      fi
    done
    docker inspect "$cid" --format "service=$service id={{.Id}} user={{.Config.User}} mounts={{json .Mounts}}" >> "$ARTIFACT_DIR/security.txt"
    [[ "$(docker inspect "$cid" --format '{{.Config.User}}')" != root && "$(docker inspect "$cid" --format '{{.State.Status}}')" == running ]] || fail "$service is root or not running"
  done
}

wait_for_heartbeat_samples() {
  local required=3 valid=0
  for _ in $(seq 1 20); do
    valid="$(awk -F '\t' '$2 == "qa-a" && $3 != "absent" && $4 == "running" && $5 == "healthy" && $6 == "available" { count++ } END { print count + 0 }' "$ARTIFACT_DIR/heartbeat.tsv")"
    if (( valid >= required )); then
      return 0
    fi
    sleep 2
  done
  fail 'heartbeat did not capture three valid qa-a samples'
}

capture_db_membership() {
  local output="$1"
  {
    printf 'db_container=%s\n' "$DB_CONTAINER"
    printf 'db_network_before=%s\n' "$DB_NETWORK"
    printf 'gate3_network=%s\n' "$NETWORK"
    printf 'db_networks='
    docker inspect "$DB_CONTAINER" --format '{{json .NetworkSettings.Networks}}' 2>&1 || printf 'UNAVAILABLE\n'
    printf 'gate3_network_inspect='
    if docker network inspect "$NETWORK" --format '{{json .Containers}}' 2>/dev/null; then :; else printf 'ABSENT\n'; fi
  } > "$output"
}

capture_db_network_names() {
  local output="$1"
  docker inspect "$DB_CONTAINER" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' | sort > "$output"
}

db_is_attached_to_private_network() {
  docker inspect "$DB_CONTAINER" --format '{{json .NetworkSettings.Networks}}' 2>/dev/null | jq -e --arg network "$NETWORK" 'has($network)' >/dev/null
}

stop_sampler() {
  local pid_file="$1" name="$2" pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ -z "$pid" ]] && return 0
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    printf '%s invalid_pid=%s\n' "$name" "$pid" >&2
    return 1
  fi
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

verify_post_down() {
  local output="$ARTIFACT_DIR/post-down.txt" ids project_ids network_present publish_network_present volume_present db_networks
  ids="$(docker ps -aq --filter "label=com.smartlearning.gate3.run-id=$RUN_ID")" || return 1
  project_ids="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" || return 1
  network_present=YES; docker network inspect "$NETWORK" >/dev/null 2>&1 || network_present=NO
  publish_network_present=YES; docker network inspect "$PUBLISH_NETWORK" >/dev/null 2>&1 || publish_network_present=NO
  volume_present=YES; docker volume inspect "${PROJECT}_gate3-secrets" >/dev/null 2>&1 || volume_present=NO
  db_networks="$(docker inspect "$DB_CONTAINER" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}')" || return 1
  local db_state db_health
  db_state="$(docker inspect "$DB_CONTAINER" --format '{{.State.Status}}')" || return 1
  db_health="$(docker inspect "$DB_CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}')" || return 1
  {
    printf 'run_label_container_count=%s\n' "$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l)"
    printf 'project_label_container_count=%s\n' "$(printf '%s\n' "$project_ids" | sed '/^$/d' | wc -l)"
    printf 'network_present=%s\npublish_network_present=%s\nsecret_volume_present=%s\n' "$network_present" "$publish_network_present" "$volume_present"
    printf 'db_present=YES\ndb_state=%s\ndb_health=%s\ndb_gate3_network_member=%s\n' "$db_state" "$db_health" "$(printf '%s\n' "$db_networks" | grep -Fxq "$NETWORK" && printf YES || printf NO)"
    printf 'db_networks_after<<EOF\n%sEOF\n' "$db_networks"
  } > "$output"
  [[ -z "$ids" && -z "$project_ids" && "$network_present" == NO && "$publish_network_present" == NO && "$volume_present" == NO ]] || { printf 'post-down Gate3 resources remain\n' >&2; return 1; }
  [[ "$db_state" == running ]] || { printf 'protected test DB is not running after Gate3 teardown\n' >&2; return 1; }
  if printf '%s\n' "$db_networks" | grep -Fxq "$NETWORK"; then
    printf 'test DB remains attached to Gate3 network\n' >&2
    return 1
  fi
  printf 'result=PASS\n' >> "$output"
}

append_cleanup_failure() {
  local step="$1"
  CLEANUP_FAILURES="${CLEANUP_FAILURES:+$CLEANUP_FAILURES,}$step"
  printf '%s\tFAIL\n' "$step" >> "$ARTIFACT_DIR/cleanup.tsv"
}

remove_publish_network() {
  local inspect containers names
  # Publish network removal is identity-verified from the network itself, not from
  # PUBLISH_NETWORK_CREATED: Compose may materialize the project-scoped gate3-publish
  # network independently of ensure_publish_network, so the flag is not authoritative.
  if ! inspect="$(docker network inspect "$PUBLISH_NETWORK" 2>/dev/null)"; then
    printf '%s\tALREADY-ABSENT\n' "$PUBLISH_NETWORK" >> "$ARTIFACT_DIR/cleanup-publish-network.tsv"
    PUBLISH_NETWORK_CREATED=0
    return 0
  fi
  printf '%s\n' "$inspect" | jq '.[0] | {Name,Id,Labels,Containers:(.Containers // {} | with_entries(.value |= {Name,EndpointID,MacAddress,IPv4Address,IPv6Address}))}' > "$ARTIFACT_DIR/publish-network-before-remove.json"
  if ! printf '%s\n' "$inspect" | jq -e --arg project "$PROJECT" --arg run "$RUN_ID" '.[0].Labels["com.docker.compose.project"] == $project and .[0].Labels["com.docker.compose.network"] == "gate3-publish" and .[0].Labels["com.smartlearning.gate3.run-id"] == $run' >/dev/null; then
    printf '[gate3] ERROR: publish network identity mismatch, refusing removal: %s\n' "$PUBLISH_NETWORK" >&2
    return 1
  fi
  containers="$(printf '%s\n' "$inspect" | jq -r '.[0].Containers // {} | to_entries[] | "\(.key)\t\(.value.Name)"')"
  if [[ -n "$containers" ]]; then
    printf '[gate3] ERROR: cleanup blocked by attached container(s) on %s\n' "$PUBLISH_NETWORK" >&2
    printf '%s\n' "$containers" >&2
    return 1
  fi
  docker network rm "$PUBLISH_NETWORK" >/dev/null
  printf '%s\tREMOVED\n' "$PUBLISH_NETWORK" >> "$ARTIFACT_DIR/cleanup-publish-network.tsv"
  PUBLISH_NETWORK_CREATED=0
}

run_qa_private_publish_lifecycle() {
  CURRENT_PHASE=qa-private-start
  compose up -d qa-a qa-b
  CURRENT_PHASE=qa-private-health
  wait_for_qa_health
  CURRENT_PHASE=qa-private-topology
  private_runtime_topology_check
  CURRENT_PHASE=qa-metadata
  metadata_check
  CURRENT_PHASE=qa-heartbeat
  wait_for_heartbeat_samples
  CURRENT_PHASE=qa-publish-attach
  attach_qa_publish_network
  CURRENT_PHASE=qa-published-topology
  published_runtime_topology_check
  CURRENT_PHASE=source-evidence
  GATE3_SOURCE_PHASE=up "$ROOT/tools/gate3/source-evidence.sh" "$RUN_ID"
}

cleanup_on_error() {
  local code=$?
  trap - ERR
  FAILURE_REASON="up failed in phase ${CURRENT_PHASE:-unknown} with exit code $code"
  LIFECYCLE_STATUS="failed"
  UPDATED_AT_UTC="$(date -u +%FT%TZ)"
  write_state || true
  if [[ "$PRESERVE_ON_FAILURE" == 1 ]]; then
    log "PRESERVED FAILED RUN_ID=$RUN_ID"
  elif [[ -f "$ARTIFACT_DIR/state.env" ]]; then
    GATE3_RUN_ID="$RUN_ID" UPDATE_CURRENT=0
    if ! down; then
      log "automatic cleanup reported failures: ${CLEANUP_FAILURES:-unknown}"
    fi
  fi
  exit "$code"
}

up() {
  new_run_id; preflight
  LIFECYCLE_STATUS="starting"
  PRESERVE_ON_FAILURE="${GATE3_PRESERVE_ON_FAILURE:-0}"
  STARTED_AT_UTC="$(date -u +%FT%TZ)"
  UPDATED_AT_UTC="$STARTED_AT_UTC"
  write_state; trap cleanup_on_error ERR
  export RUN_ID PROJECT GATE3_BACKEND_IMAGE="$IMAGE" GATE3_QA_A_PORT="$QA_A_PORT" GATE3_QA_B_PORT="$QA_B_PORT" GATE3_SECRET_HOST_DIR="/tmp/gate3-pending-${RUN_ID}"
  CURRENT_PHASE=lifecycle-capture
  capture_lifecycle_start
  CURRENT_PHASE=secret-allocation
  allocate_secret_dir
  CURRENT_PHASE=secret-population
  populate_secrets
  export GATE3_SECRET_HOST_DIR="$SECRET_DIR"
  CURRENT_PHASE=compose-render
  compose config > "$ARTIFACT_DIR/rendered-compose.yaml"
  CURRENT_PHASE=secret-init
  compose up -d secret-init
  CURRENT_PHASE=db-private-attach
  capture_db_network_names "$ARTIFACT_DIR/db-network-names-original.txt"
  docker network connect --alias smart-learning-pg-test "$NETWORK" "$DB_CONTAINER"
  write_state
  capture_db_membership "$ARTIFACT_DIR/network-membership-before.txt"
  compose rm -f secret-init >/dev/null
  CURRENT_PHASE=redis-private-start
  compose up -d redis
  for _ in $(seq 1 30); do compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG && break; sleep 1; done
  compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG || fail 'Redis PONG failed'
  printf 'redis_ping=PONG\n' > "$ARTIFACT_DIR/private-dependencies.txt"
  run_qa_private_publish_lifecycle
  CURRENT_PHASE=started
  LIFECYCLE_STATUS="started"
  UPDATED_AT_UTC="$(date -u +%FT%TZ)"
  write_state
  log "UP PASS RUN_ID=$RUN_ID"
}

down() {
  load_state
  local cleanup_status=0 current_networks_file="$ARTIFACT_DIR/db-network-names-after.txt"
  CLEANUP_FAILURES=""
  : > "$ARTIFACT_DIR/cleanup.tsv"

  if ! compose ps -a > "$ARTIFACT_DIR/pre-down-compose-ps.txt" 2>&1; then append_cleanup_failure compose-ps; cleanup_status=1; fi
  for service in qa-a qa-b redis secret-init; do compose logs --no-color "$service" > "$ARTIFACT_DIR/${service}.log" 2>&1 || true; done
  if ! capture_db_membership "$ARTIFACT_DIR/network-membership-before-down.txt"; then append_cleanup_failure db-membership-before; cleanup_status=1; fi
  if ! stop_sampler "$ARTIFACT_DIR/heartbeat.pid" heartbeat; then append_cleanup_failure heartbeat-stop; cleanup_status=1; fi

  if db_is_attached_to_private_network; then
    if ! docker network disconnect "$NETWORK" "$DB_CONTAINER"; then append_cleanup_failure db-disconnect; cleanup_status=1; fi
  fi
  if ! compose down --volumes --remove-orphans; then append_cleanup_failure compose-down; cleanup_status=1; fi
  if ! remove_publish_network; then append_cleanup_failure publish-network-remove; cleanup_status=1; fi

  capture_db_membership "$ARTIFACT_DIR/network-membership-after-down.txt" 2>/dev/null || { append_cleanup_failure db-membership-after; cleanup_status=1; }
  if capture_db_network_names "$current_networks_file"; then
    if [[ -f "$ARTIFACT_DIR/db-network-names-original.txt" ]]; then
      if ! cmp -s "$ARTIFACT_DIR/db-network-names-original.txt" "$current_networks_file"; then append_cleanup_failure db-network-restore; cleanup_status=1; fi
    else
      append_cleanup_failure db-network-original-missing; cleanup_status=1
    fi
  else
    append_cleanup_failure db-network-capture-after; cleanup_status=1
  fi
  if ! stop_sampler "$ARTIFACT_DIR/docker-events.pid" docker-events; then append_cleanup_failure event-stop; cleanup_status=1; fi
  if ! verify_post_down; then append_cleanup_failure post-down-verification; cleanup_status=1; fi
  if [[ -n "$SECRET_DIR" && -e "$SECRET_DIR" ]] && ! rm -rf -- "$SECRET_DIR"; then append_cleanup_failure secret-dir-remove; cleanup_status=1; fi

  if (( cleanup_status == 0 )); then
    LIFECYCLE_STATUS="down"
  else
    LIFECYCLE_STATUS="cleanup-failed"
  fi
  UPDATED_AT_UTC="$(date -u +%FT%TZ)"
  write_state || { append_cleanup_failure state-write; cleanup_status=1; }
  if (( cleanup_status == 0 )) && [[ -r "$STATE_DIR/current" ]] && grep -q "^RUN_ID=$(printf '%q' "$RUN_ID")$" "$STATE_DIR/current"; then
    rm -f "$STATE_DIR/current"
  fi
  if (( cleanup_status != 0 )); then
    printf '[gate3] ERROR: cleanup incomplete: %s\n' "$CLEANUP_FAILURES" >&2
    return 1
  fi
  log "DOWN COMPLETE RUN_ID=$RUN_ID"
}

status() { load_state; compose ps -a; docker network inspect "$NETWORK" --format '{{json .Containers}}' 2>/dev/null || true; docker network inspect "$PUBLISH_NETWORK" --format '{{json .Containers}}' 2>/dev/null || true; }
doctor() { load_state; metadata_check; GATE3_SOURCE_PHASE=doctor "$ROOT/tools/gate3/source-evidence.sh" "$RUN_ID"; }

main() {
  local cmd="${1:-}"
  case "$cmd" in
    preflight) new_run_id; preflight ;;
    up) up ;;
    status) status ;;
    source) load_state; GATE3_SOURCE_PHASE=source "$ROOT/tools/gate3/source-evidence.sh" "$RUN_ID" ;;
    doctor) doctor ;;
    down) down ;;
    *) fail 'usage: gate3.sh {preflight|up|status|source|doctor|down}' ;;
  esac
}

if [[ "${GATE3_LIB_ONLY:-0}" != 1 ]]; then
  main "$@"
fi
