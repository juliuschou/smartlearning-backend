#!/usr/bin/env bash
set -euo pipefail

# Staging-replica MinIO setup for BE-5.2 Checkpoint G step 5.
#
# Same shape as ops/minio-rehearsal/setup.sh, retargeted at the dedicated
# staging replica (bucket sl-staging-manifests, container staging-replica-minio,
# host port 19010). Creates the object-lock + versioning bucket and a
# prefix-scoped write-only user, then merges the S3 credential vars into the
# gitignored ops/staging-replica/.env.staging.
#
# Requires: the staging-replica MinIO container running (docker compose up
# with explicit user authorization) and .env.staging already created from
# .env.staging.example.
#
# Usage:  ops/staging-replica/setup.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="staging-replica-minio"
BUCKET="sl-staging-manifests"
PREFIX="deletion-manifests"
REGION="us-east-1"
ENDPOINT="http://127.0.0.1:19010"
ENV_OUT="${ROOT}/.env.staging"
USER_TAG="staging-upload"

if [ ! -f "${ENV_OUT}" ]; then
  echo "[setup] ERROR: ${ENV_OUT} not found. Copy .env.staging.example first." >&2
  exit 1
fi

STAGING_ROOT_USER="$(grep -E '^MINIO_ROOT_USER=' "${ENV_OUT}" | cut -d= -f2-)"
STAGING_ROOT_PASSWORD="$(grep -E '^MINIO_ROOT_PASSWORD=' "${ENV_OUT}" | cut -d= -f2-)"
if [ -z "${STAGING_ROOT_USER}" ] || [ -z "${STAGING_ROOT_PASSWORD}" ]; then
  echo "[setup] ERROR: MINIO_ROOT_USER/PASSWORD must be set in ${ENV_OUT}." >&2
  exit 1
fi

mc() {
  docker exec -e MC_CONFIG_DIR=/tmp/.mc-staging "${CONTAINER}" /usr/bin/mc \
    alias set --insecure local "https://127.0.0.1:9000" "${STAGING_ROOT_USER}" "${STAGING_ROOT_PASSWORD}" >/dev/null 2>&1
  # Global --insecure: the replica MinIO serves a self-signed certificate.
  docker exec -e MC_CONFIG_DIR=/tmp/.mc-staging "${CONTAINER}" /usr/bin/mc --insecure "$@"
}

echo "[setup] waiting for MinIO at ${ENDPOINT} ..."
for i in $(seq 1 60); do
  if mc ready local >/dev/null 2>&1; then break; fi
  [ "$i" -eq 60 ] && { echo "[setup] ERROR: MinIO did not become ready" >&2; exit 1; }
  sleep 1
done

echo "[setup] creating bucket ${BUCKET} with object-lock + versioning..."
if ! mc stat "local/${BUCKET}" >/dev/null 2>&1; then
  mc mb --with-lock --region "${REGION}" "local/${BUCKET}"
else
  echo "[setup] bucket ${BUCKET} already exists — skipping mb"
fi
mc version enable "local/${BUCKET}"

echo "[setup] creating prefix-scoped write-only user..."
ACCESS_KEY="$(printf '%s-%s' "${USER_TAG}" "$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')")"
SECRET_KEY="k$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"

cat > "${ROOT}/.policy-staging-write.json" <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:PutObjectRetention", "s3:GetObject"],
      "Resource": ["arn:aws:s3:::${BUCKET}/${PREFIX}/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::${BUCKET}"]
    }
  ]
}
POLICY
mc admin user add "local" "${ACCESS_KEY}" "${SECRET_KEY}"
docker cp "${ROOT}/.policy-staging-write.json" "${CONTAINER}:/tmp/policy.json"
mc admin policy create "local" staging-write /tmp/policy.json
mc admin policy attach "local" staging-write --user "${ACCESS_KEY}"
docker exec "${CONTAINER}" rm -f /tmp/policy.json
rm -f "${ROOT}/.policy-staging-write.json"

# Merge S3 credentials into .env.staging (replace placeholder lines).
python3 - "${ENV_OUT}" "${ACCESS_KEY}" "${SECRET_KEY}" <<'PYEOF'
import re, sys
path, access, secret = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    text = f.read()
text = re.sub(r'^S3_ACCESS_KEY_ID=.*$', f'S3_ACCESS_KEY_ID={access}', text, flags=re.M)
text = re.sub(r'^S3_SECRET_ACCESS_KEY=.*$', f'S3_SECRET_ACCESS_KEY={secret}', text, flags=re.M)
with open(path, 'w') as f:
    f.write(text)
print(f'[setup] merged S3 credentials into {path}')
PYEOF
chmod 600 "${ENV_OUT}"

echo "[setup] OK — bucket + write-only user ready."
echo "[setup] Credentials live ONLY in ${ENV_OUT} (gitignored; values never printed)."
echo "[setup] Next: follow ops/staging-replica/README.md (canary runbook)."