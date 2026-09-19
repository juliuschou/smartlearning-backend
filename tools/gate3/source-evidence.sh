#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

# Correlate marker-bearing log lines against the request-completed contract.
#
# Real pino-pretty records render the message OUTSIDE the JSON payload:
#   <compose prefix> [ts] INFO (pid): request completed {"req":{...},"res":{...}}
# so the pretty message is matched on the pre-JSON text and every correlation
# field is read from the JSON object itself (which carries no `.msg` key).
#
# Sets (caller-visible): match_count, source, method, url, logged_status,
# parse_status, reason.
correlate_records() {
  local marker="$1" logs_file="$2" line json prefix
  local msg_re='(^|[[:space:]])request completed$'
  match_count=0
  source='' method='' url='' logged_status=''
  parse_status=none
  reason='marker not found'
  while IFS= read -r line; do
    line="$(printf '%s' "$line" | sed -E $'s/\\x1B\\[[0-9;]*m//g')"
    json="$(printf '%s' "$line" | sed -n 's/^[^{]*\({.*}\).*$/\1/p')"
    if [[ -z "$json" ]]; then parse_status=failed; reason='JSON payload not found'; continue; fi
    parse_status=success
    prefix="$(printf '%s' "${line%%\{*}" | sed -E 's/[[:space:]]+$//')"
    if [[ ! "$prefix" =~ $msg_re ]]; then reason='pretty message mismatch'; continue; fi
    if ! printf '%s' "$json" | jq empty >/dev/null 2>&1; then reason='invalid JSON payload'; continue; fi
    if [[ "$(printf '%s' "$json" | jq -r '.req.headers["x-request-id"] // empty')" != "$marker" ]]; then reason='request ID mismatch'; continue; fi
    if [[ "$(printf '%s' "$json" | jq -r '.res.headers["x-request-id"] // empty')" != "$marker" ]]; then reason='response request ID mismatch'; continue; fi
    if [[ "$(printf '%s' "$json" | jq -r '.req.method // empty')" != GET ]]; then reason='method mismatch'; continue; fi
    if [[ "$(printf '%s' "$json" | jq -r '.req.url // empty')" != /health/live ]]; then reason='URL mismatch'; continue; fi
    if [[ "$(printf '%s' "$json" | jq -r '.res.statusCode // empty')" != 200 ]]; then reason='HTTP status mismatch'; continue; fi
    source="$(printf '%s' "$json" | jq -r '.req.remoteAddress // empty')"
    if [[ -z "$source" || "$source" == null ]]; then reason='missing remoteAddress'; source=''; continue; fi
    match_count=$((match_count + 1)); method=GET; url=/health/live; logged_status=200; reason='valid correlated record'
  done < <(grep -F "$marker" "$logs_file" || true)
  if (( match_count > 1 )); then reason='duplicate correlated records'; fi
}

# Container-free parser regression mode (no Docker/HTTP state required):
#   GATE3_PARSER_ONLY=1 tools/gate3/source-evidence.sh <marker> < <log-file>
# Prints SOURCE_IDENTITY=<addr> and exits 0 on exactly one valid correlated
# record; otherwise prints the rejection reason to stderr and exits 1.
if [[ "${GATE3_PARSER_ONLY:-0}" == "1" ]]; then
  [[ $# -eq 1 ]] || { printf 'usage: GATE3_PARSER_ONLY=1 %s <marker> < logs\n' "${BASH_SOURCE[0]}" >&2; exit 64; }
  correlate_records "$1" /dev/stdin
  if (( match_count == 1 )); then printf 'SOURCE_IDENTITY=%s\n' "$source"; exit 0; fi
  printf 'correlation failed matches=%s reason=%s\n' "$match_count" "$reason" >&2
  exit 1
fi

# Per-probe correlation marker contract — the single generation point:
#   gate3-<RUN_ID>-<service>-<phase>-<nonce>
# Every probe execution (up, source, doctor, and every retry of each) mints a
# fresh marker, so the exactly-one invariant stays per-probe: repeated probes
# in the same RUN_ID never share a marker and never see each other's records.
# The nonce pairs a nanosecond timestamp with cryptographically random bytes,
# so rapid retries cannot collide. Markers are header-safe ([A-Za-z0-9._-]),
# bounded in length, and contain no secrets.
SOURCE_PHASE="${GATE3_SOURCE_PHASE:-source}"
[[ "$SOURCE_PHASE" =~ ^(up|source|doctor)$ ]] || {
  printf 'invalid GATE3_SOURCE_PHASE: %s\n' "$SOURCE_PHASE" >&2
  exit 1
}
probe_marker() {
  local run_id="$1" service="$2" marker nonce
  nonce="$(date +%s%N)-$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  marker="gate3-${run_id}-${service}-${SOURCE_PHASE}-${nonce}"
  [[ ${#marker} -le 200 && "$marker" =~ ^[A-Za-z0-9._-]+$ ]] || {
    printf 'generated marker failed safety validation\n' >&2
    exit 1
  }
  printf '%s' "$marker"
}

RUN_ID="${1:?RUN_ID is required}"
PROJECT="gate3-${RUN_ID}"
COMPOSE_FILE="$ROOT/tools/gate3/compose.yaml"
ARTIFACT_DIR="$ROOT/artifacts/gate3/$RUN_ID"
STATE_FILE="$ARTIFACT_DIR/state.env"
PROBE_HOST="127.0.0.1"
SOURCE_TIMEOUT_SECONDS="${GATE3_SOURCE_TIMEOUT_SECONDS:-8}"
SOURCE_POLL_INTERVAL_SECONDS="${GATE3_SOURCE_POLL_INTERVAL_SECONDS:-1}"
SOURCE_MAX_ATTEMPTS="${GATE3_SOURCE_MAX_ATTEMPTS:-10}"
compose() { docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" "$@"; }

[[ "$SOURCE_TIMEOUT_SECONDS" =~ ^[0-9]+$ && "$SOURCE_POLL_INTERVAL_SECONDS" =~ ^[0-9]+$ && "$SOURCE_MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || {
  printf 'invalid source polling configuration\n' >&2
  exit 1
}
[[ -r "$STATE_FILE" ]] || { printf 'missing Gate3 state for source evidence: %s\n' "$RUN_ID" >&2; exit 1; }
state_run_id="$(grep -m1 '^RUN_ID=' "$STATE_FILE" | cut -d= -f2-)"
QA_A_PORT="$(grep -m1 '^QA_A_PORT=' "$STATE_FILE" | cut -d= -f2-)"
QA_B_PORT="$(grep -m1 '^QA_B_PORT=' "$STATE_FILE" | cut -d= -f2-)"
[[ "$state_run_id" == "$RUN_ID" ]] || { printf 'source evidence state RUN_ID mismatch\n' >&2; exit 1; }
[[ "$QA_A_PORT" =~ ^[0-9]+$ && "$QA_B_PORT" =~ ^[0-9]+$ ]] || { printf 'invalid persisted QA ports\n' >&2; exit 1; }

mkdir -p "$ARTIFACT_DIR"
printf 'service\tprobe_host\tport\tmarker\tphase\tresponse_status\tbody_status\tresponse_id\tmethod\turl\tlogged_status\n' > "$ARTIFACT_DIR/source-probe.tsv"
printf 'run_id\tservice\tphase\tprobe_marker\tattempt\ttimestamp_utc\tmarker_present\tcandidate_count\tjson_parse\tobserved_source\treason\n' > "$ARTIFACT_DIR/source-correlation.tsv"

probe_service() {
  local service="$1" port="$2" marker="$3" headers body response_status response_id body_status
  local attempt=0 match_count=0 source="" method="" url="" logged_status="" reason marker_present parse_status line
  local deadline=$(( $(date +%s) + SOURCE_TIMEOUT_SECONDS ))
  headers="$(mktemp)"; body="$(mktemp)"; local logs; logs="$(mktemp)"
  trap 'rm -f "$headers" "$body" "$logs"' RETURN

  response_status="$(curl --noproxy '*' --fail-with-body --silent --show-error --connect-timeout 3 --max-time 10 \
    --dump-header "$headers" --output "$body" \
    -H "x-request-id: $marker" "http://${PROBE_HOST}:${port}/health/live" \
    -w '%{http_code}' || true)"
  body_status="$(jq -r '.status // empty' "$body" 2>/dev/null || true)"
  response_id="$(awk 'BEGIN{IGNORECASE=1} /^x-request-id:/ {sub(/^[^:]+:[[:space:]]*/, ""); gsub(/\r/, ""); print}' "$headers" | tail -n1)"
  printf 'run_id\tservice\ttimestamp_utc\tdestination\tresponse_status\tbody_status\tmarker\tresponse_id\n' > "$ARTIFACT_DIR/${service}-probe.tsv"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$RUN_ID" "$service" "$(date -u +%FT%TZ)" "$PROBE_HOST:$port" "$response_status" "$body_status" "$marker" "$response_id" >> "$ARTIFACT_DIR/${service}-probe.tsv"
  [[ "$response_status" == 200 ]] || { printf 'external probe failed service=%s status=%s\n' "$service" "$response_status" >&2; return 1; }
  [[ "$body_status" == ok ]] || { printf 'external probe body failed service=%s\n' "$service" >&2; return 1; }
  [[ "$response_id" == "$marker" ]] || { printf 'request id was not echoed service=%s\n' "$service" >&2; return 1; }

  while (( attempt < SOURCE_MAX_ATTEMPTS && $(date +%s) <= deadline )); do
    attempt=$((attempt + 1))
    marker_present=NO; parse_status=none; match_count=0; source=""; method=""; url=""; logged_status=""; reason='marker not found'
    : > "$logs"
    if compose logs --no-color "$service" 2>/dev/null > "$logs"; then :; fi
    grep -Fq "$marker" "$logs" && marker_present=YES || true
    if [[ "$marker_present" == YES ]]; then
      correlate_records "$marker" "$logs"
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$RUN_ID" "$service" "$SOURCE_PHASE" "$marker" "$attempt" "$(date -u +%FT%TZ)" "$marker_present" "$match_count" "$parse_status" "$source" "$reason" >> "$ARTIFACT_DIR/source-correlation.tsv"
    if (( match_count == 1 )); then
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$service" "$PROBE_HOST" "$port" "$marker" "$SOURCE_PHASE" "$response_status" "$body_status" "$response_id" "$method" "$url" "$logged_status" >> "$ARTIFACT_DIR/source-probe.tsv"
      printf '%s' "$source"
      return 0
    fi
    if (( match_count > 1 )); then
      printf 'expected exactly one correlated external log record service=%s matches=%s\n' "$service" "$match_count" >&2
      return 1
    fi
    (( attempt >= SOURCE_MAX_ATTEMPTS )) && break
    sleep "$SOURCE_POLL_INTERVAL_SECONDS"
  done
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$RUN_ID" "$service" "$SOURCE_PHASE" "$marker" "$attempt" "$(date -u +%FT%TZ)" "$marker_present" "$match_count" "$parse_status" "$source" 'bounded timeout' >> "$ARTIFACT_DIR/source-correlation.tsv"
  printf 'expected exactly one correlated external log record service=%s matches=0 reason=bounded timeout\n' "$service" >&2
  return 1
}

resolve_port() {
  local service="$1" expected_port="$2" mapping
  mapping="$(compose port "$service" 3000)"
  [[ "$mapping" =~ ^127\.0\.0\.1:([0-9]+)$ ]] || { printf 'invalid published mapping service=%s mapping=%s\n' "$service" "$mapping" >&2; return 1; }
  [[ "${BASH_REMATCH[1]}" == "$expected_port" ]] || { printf 'published port mismatch service=%s expected=%s actual=%s\n' "$service" "$expected_port" "${BASH_REMATCH[1]}" >&2; return 1; }
  printf '%s' "${BASH_REMATCH[1]}"
}

A_PORT="$(resolve_port qa-a "$QA_A_PORT")"
B_PORT="$(resolve_port qa-b "$QA_B_PORT")"
a_marker="$(probe_marker "$RUN_ID" qa-a)"; b_marker="$(probe_marker "$RUN_ID" qa-b)"
a_id="$(compose ps -q qa-a)"; b_id="$(compose ps -q qa-b)"
a="$(probe_service qa-a "$A_PORT" "$a_marker")"
b="$(probe_service qa-b "$B_PORT" "$b_marker")"
now=$(date -u +%FT%TZ)
{
  printf 'RUN_ID=%s\nTIMESTAMP_UTC=%s\nPROBE_HOST=%s\n' "$RUN_ID" "$now" "$PROBE_HOST"
  printf 'qa-a_port=%s\nqa-a_container=%s\nqa-a_marker=%s\nqa-a_observed_source=%s\n' "$A_PORT" "$a_id" "$a_marker" "$a"
  printf 'qa-b_port=%s\nqa-b_container=%s\nqa-b_marker=%s\nqa-b_observed_source=%s\n' "$B_PORT" "$b_id" "$b_marker" "$b"
  [[ "$a" == "$b" ]] && printf 'same_source=YES\n' || printf 'same_source=NO\n'
} > "$ARTIFACT_DIR/source-evidence.txt"
[[ "$a" == "$b" ]] || { printf 'source identity mismatch\n' >&2; exit 1; }
printf 'SOURCE_IDENTITY=%s\n' "$a"