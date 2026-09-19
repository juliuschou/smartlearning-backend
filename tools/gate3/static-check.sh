#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
export RUN_ID=gate3-static-00000000
export GATE3_BACKEND_IMAGE="${GATE3_BACKEND_IMAGE:-smartlearning-backend:qa1-rc-b9bcd2b}"
export GATE3_QA_A_PORT=33101
export GATE3_QA_B_PORT=33102
export GATE3_SECRET_HOST_DIR=/tmp/gate3-static-secrets
export GATE3_DB_NETWORK=unused

for script in tools/gate3/*.sh; do bash -n "$script"; done
if command -v shellcheck >/dev/null 2>&1; then shellcheck tools/gate3/*.sh; else printf 'shellcheck: NOT AVAILABLE\n'; fi
mkdir -p "$GATE3_SECRET_HOST_DIR"
printf x > "$GATE3_SECRET_HOST_DIR/database_url"
printf x > "$GATE3_SECRET_HOST_DIR/cookie_secret"
printf x > "$GATE3_SECRET_HOST_DIR/login_rate_limit_key_secret"
trap 'rm -rf "$GATE3_SECRET_HOST_DIR" /tmp/gate3-static-config.json' EXIT

config_json="$(RUN_ID="$RUN_ID" docker compose --project-name gate3-static --file tools/gate3/compose.yaml config --format json)"
printf '%s\n' "$config_json" > /tmp/gate3-static-config.json
# Compose drops service-unreferenced networks from the interpolated render, so the
# network contract is verified against the --no-interpolate render.
networks_json="$(docker compose --project-name gate3-static --file tools/gate3/compose.yaml config --no-interpolate --format json)"
printf '%s\n' "$networks_json" | jq -e '
  .networks.gate3.internal == true and
  .networks["gate3-publish"].internal == false and
  .networks["gate3-publish"].labels["com.smartlearning.gate3"] == "true" and
  (.networks["gate3-publish"].labels["com.smartlearning.gate3.run-id"] | test("RUN_ID")) and
  ([.services | keys[]] | sort) == ["qa-a", "qa-b", "redis", "secret-init"]
' >/dev/null

jq -e --arg a "$GATE3_QA_A_PORT" --arg b "$GATE3_QA_B_PORT" '
  ([.services["qa-a"].networks | keys[]] | sort) == ["gate3"] and
  ([.services["qa-b"].networks | keys[]] | sort) == ["gate3"] and
  ([.services.redis.networks | keys[]] | sort) == ["gate3"] and
  ([.services["secret-init"].networks | keys[]] | sort) == ["gate3"] and
  ([.services["qa-a"].ports[] | if type == "object" then {ip:.host_ip,target:(.target|tostring),published:(.published|tostring)} else empty end] | any(.ip == "127.0.0.1" and .target == "3000" and .published == $a)) and
  ([.services["qa-b"].ports[] | if type == "object" then {ip:.host_ip,target:(.target|tostring),published:(.published|tostring)} else empty end] | any(.ip == "127.0.0.1" and .target == "3000" and .published == $b)) and
  ([.services | keys[]] | index("postgres") | not)
' <<< "$config_json" >/dev/null
lifecycle_body="$(perl -0ne 'print $1 if /run_qa_private_publish_lifecycle\(\) \{(.*?)\n\}/s' tools/gate3/gate3.sh)"
[[ -n "$lifecycle_body" ]] || { printf 'missing Gate3 lifecycle function\n' >&2; exit 1; }
private_line="$(grep -n 'private_runtime_topology_check' <<< "$lifecycle_body" | cut -d: -f1)"
attach_line="$(grep -n 'attach_qa_publish_network' <<< "$lifecycle_body" | cut -d: -f1)"
published_line="$(grep -n 'published_runtime_topology_check' <<< "$lifecycle_body" | cut -d: -f1)"
source_line="$(grep -n 'source-evidence.sh' <<< "$lifecycle_body" | cut -d: -f1)"
[[ -n "$private_line" && -n "$attach_line" && -n "$published_line" && -n "$source_line" ]] || { printf 'incomplete staged lifecycle contract\n' >&2; exit 1; }
(( private_line < attach_line && attach_line < published_line && published_line < source_line )) || { printf 'invalid staged lifecycle order\n' >&2; exit 1; }
[[ "$(grep -c 'docker network connect "$PUBLISH_NETWORK" "$cid"' tools/gate3/gate3.sh)" == 1 ]] || { printf 'publish attachment must use the QA-only helper exactly once\n' >&2; exit 1; }
if rg -n 'network connect[^\n]*PUBLISH_NETWORK[^\n]*(redis|DB_CONTAINER)' tools/gate3/gate3.sh; then
  printf 'Redis or DB publish-network attachment found\n' >&2
  exit 1
fi

if rg -n 'docker system prune|docker volume prune|docker network prune|docker start|docker restart|network_mode:[[:space:]]*(host|none)' tools/gate3 --glob '*.sh' --glob '*.yaml' --glob '!static-check.sh'; then
  printf 'unsafe Gate3 lifecycle pattern found\n' >&2
  exit 1
fi
if rg -n 'smartlearning-db|smartlearning-redis' tools/gate3/compose.yaml tools/gate3/source-evidence.sh; then
  printf 'unapproved shared resource reference found\n' >&2
  exit 1
fi
printf 'Gate3 static checks PASS\n'
