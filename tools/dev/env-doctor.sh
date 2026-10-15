#!/usr/bin/env bash
# Metadata-only, point-in-time inspection. Never starts or enters a container.
set -euo pipefail

blocked() { printf '[BLOCKED] %s\n' "$1" >&2; exit 1; }
for key in EXPECTED_DOCKER_CONTEXT EXPECTED_DOCKER_ENGINE_ID POSTGRES_CONTAINER POSTGRES_VOLUME; do
  value="${!key:-}"
  [[ "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$ ]] || blocked "$key must be explicitly set to a resource identity"
done
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || blocked 'Docker environment overrides must be unset'
command -v docker >/dev/null || blocked 'Docker CLI unavailable'
command -v timeout >/dev/null || blocked 'timeout unavailable'

# Suppress raw Docker diagnostics: they may contain endpoint/configuration data.
probe() {
  timeout 10s docker "$@" 2>/dev/null || blocked 'Docker metadata probe failed or timed out'
}
context="$(probe context show)"
[[ "$context" = "$EXPECTED_DOCKER_CONTEXT" ]] || blocked 'Docker context mismatch'
# Pin every subsequent query to the verified context.
docker_read() { probe --context "$EXPECTED_DOCKER_CONTEXT" "$@"; }
engine="$(docker_read info --format '{{.ID}}')"
[[ "$engine" = "$EXPECTED_DOCKER_ENGINE_ID" ]] || blocked 'Docker engine mismatch'
printf '[PASS] Docker context and engine match explicit expectations\n'

volume="$(docker_read volume inspect --format '{{.Name}}' "$POSTGRES_VOLUME")"
[[ "$volume" = "$POSTGRES_VOLUME" ]] || blocked 'Volume identity mismatch'
identity="$(docker_read container inspect --format '{{.Id}}|{{.Name}}|{{.State.Status}}' "$POSTGRES_CONTAINER")"
IFS='|' read -r container_id container_name state <<< "$identity"
[[ -n "$container_id" && "$container_name" = "/$POSTGRES_CONTAINER" ]] || blocked 'Container identity mismatch'
mounts="$(docker_read container inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}|{{.Name}}|{{.RW}}{{println}}{{end}}{{end}}' "$POSTGRES_CONTAINER")"
[[ "$mounts" = "volume|$POSTGRES_VOLUME|true" ]] || blocked 'Expected writable PostgreSQL 16 data volume mount not proven'
printf '[PASS] Exact container and data volume mapping match\n'

# Any other running volume consumer is unsafe, even if apparently read-only.
consumers="$(docker_read ps --filter "volume=$POSTGRES_VOLUME" --format '{{.ID}}')"
while IFS= read -r consumer; do
  [[ -z "$consumer" ]] && continue
  consumer_id="$(docker_read container inspect --format '{{.Id}}' "$consumer")"
  [[ "$consumer_id" = "$container_id" ]] || blocked 'Another running container uses the selected data volume'
done <<< "$consumers"
[[ "$state" = running ]] || blocked 'Selected container is stopped; separate authorization required before any start'
printf '[PASS] Selected container running; no other running volume consumer observed\n'
printf 'METADATA CHECK PASS (point-in-time only)\nSQL identity/readability: NOT VERIFIED\nExternal backup/restore: NOT VERIFIED\nData operations: NOT AUTHORIZED by this check\n'
