#!/usr/bin/env bash
set -euo pipefail

# Tear down the disposable MinIO rehearsal target.
#
# Removes the MinIO container and its data volume, and the generated gitignored
# credential file. This is a THROWAWAY sandbox: nothing in it is a production
# asset, and the write-only credential is regenerated on the next setup.sh run.
#
# WARNING — this deletes the object-lock/versioned bucket and its objects.
# Only run once all step-3 evidence has been recorded. The rehearsal DB rows in
# smartlearning_test are NOT touched here (they are truncateAll-covered by the
# next test suite run).
#
# Usage:  ops/minio-rehearsal/teardown.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="minio-rehearsal-minio-1"

read -r -p "Delete disposable MinIO (container+volume) and its credentials? [y/N] " ans
case "${ans}" in
  y|Y|yes) ;;
  *) echo "[teardown] aborted."; exit 0 ;;
esac

docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
docker volume rm minio-sandbox-data >/dev/null 2>&1 || true
rm -f "${ROOT}/.env.minio-rehearsal"

echo "[teardown] finished. Rehearsal sandbox removed."
