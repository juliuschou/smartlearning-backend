#!/usr/bin/env bash
# Container-free regression suite; Docker is replaced with a strict allowlist mock.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT
cat > "$test_dir/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
[[ "${MOCK_FAILURE:-0}" = 0 ]] || exit 1
printf '%s\n' "$*" >> "$DOCTOR_CALLS"
if [[ "$*" = 'context show' ]]; then printf '%s\n' "${MOCK_CONTEXT:-default}"; exit; fi
[[ "$1" = --context && "$2" = default ]] || exit 90
shift 2
case "$1 $2" in
  'info --format') printf '%s\n' "${MOCK_ENGINE:-engine-1}" ;;
  'volume inspect') printf '%s\n' "${MOCK_VOLUME:-dev-data}" ;;
  'container inspect')
    case "$4" in
      '{{.Id}}|{{.Name}}|{{.State.Status}}') printf 'full-id|/%s|%s\n' "${MOCK_NAME:-dev-pg}" "${MOCK_STATE:-running}" ;;
      '{{.Id}}') printf '%s\n' "${MOCK_CONSUMER_ID:-full-id}" ;;
      *) printf '%s\n' "${MOCK_MOUNT:-volume|dev-data|true}" ;;
    esac ;;
  'ps --filter') printf '%s\n' "${MOCK_CONSUMER:-short-id}" ;;
  *) printf 'FORBIDDEN\n' >> "$DOCTOR_CALLS"; exit 91 ;;
esac
MOCK
chmod +x "$test_dir/docker"
export PATH="$test_dir:$PATH" DOCTOR_CALLS="$test_dir/calls"
export EXPECTED_DOCKER_CONTEXT=default EXPECTED_DOCKER_ENGINE_ID=engine-1 POSTGRES_CONTAINER=dev-pg POSTGRES_VOLUME=dev-data
unset DOCKER_HOST DOCKER_CONTEXT
check() {
  local name="$1" expected="$2" needle="$3" status=0
  shift 3
  : > "$DOCTOR_CALLS"
  env "$@" bash "$repo_root/tools/dev/env-doctor.sh" > "$test_dir/output" 2>&1 || status=$?
  [[ "$status" = "$expected" ]] || { cat "$test_dir/output"; exit 1; }
  rg -q -- "$needle" "$test_dir/output"
  if rg -q 'FORBIDDEN|(^| )(exec|start|restart|create|prune|rm|curl|psql)( |$)' "$DOCTOR_CALLS"; then exit 1; fi
  printf 'PASS %s\n' "$name"
}
check probe-failure 1 'probe failed or timed out' MOCK_FAILURE=1
check success 0 'SQL identity/readability: NOT VERIFIED'
check missing-input 1 'must be explicitly set' POSTGRES_VOLUME=
[[ ! -s "$DOCTOR_CALLS" ]]
check override 1 'overrides must be unset' DOCKER_HOST=tcp://unexpected
[[ ! -s "$DOCTOR_CALLS" ]]
check context-mismatch 1 'context mismatch' MOCK_CONTEXT=other
check engine-mismatch 1 'engine mismatch' MOCK_ENGINE=other
check volume-mismatch 1 'Volume identity mismatch' MOCK_VOLUME=other
check container-mismatch 1 'Container identity mismatch' MOCK_NAME=other
check mount-mismatch 1 'data volume mount not proven' MOCK_MOUNT='volume|test-data|true'
check read-only-mount 1 'data volume mount not proven' MOCK_MOUNT='volume|dev-data|false'
check stopped 1 'Selected container is stopped' MOCK_STATE=exited
check shared-volume 1 'Another running container' MOCK_CONSUMER_ID=other-id
printf 'All 12 metadata-only tests passed; no real Docker or database operations.\n'
