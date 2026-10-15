# Checkpoint I — repository correction and revised proposal

Repository-only authorization completed; no Docker queries or live operations.
H outcome and h-diagnosis remain authoritative under
artifacts/local-env/sl-e-20261013-01/. Historical data authority is UNKNOWN.

## Change and regression evidence

Same pinned PostgreSQL image; helper shadows its declared PGDATA VOLUME with a
read-only 1 MiB tmpfs, mode 0700. No PGDATA volume is mounted in helper.
Creation and inspection must agree on topology/options; unexpected mounts still
fail closed. Preflight rejects different image VOLUME declarations. Secret-volume
consumer guard continues allowing only recorded helper/PG IDs; rollback runs the
same topology checks. Data/secret volume ownership guards and role policy remain.

The revised fixture failed against old code (21 tests, one failure:
helper-stop-blocked in rollback). Fixture now models automatic anonymous PGDATA
when the creation override is absent. Full G recorded success/failure simulations
use the recorded creation arguments to construct helper inspect topology.
F additionally rejects implicit volume, writable tmpfs, changed size and extra
mounts. Simulation does not prove real Docker serialization or SQL behavior.
Docker supports tmpfs creation and size/mode options:
https://docs.docker.com/engine/storage/tmpfs/
https://docs.docker.com/reference/cli/docker/container/create/

## Concrete next live proposal — NOT authorized

One invocation only, reserved run sl-i-20261014-01. Container:
sl-i-20261014-01-dev-pg; helper: sl-i-20261014-01-secret-helper; volumes:
sl-i-20261014-01-dev-data and sl-i-20261014-01-dev-secret. Evidence:
artifacts/local-env/sl-i-20261014-01/; protected external backup:
/home/user/.local/share/smartlearning/sl-i-20261014-01.
All must be fresh; no adoption, retry, deletion or overwriting collision evidence.

Scope otherwise follows checkpoint-e-plan.md and checkpoint-g-review.md:
pinned runtime/image/ports, generated secret via stdin, fresh initdb, separated
bootstrap/migration/application roles, audited grants, 20 manifest migrations as
migration role, protected backup/migration URL, atomic application env update,
sanitized lifecycle/outcome evidence. Exclusive env editing/provisioning required.
No DB-backed app suites (their implicit migration requires separate permission),
seed, db push, Redis/backend, old-resource modification, commit or push.

Recompute review hash before any authorization; current repository contract:
e6b0dd19379ccc391a99de9cdf58f0e2a6973d74b064d4708d15c250e46229fe.
Approval scope:
fresh-initdb-start-secret-helper-tmpfs-separated-roles-grants-20-migrations-env-backup-update.
CLI liveEnabled is an implementation gate, never human authorization.
Do not invoke under consumed H approval.

Rollback: exact-ID identity/image/label/mount/consumer guarded stops, protected
hash-guarded env restore; retain volumes, credentials and evidence. If inspect
serialization differs, block before secret streaming, retain resources and record
blocked rollback; never relax guards or retry. Host/process interruption recovery
remains manual. No live completeness or historical-data recovery is claimed.

## Verification and manual gate

Container-free: E 6, F 23, F-env 18, G 19 = 66 PASS. Review CLI:
REVIEW_ONLY / separated-roles / liveEnabled=true. git diff --check PASS.
No TS/build/app suites run: repository Python tooling scope only.
Live publication, tmpfs serialization/shadowing, initdb/UID, SQL/grants, PG16
migrations and env rollback remain unverified.

STOP per AGENTS.md manual checkpoint gate. Separate explicit authorization is
required for the concrete live contract above.
