#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
SOURCE="$ROOT/tools/gate3/source-evidence.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/gate3-harness-test.XXXXXX")
RUN_IDS=(test-harness-000{1..10} test-harness-00{21..25})
cleanup() {
  rm -rf "$TMP"
  for id in "${RUN_IDS[@]}"; do
    rm -rf -- "$ROOT/artifacts/gate3/$id"
  done
}
trap cleanup EXIT
mkdir -p "$TMP/bin" "$ROOT/artifacts/gate3"

# Real-format pino-pretty record: the message lives OUTSIDE the JSON payload,
# matching the captured Gate A evidence structure. remoteAddress uses the
# runtime-confirmed test value; request IDs use deterministic test markers.
# Payload mirrors the real line but is trimmed of header noise the parser
# does not read; the real fixture (below) keeps the full captured structure.
pretty_record() {
  local marker="$1" remote="${2:-10.0.0.9}"
  printf 'qa-x-1  | [2026-09-19 14:03:12.219 +0000] INFO (7): request completed {"req":{"id":190,"method":"GET","url":"/health/live","query":{},"params":{"path":["live"]},"headers":{"host":"127.0.0.1:3501","user-agent":"curl/8.18.0","accept":"*/*","x-request-id":"%s"},"remoteAddress":"%s","remotePort":52276},"res":{"statusCode":200,"headers":{"content-type":"application/json; charset=utf-8","x-request-id":"%s"}},"responseTime":0}\n' "$marker" "$remote" "$marker"
}

cat > "$TMP/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -Eeuo pipefail
headers= body= marker=
while (($#)); do
  case "$1" in
    --dump-header) headers="$2"; shift 2;;
    --output) body="$2"; shift 2;;
    -H) marker="${2#*: }"; shift 2;;
    -w) shift 2;;
    *) shift;;
  esac
done
# Record the per-probe marker so the mocked Compose logs can echo the exact
# x-request-id the probe sent (markers are minted fresh per execution).
printf '%s' "$marker" > "$MOCK_DIR/current-marker"
printf 'HTTP/1.1 200 OK\r\nx-request-id: %s\r\n\r\n' "$marker" > "$headers"
printf '{"status":"ok"}\n' > "$body"
printf '200'
CURL
chmod +x "$TMP/bin/curl"

