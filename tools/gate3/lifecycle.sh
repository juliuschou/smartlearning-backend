#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
case "${1:-}" in
  start) exec "$ROOT/tools/gate3/gate3.sh" up ;;
  stop) exec "$ROOT/tools/gate3/gate3.sh" down ;;
  *) printf 'usage: lifecycle.sh {start|stop}\n' >&2; exit 2 ;;
esac
