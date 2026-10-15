# Checkpoint N — SQL-only lifecycle adapter (2026-10-14)

## Authorization and scope

N authorizes repository preparation and container-free verification only. No live
Docker query/lifecycle, SQL, initdb, migration, real environment-file access or
cleanup was performed. H/K approvals are consumed; their resources/evidence remain
protected. The executable adapter is reviewable, but its approval string is a
software gate, not human authorization.

The exact resource names, runtime identity, loopback port, helper tmpfs/root
exception, SQL policy and retention scope remain those in
[the M proposal](checkpoint-m-review.md). Every collision fails closed. N does
not invoke G, Prisma or environment transactions. M's exact AUDIT/GRANTS and
eight transaction-scoped negative cases/restoration checks remain unchanged.

## Implementation and failure behavior

`checkpoint-n.py` supplies independent preflight/provisioning, three distinct
synthetic credentials streamed through stdin, and exact current-run guards before
SQL/start/stop. Its contract binds N/M/F/E/role-policy sources. Default invocation
is pure review; execution requires the exact approval/hash/exclusivity gates.

Exclusive evidence consumes the fixed run identity even after failure. The local
advisory lock serializes cooperating adapter processes using the same evidence
root. It cannot prevent outside operators racing Docker or port allocation;
external serialized runtime/port access remains an explicit required assertion.
Repository sources must be trusted and held unchanged while importing/executing;
loaded source snapshots and subsequent disk-hash checks fail closed on drift.
The production runner cannot select an alternate evidence root.
Bounded readiness probes do not retry failed diagnostic SQL.

Create intent is durably written before creation; lost responses remain unresolved
and never trigger adoption/retry. Known IDs survive later recording failures.
Success and failure both attempt guarded current-run stops, retain volumes and
evidence, and report unresolved creation/recording/stop failures. If evidence
storage itself fails, durable publication cannot be guaranteed; sanitized stdout
and the retained prior intents are the fallback evidence. No automatic cleanup.

Preparation rollback: revert only N files/task notes. Future live rollback: stop
only validated known current-run IDs; retain data/secret volumes and evidence.
Deletion requires separate authorization. No schema/data rollback is proposed.

## Final command and verification

Final adapter SHA-256:
`5f87442dcfb6210335fec648e1e6f8a333d51b6fec23113d894b18c6583df5ea`.

Review only:

```sh
python3 -B tools/dev/checkpoint-n.py
```

Exact proposed single-use command — **NOT executed or authorized**:

```sh
python3 -B tools/dev/checkpoint-n.py \
  --execute \
  --approve single-use-fresh-sql-initdb-secret-helper-independent-roles-eight-negative-cases-retain-volumes-evidence \
  --contract-sha256 5f87442dcfb6210335fec648e1e6f8a333d51b6fec23113d894b18c6583df5ea \
  --exclusive
```

Separately scoped live approval must explicitly cover the M resource/runtime
identities, Docker preflight/create/start, fresh initdb, bootstrap helper stdin
secret injection, synthetic schema/roles/grants/exact AUDIT/eight negative cases,
readiness probes and guarded current-run stops, with external serialized port
and runtime access. Retain all volumes/evidence. No Prisma migrations, real env
files, application suites, old resources or deletion are included.

Verification: `python3 -B tools/dev/checkpoint-n.test.py` — 24 PASS; E/F/F-env/G/M
— 6+23+18+19+16=82 PASS; 106 total. Default N CLI — REVIEW_ONLY, matching hash;
incomplete execution gates reject before evidence/runtime (subprocess regression).
Existing G review hash unchanged. `git diff --check` — PASS.

N supplies an enabled execution entry (`liveEnabled=true`) behind software gates;
this does not grant live authority. N preparation COMPLETE; stop at manual gate.

## Remaining limits

Simulated tests are not PostgreSQL parsing/effective-privilege, Windows/WSL port,
image UID/GID or Docker lifecycle proof. Fixed runtime/image identity and resource
availability have not been rechecked live. Subprocesses use a fixed minimal PATH;
missing Docker/PowerShell fails closed and must be resolved before a fresh live
attempt. K root cause remains UNKNOWN; full 20-migration compatibility and local
development baseline remain incomplete. No application DB-backed suites ran
because their setup implicitly deploys migrations.