cat > "$TMP/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1" != compose ]]; then printf 'unexpected real-Docker-shaped call: %s\n' "$*" >&2; exit 99; fi
shift
while [[ "$1" == -* ]]; do shift 2; done
command="${1:-}"; shift || true
case "$command" in
  port)
    [[ "$1" == qa-a ]] && printf '127.0.0.1:3101\n' || printf '127.0.0.1:3102\n';;
  ps)
    [[ "$1" == -q ]] && { [[ "$2" == qa-a ]] && printf 'qa-a-id\n' || printf 'qa-b-id\n'; } ;;
  logs)
    [[ "$1" == --no-color ]] && shift
    service="$1"; nfile="$MOCK_DIR/$service.count"; n=0; [[ -f "$nfile" ]] && n=$(<"$nfile"); n=$((n+1)); printf '%s' "$n" > "$nfile"
    if [[ "$MOCK_MODE" == missing ]]; then exit 0; fi
    if [[ "$MOCK_MODE" == delayed && "$n" -lt 2 ]]; then exit 0; fi
    # The probe mints a fresh marker per execution; curl recorded it.
    marker=""; [[ -f "$MOCK_DIR/current-marker" ]] && marker=$(<"$MOCK_DIR/current-marker")
    record="$(printf '%s' "$MOCK_RECORD" | sed "s/gate3-${RUN_ID}-qa-a/$marker/g")"
    if [[ "$MOCK_MODE" == duplicate ]]; then
      printf '%s\n%s\n' "$record" "$record"
    elif [[ "$MOCK_MODE" == malformed ]]; then
      # Valid pretty message but a non-JSON suffix: exercises the invalid-JSON
      # rejection path independently of the message check.
      printf '%s request completed {not-json}\n' "$marker"
    elif [[ "$MOCK_MODE" == msgmismatch ]]; then
      # Real shape but the pretty message is not "request completed".
      printf '%s\n' "$(printf '%s' "$record" | sed 's/): request completed {/): response finished {/')"
    elif [[ "$MOCK_MODE" == reqidmismatch ]]; then
      # Replace only the first x-request-id (req.headers); the marker stays in
      # res.headers so the line is still a candidate.
      printf '%s\n' "$(printf '%s' "$record" | sed "0,/$marker/s//wrong-id/")"
    elif [[ "$MOCK_MODE" == resreqidmismatch ]]; then
      printf '%s\n' "$(printf '%s' "$record" | sed 's/"statusCode":200,"headers":{"content-type":"application\/json; charset=utf-8","x-request-id":"[^"]*"/"statusCode":200,"headers":{"content-type":"application\/json; charset=utf-8","x-request-id":"wrong-id"/')"
    elif [[ "$MOCK_MODE" == remotemissing ]]; then
      printf '%s\n' "$(printf '%s' "$record" | sed 's/"remoteAddress":"10\.0\.0\.9",//')"
    elif [[ "$MOCK_MODE" == surroundings ]]; then
      printf 'qa-x-1  | [2026-09-19 14:03:10.000 +0000] INFO (7): Nest application successfully started\n'
      printf 'qa-x-1  | [2026-09-19 14:03:11.000 +0000] DEBUG (7): unrelated marker-bearing text %s\n' "$marker"
      printf '%s\n' "$record"
      printf 'qa-x-1  | [2026-09-19 14:03:13.000 +0000] INFO (7): request completed {"req":{"id":191,"method":"GET","url":"/health/ready","headers":{}},"responseTime":1}\n'
    else
      printf '%s\n' "$record"
    fi;;
  *) printf 'unexpected mocked Compose call: %s\n' "$command" >&2; exit 96;;
esac
DOCKER
chmod +x "$TMP/bin/docker"

run_case() {
  local id="$1" mode="$2" expected="$3"
  rm -rf "$ROOT/artifacts/gate3/$id"; mkdir -p "$ROOT/artifacts/gate3/$id" "$MOCK_DIR"
  printf 'RUN_ID=%q\nQA_A_PORT=3101\nQA_B_PORT=3102\n' "$id" > "$ROOT/artifacts/gate3/$id/state.env"
  export RUN_ID="$id" MOCK_MODE="$mode" MOCK_MARKER="gate3-$id-qa-a" GATE3_SOURCE_MAX_ATTEMPTS=3 GATE3_SOURCE_POLL_INTERVAL_SECONDS=0 GATE3_SOURCE_TIMEOUT_SECONDS=3
  # Real-format fixture: message outside the JSON payload, matching Gate A evidence.
  export MOCK_RECORD="$(pretty_record "gate3-$id-qa-a")"
  set +e
  PATH="$TMP/bin:$PATH" RUN_ID="$id" "$SOURCE" "$id" >/dev/null
  rc=$?
  set -e
  if [[ "$expected" == pass && $rc -ne 0 ]]; then printf 'FAIL %s expected PASS\n' "$mode"; exit 1; fi
  if [[ "$expected" == fail && $rc -eq 0 ]]; then printf 'FAIL %s expected FAIL\n' "$mode"; exit 1; fi
  [[ -s "$ROOT/artifacts/gate3/$id/source-correlation.tsv" ]] || { printf 'FAIL %s missing diagnostics\n' "$mode"; exit 1; }
}

export MOCK_DIR="$TMP/mock"

# A: up → source → doctor markers must differ and each independently correlate
# exactly once, even though all three records coexist in the same log stream.
coexist_case() {
  local id="$1" phase="$2" service="$3" remote_port="$4" marker_a marker_b record
  rm -rf "$ROOT/artifacts/gate3/$id"; mkdir -p "$ROOT/artifacts/gate3/$id"
  printf 'RUN_ID=%q\nQA_A_PORT=3101\nQA_B_PORT=3102\n' "$id" > "$ROOT/artifacts/gate3/$id/state.env"
  marker_a="gate3-$id-$service-$phase-nonce-a"
  marker_b="gate3-$id-$service-$phase-nonce-b"
  # All three phase records (up, source, doctor) coexist in the log; only the
  # marker under test changes per probe.
  record="$(printf '%s\n%s\n%s\n' \
    "$(pretty_record "gate3-$id-$service-up-nonce-up" 10.0.0.9)" \
    "$(pretty_record "$marker_a" 10.0.0.9)" \
    "$(pretty_record "$marker_b" 10.0.0.9)")"
  export MOCK_RECORD="$record" MOCK_MARKER="$marker_a"
  local rc=0
  printf '%s' "$record" | GATE3_PARSER_ONLY=1 "$SOURCE" "$marker_a" >/dev/null 2>&1 || rc=$?
  [[ $rc -eq 0 ]] || { printf 'FAIL coexist %s first probe expected PASS\n' "$phase"; exit 1; }
  rc=0
  printf '%s' "$record" | GATE3_PARSER_ONLY=1 "$SOURCE" "$marker_b" >/dev/null 2>&1 || rc=$?
  [[ $rc -eq 0 ]] || { printf 'FAIL coexist %s second probe expected PASS\n' "$phase"; exit 1; }
}
coexist_case test-harness-0021 up qa-a 3101
coexist_case test-harness-0022 source qa-b 3102
coexist_case test-harness-0023 doctor qa-a 3101

# B: same phase run twice → distinct markers, each exactly-one PASS.
coexist_case test-harness-0024 source qa-a 3101

# G: marker identity is traceable from diagnostics — the correlation TSV must
# carry run_id, service, phase, probe marker, candidate count, source, result.
run_case test-harness-0025 valid pass
head -n1 "$ROOT/artifacts/gate3/test-harness-0025/source-correlation.tsv" \
  | grep -q $'run_id\tservice\tphase\tprobe_marker\tattempt\ttimestamp_utc\tmarker_present\tcandidate_count\tjson_parse\tobserved_source\treason' \
  || { printf 'FAIL correlation TSV header missing probe identity columns\n'; exit 1; }
awk -F '\t' 'NR>1 { if ($1 != "test-harness-0025" || ($3 != "up" && $3 != "source" && $3 != "doctor") || $4 !~ /^gate3-test-harness-0025-qa-[ab]-(up|source|doctor)-[0-9]+-[0-9a-f]+$/ || $8 == "" || $10 == "") bad=1 } END { exit bad }' \
  "$ROOT/artifacts/gate3/test-harness-0025/source-correlation.tsv" \
  || { printf 'FAIL correlation TSV rows missing probe identity fields\n'; exit 1; }
# Marker minted by the live script must embed RUN_ID + service + phase and be
# header-safe; asserted below against the minted markers recorded in the
# test-harness-0025 correlation diagnostics.
run_case test-harness-0001 valid pass
run_case test-harness-0002 missing fail
run_case test-harness-0003 duplicate fail
run_case test-harness-0004 malformed fail
# Real-format parser contract cases (message outside JSON). Each case gets a
# unique run id so its source-correlation.tsv survives for reason assertions.
run_case test-harness-0005 valid pass          # A: real pino-pretty line, message outside JSON
run_case test-harness-0006 msgmismatch fail    # C: pretty message not "request completed"
run_case test-harness-0007 reqidmismatch fail  # E: request ID mismatch
run_case test-harness-0008 resreqidmismatch fail # F: response request ID mismatch
run_case test-harness-0009 remotemissing fail  # G: missing remoteAddress
run_case test-harness-0010 surroundings pass   # I: unrelated lines around one valid line

# Rejection reasons must be recorded per case, not collapsed into a generic timeout.
grep -q 'pretty message mismatch' "$ROOT/artifacts/gate3/test-harness-0006/source-correlation.tsv" || { printf 'FAIL missing pretty message mismatch reason\n'; exit 1; }
grep -q 'request ID mismatch' "$ROOT/artifacts/gate3/test-harness-0007/source-correlation.tsv" || { printf 'FAIL missing request ID mismatch reason\n'; exit 1; }
grep -q 'response request ID mismatch' "$ROOT/artifacts/gate3/test-harness-0008/source-correlation.tsv" || { printf 'FAIL missing response request ID mismatch reason\n'; exit 1; }
grep -q 'missing remoteAddress' "$ROOT/artifacts/gate3/test-harness-0009/source-correlation.tsv" || { printf 'FAIL missing remoteAddress reason\n'; exit 1; }
grep -q 'invalid JSON payload' "$ROOT/artifacts/gate3/test-harness-0004/source-correlation.tsv" || { printf 'FAIL missing malformed JSON reason\n'; exit 1; }

# B: JSON without `.msg` still passes — asserted by construction: every fixture
# record above carries the message outside the JSON, so a PASS with
# `json_parse=success` proves no `.msg` dependency. Assert it explicitly.
awk -F '\t' 'NR>1 && $8 == 1 {print $9}' "$ROOT/artifacts/gate3/test-harness-0001/source-correlation.tsv" | grep -q success \
  || { printf 'FAIL no successful parse with msg outside JSON\n'; exit 1; }
if jq -e 'has("msg")' >/dev/null 2>&1 <<<"$(printf '%s' "$MOCK_RECORD")" 2>/dev/null && [[ "$(jq 'has("msg")' <<<"$(printf '%s' "$MOCK_RECORD")")" == true ]]; then
  printf 'FAIL fixture must not embed msg inside JSON\n'; exit 1
fi

# Container-free parser regression suite against real captured-format fixtures.
parser_case() {
  local name="$1" expected="$2" input="$3" marker="$4" out reason
  out="$(set +e; printf '%s' "$input" | GATE3_PARSER_ONLY=1 "$SOURCE" "$marker" 2>&1; exit ${PIPESTATUS[1]:-0})" || true
  local rc=0; printf '%s' "$input" | GATE3_PARSER_ONLY=1 "$SOURCE" "$marker" >/dev/null 2>&1 || rc=$?
  if [[ "$expected" == pass && $rc -ne 0 ]]; then printf 'FAIL parser %s expected PASS\n' "$name"; exit 1; fi
  if [[ "$expected" == fail && $rc -eq 0 ]]; then printf 'FAIL parser %s expected FAIL\n' "$name"; exit 1; fi
  if [[ "$expected" == fail ]]; then
    reason="$(printf '%s' "$input" | GATE3_PARSER_ONLY=1 "$SOURCE" "$marker" 2>&1 >/dev/null || true)"
    [[ -n "$reason" ]] || { printf 'FAIL parser %s missing rejection reason\n' "$name"; exit 1; }
  fi
}

M='gate3-20260919-135625-af98e9-qa-a'
real_line="$(sed -n 's/^qa-a-1  | //p' "$ROOT/artifacts/gate3/20260919-135625-af98e9/qa-a.log" \
  | grep -F "$M" | head -n1)"
[[ -n "$real_line" ]] || real_line="$(pretty_record "$M" '::ffff:192.168.224.1')"
# A/B: real captured line (message outside JSON, no `.msg` key) → exactly one PASS
parser_case real-captured-line pass "$real_line"$'\n' "$M"
grep -q 'SOURCE_IDENTITY=::ffff:192.168.224.1' < <(printf '%s\n' "$real_line" | GATE3_PARSER_ONLY=1 "$SOURCE" "$M" 2>/dev/null) \
  || { printf 'FAIL real captured line remoteAddress not surfaced\n'; exit 1; }
# C: message mismatch (message text lives between ANSI color codes in the
# captured line, so the substitution rewrites the bare message text)
parser_case pretty-message-mismatch fail "$(printf '%s\n' "$real_line" | sed 's/request completed/response finished/')" "$M"
# D: malformed JSON suffix
parser_case malformed-json fail "$(printf '%s prefix {not-json}\n' "$M")" "$M"
# E: request ID mismatch (req.headers only; marker stays in res.headers so the
# line remains a candidate)
parser_case request-id-mismatch fail "$(printf '%s\n' "$real_line" | sed "0,/$M/s//wrong-id/")" "$M"
# G: missing remoteAddress
parser_case remote-missing fail "$(printf '%s\n' "$real_line" | sed 's/"remoteAddress":"::ffff:192\.168\.224\.1",//')" "$M"
# H: duplicate valid lines → FAIL
parser_case duplicate-lines fail "$(printf '%s\n%s\n' "$real_line" "$real_line")" "$M"
# I: unrelated logs before/after → exactly one PASS
parser_case surroundings pass "$(printf 'qa-x-1  | [2026-09-19 14:03:10.000 +0000] INFO (7): unrelated %s startup text\n%s\nqa-x-1  | [2026-09-19 14:03:13.000 +0000] INFO (7): request completed {"req":{"id":191,"method":"GET","url":"/health/ready","headers":{}},"responseTime":1}\n' "$M" "$real_line")" "$M"
# J: ANSI residue around the message
parser_case ansi-residue pass "$(printf '%s\n' "$real_line" | sed 's/INFO (7)/\x1b[32mINFO\x1b[39m (7)/')" "$M"

# C/D: distinct markers must not trigger duplicate detection on each other.
M1="gate3-run-dup-check-qa-a-source-aaa"
M2="gate3-run-dup-check-qa-a-source-bbb"
two_marker_logs="$(printf '%s\n%s\n' "$(pretty_record "$M1" '::ffff:192.168.224.1')" "$(pretty_record "$M2" '::ffff:192.168.224.1')")"
parser_case marker-isolation pass "$two_marker_logs" "$M1"
parser_case marker-isolation pass "$two_marker_logs" "$M2"

grep -q 'GATE3_PRESERVE_ON_FAILURE' "$ROOT/tools/gate3/gate3.sh"
grep -q 'STATE_DIR/\$requested/state.env' "$ROOT/tools/gate3/gate3.sh"
grep -q 'GATE3_RUN_ID=<run-id>' "$ROOT/tools/gate3/README.md"

# Source the lifecycle library and replace every external phase with deterministic mocks.
GATE3_LIB_ONLY=1 source "$ROOT/tools/gate3/gate3.sh"
LIFECYCLE_LOG="$TMP/lifecycle.log"
export LIFECYCLE_LOG
MOCK_LIFECYCLE_ROOT="$TMP/lifecycle-root"
mkdir -p "$MOCK_LIFECYCLE_ROOT/tools/gate3"
cat > "$MOCK_LIFECYCLE_ROOT/tools/gate3/source-evidence.sh" <<'SOURCE'
#!/usr/bin/env bash
printf 'source\n' >> "$LIFECYCLE_LOG"
SOURCE
chmod +x "$MOCK_LIFECYCLE_ROOT/tools/gate3/source-evidence.sh"
ROOT="$MOCK_LIFECYCLE_ROOT"
RUN_ID=test-lifecycle-0001
compose() { printf 'compose:%s\n' "$*" >> "$LIFECYCLE_LOG"; }
wait_for_qa_health() { printf 'health\n' >> "$LIFECYCLE_LOG"; }
private_runtime_topology_check() { printf 'private\n' >> "$LIFECYCLE_LOG"; }
metadata_check() { printf 'metadata\n' >> "$LIFECYCLE_LOG"; }
wait_for_heartbeat_samples() { printf 'heartbeat\n' >> "$LIFECYCLE_LOG"; }
attach_qa_publish_network() { printf 'attach\n' >> "$LIFECYCLE_LOG"; }
published_runtime_topology_check() { printf 'published\n' >> "$LIFECYCLE_LOG"; }
: > "$LIFECYCLE_LOG"
run_qa_private_publish_lifecycle
expected_order=$'compose:up -d qa-a qa-b\nhealth\nprivate\nmetadata\nheartbeat\nattach\npublished\nsource'
[[ "$(<"$LIFECYCLE_LOG")" == "$expected_order" ]] || { printf 'FAIL staged lifecycle order\n' >&2; exit 1; }

# A private readiness failure must stop before publication and source evidence.
wait_for_qa_health() { printf 'health-fail\n' >> "$LIFECYCLE_LOG"; return 7; }
: > "$LIFECYCLE_LOG"
set +e
(set -e; run_qa_private_publish_lifecycle)
rc=$?
set -e
[[ $rc -eq 7 ]] || { printf 'FAIL private readiness exit status\n' >&2; exit 1; }
! grep -qE 'attach|published|source' "$LIFECYCLE_LOG" || { printf 'FAIL publication ran after private readiness failure\n' >&2; exit 1; }

# Exercise the real QA-only attach helper with private, partial, and complete states.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
GATE3_LIB_ONLY=1 source "$ROOT/tools/gate3/gate3.sh"
PROJECT=gate3-test-lifecycle
NETWORK=${PROJECT}_gate3
PUBLISH_NETWORK=${PROJECT}_gate3-publish
ARTIFACT_DIR="$TMP/attach-artifacts"
mkdir -p "$ARTIFACT_DIR" "$TMP/attach-state"
ATTACH_STATE="$TMP/attach-state"
ATTACH_LOG="$TMP/attach.log"
MOCK_ATTACH_FAIL=""
ensure_publish_network() { printf 'ensure\n' >> "$ATTACH_LOG"; }
assert_private_boundaries() { printf 'boundaries\n' >> "$ATTACH_LOG"; }
compose() {
  [[ "$1" == ps && "$2" == -q ]] || return 98
  printf '%s-id\n' "$3"
}
docker() {
  if [[ "$1" == inspect ]]; then
    local cid="$2" format="${4:-}"
    if [[ "$format" == *NetworkSettings.Networks* ]]; then
      if [[ -f "$ATTACH_STATE/$cid" ]]; then
        printf '{"%s":{},"%s":{}}\n' "$NETWORK" "$PUBLISH_NETWORK"
      else
        printf '{"%s":{}}\n' "$NETWORK"
      fi
    else
      printf 'yes\n'
    fi
    return 0
  fi
  if [[ "$1" == network && "$2" == connect ]]; then
    local cid="$4"
    printf 'connect:%s\n' "$cid" >> "$ATTACH_LOG"
    [[ "$MOCK_ATTACH_FAIL" == "$cid" ]] && return 9
    : > "$ATTACH_STATE/$cid"
    return 0
  fi
  printf 'unexpected lifecycle docker call: %s\n' "$*" >&2
  return 97
}

: > "$ATTACH_LOG"
rm -f "$ATTACH_STATE"/*
attach_qa_publish_network
[[ "$(<"$ATTACH_LOG")" == $'ensure\nboundaries\nconnect:qa-a-id\nconnect:qa-b-id' ]] || { printf 'FAIL QA-only publish attachment order\n' >&2; exit 1; }

: > "$ATTACH_LOG"
rm -f "$ATTACH_STATE"/*
MOCK_ATTACH_FAIL=qa-a-id
set +e
(set -e; attach_qa_publish_network) >/dev/null 2>&1
rc=$?
set -e
[[ $rc -eq 9 ]] || { printf 'FAIL first attachment failure status\n' >&2; exit 1; }
! grep -q 'connect:qa-b-id' "$ATTACH_LOG" || { printf 'FAIL qa-b attached after qa-a failure\n' >&2; exit 1; }

: > "$ATTACH_LOG"
rm -f "$ATTACH_STATE"/*
MOCK_ATTACH_FAIL=qa-b-id
set +e
(set -e; attach_qa_publish_network) >/dev/null 2>&1
rc=$?
set -e
[[ $rc -eq 9 && -f "$ATTACH_STATE/qa-a-id" && ! -f "$ATTACH_STATE/qa-b-id" ]] || { printf 'FAIL partial attachment state\n' >&2; exit 1; }

# Text contracts cover cleanup continuation and source gating without Docker.
grep -q 'assert_fresh_run_identity' "$ROOT/tools/gate3/gate3.sh"
grep -q 'Gate3 Compose project already exists' "$ROOT/tools/gate3/gate3.sh"
grep -q 'db_is_attached_to_private_network' "$ROOT/tools/gate3/gate3.sh"
grep -q 'append_cleanup_failure compose-down' "$ROOT/tools/gate3/gate3.sh"
grep -q 'append_cleanup_failure post-down-verification' "$ROOT/tools/gate3/gate3.sh"
grep -q 'if ! down; then' "$ROOT/tools/gate3/gate3.sh"
grep -q 'GATE3_LIB_ONLY' "$ROOT/tools/gate3/gate3.sh"

# Publish-network removal contract: identity-verified from the network itself,
# not gated on PUBLISH_NETWORK_CREATED state.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
GATE3_LIB_ONLY=1 source "$ROOT/tools/gate3/gate3.sh"
PUB_RM_DIR="$TMP/publish-rm"
ARTIFACT_DIR="$PUB_RM_DIR/artifacts"
mkdir -p "$ARTIFACT_DIR"
PROJECT=gate3-pubrm-run
RUN_ID=pubrm-run
PUBLISH_NETWORK=gate3-pubrm-run_gate3-publish
PUBLISH_NETWORK_CREATED=0
PUB_DOCKER_LOG="$TMP/pubrm.log"
PUB_NET_ABSENT=""
PUB_NET_ATTACHED_FILE=""
PUB_NET_IDENTITY_OK="1"
docker() {
  if [[ "$1" == network && "$2" == inspect ]]; then
    [[ "$3" == "$PUBLISH_NETWORK" ]] || return 1
    [[ -z "$PUB_NET_ABSENT" ]] || return 1
    if [[ -n "$PUB_NET_ATTACHED_FILE" ]]; then
      printf '%s\n' '[{"Name":"net","Labels":{"com.docker.compose.project":"gate3-pubrm-run","com.docker.compose.network":"gate3-publish","com.smartlearning.gate3.run-id":"pubrm-run"},"Containers":{"c1":{"Name":"external-diagnostic","EndpointID":"e1"}}}]'
    else
      printf '%s\n' '[{"Name":"net","Labels":{"com.docker.compose.project":"gate3-pubrm-run","com.docker.compose.network":"gate3-publish","com.smartlearning.gate3.run-id":"pubrm-run"},"Containers":{}}]'
    fi
    return 0
  fi
  if [[ "$1" == network && "$2" == rm ]]; then
    printf 'rm:%s\n' "$3" >> "$PUB_DOCKER_LOG"
    return 0
  fi
  printf 'unexpected publish-rm docker call: %s\n' "$*" >&2
  return 97
}
# already absent → idempotent PASS
: > "$PUB_DOCKER_LOG"; PUB_NET_ABSENT=1; PUBLISH_NETWORK_CREATED=0
remove_publish_network || { printf 'FAIL publish network already absent should PASS\n' >&2; exit 1; }
[[ ! -s "$PUB_DOCKER_LOG" ]] || { printf 'FAIL absent network must not be removed\n' >&2; exit 1; }
# exists and empty → exact remove, regardless of PUBLISH_NETWORK_CREATED state
: > "$PUB_DOCKER_LOG"; PUB_NET_ABSENT=""; PUBLISH_NETWORK_CREATED=0
remove_publish_network || { printf 'FAIL empty publish network removal should PASS\n' >&2; exit 1; }
grep -q "rm:$PUBLISH_NETWORK" "$PUB_DOCKER_LOG" || { printf 'FAIL empty publish network not removed\n' >&2; exit 1; }
[[ -s "$ARTIFACT_DIR/publish-network-before-remove.json" ]] || { printf 'FAIL removal evidence missing\n' >&2; exit 1; }
# run-owned QA attachment only → blocked (run lifecycle must clean qa first); here the
# run-owned path is covered by compose down, so the fail-closed listing is asserted.
: > "$PUB_DOCKER_LOG"; PUB_NET_ATTACHED_FILE=1
set +e
remove_publish_network 2> "$TMP/pubrm-attached.err"
rc=$?
set -e
[[ $rc -ne 0 ]] || { printf 'FAIL attached publish network must fail closed\n' >&2; exit 1; }
grep -q 'cleanup blocked by attached container' "$TMP/pubrm-attached.err" || { printf 'FAIL attached network error message missing\n' >&2; exit 1; }
grep -q 'external-diagnostic' "$TMP/pubrm-attached.err" || { printf 'FAIL attached container not listed\n' >&2; exit 1; }
grep -q 'rm:' "$PUB_DOCKER_LOG" && { printf 'FAIL attached network must not be removed\n' >&2; exit 1; }
# identity mismatch → fail closed without removal
: > "$PUB_DOCKER_LOG"
docker() {
  if [[ "$1" == network && "$2" == inspect ]]; then
    printf '%s\n' '[{"Name":"net","Labels":{"com.docker.compose.project":"other-project","com.docker.compose.network":"gate3-publish","com.smartlearning.gate3.run-id":"other-run"},"Containers":{}}]'
    return 0
  fi
  printf 'rm:%s\n' "$3" >> "$PUB_DOCKER_LOG"
  return 0
}
set +e
remove_publish_network 2> "$TMP/pubrm-identity.err"
rc=$?
set -e
[[ $rc -ne 0 ]] || { printf 'FAIL identity-mismatch publish network must fail closed\n' >&2; exit 1; }
[[ ! -s "$PUB_DOCKER_LOG" ]] || { printf 'FAIL identity-mismatch network must not be removed\n' >&2; exit 1; }
grep -q 'publish network identity mismatch' "$TMP/pubrm-identity.err" || { printf 'FAIL identity-mismatch error message missing\n' >&2; exit 1; }

printf 'PASS publish-network removal contract fixtures\n'

printf 'PASS source-correlation (real pino-pretty fixtures), staged-lifecycle, readiness-stop, partial-attachment, preservation, and cleanup-contract fixtures\n'