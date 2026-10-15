# Checkpoint R — bounded read-only transport probe review (2026-10-14)

## Authority and acceptance

R authorizes repository preparation and fully simulated tests only. No actual
executable lookup, runtime query or execute command was performed. This proposal
requires separate explicit single-use approval. Its software approval string
and liveEnabled=true are not human permission. P/N and H/I/K approvals remain
consumed; their resources and evidence are protected.

The isolated `checkpoint-r.py` defaults to pure REVIEW_ONLY, reading repository
sources only. It does not execute N's adapter or modify its bound sources. The
probe binds its loaded source snapshot, N/M/F/E/role sources, exact commands,
fixed environment and identity expectations to the reviewed hash. Sources must
be trusted and unchanged throughout execution; hash guards cannot eliminate an
outside actor racing edits/imports. No environment file is read.

## Exact proposed future scope

Fresh evidence identity: `sl-r-20261014-01`.
Evidence: `artifacts/local-env/sl-r-20261014-01/probe.jsonl`.
Only environment: PATH=`/usr/local/bin:/usr/bin:/bin:/mnt/c/Windows/System32/WindowsPowerShell/v1.0`.
No HOME, Docker overrides, caller PATH or connection variables are forwarded.
Executable lookup: `shutil.which('docker', path=<fixed PATH>)`; only availability
is reported, not the resolved path. Execution continues using `docker` by name,
matching N's transport behavior; lookup cannot guarantee later launch availability.

Then, in order, at most once each:

```text
docker --context default context show
docker --context default context inspect default
docker --context default info --format {{.ID}}
docker --context default image inspect sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54
```

Expected context: `default`; endpoint: `unix:///var/run/docker.sock`;
engine: `8820f44b-5227-4afe-8eff-245fcc9e8a31`;
image: the exact SHA-256 above. These are approval-bound expectations, not claims
of current verified identity. A mismatch stops further reads; no runtime identity
is adopted or silently changed.

Each command uses repository cwd, stdin=DEVNULL, stdout/stderr captured privately,
check=false and a 30-second timeout. Four commands give a maximum configured
120 seconds of subprocess timeouts; process creation, lookup and evidence I/O
are not an overall wall-clock bound. Captured output has no byte/memory cap.
No retries or raw diagnostics are returned. No PowerShell or port check, Docker
creation/start/stop/restart/deletion, old container/volume query, SQL, initdb,
Prisma migration, real env file access, application suite or cleanup is included.

## Failure, evidence and retention

Execution first validates approval/hash/exclusivity, then atomically creates the
fresh protected evidence directory (0700) and JSONL (0600), recording/fsyncing
begin before lookup. Existing directory consumes the identity and blocks any
new lookup/command. Each operation is preceded by source/contract guards and a
durable sanitized intent. Lookup unavailability, transport failure, invalid
result or identity mismatch stops immediately. Guard/recorder failures block
further reads. Evidence is retained on success and failure, including partial
initialization; no cleanup or retry is proposed.

Only fixed phase/cause names and availability/match booleans enter checks.
The transport distinguishes NOT_FOUND, PERMISSION_DENIED, OS_ERROR, TIMEOUT,
DECODE_ERROR, NONZERO_EXIT, INVALID_RESULT and UNKNOWN without raw exception
messages/stdout/stderr. Guard/recording failures have separate fixed causes.
An observed current failure does not establish P's historical cause.

`evidenceStarted` means the recorder successfully completed initialization; false
can coexist with a partially created directory/file. `retentionPolicy` describes
no-deletion policy, not proof of artifact existence. `recordingFailed` tracks any
recorder failure, including close/complete failure. Storage failure can prevent
final durable evidence; sanitized returned stdout is then the fallback. A close
failure may be reported after a durable complete event recorded VERIFIED; the
returned recordingFailed=true/BLOCKED must take precedence in that case.

`--exclusive` asserts trusted unchanged sources and externally serialized access
to runtime configuration/tool installation/evidence while observing the pinned
identity. Atomic directory creation protects this fixed run from cooperating
reuse; it is not a lock over unrelated outside actors. No runtime configuration
or tooling correction is part of this probe.

Repository rollback: revert only R files/current notes, preserving prior changes.
Future runtime rollback: none needed because the allowed operations are read-only;
retain newly created evidence. Any deletion needs separate authorization.

## Exact command awaiting separate approval

Contract SHA-256: `8e080f97ffe1bae0eae30ba9c132e06a66066f91d4be1b3845cbbfd222c8c913`.

Review only:

```sh
python3 -B tools/dev/checkpoint-r.py
```

Proposed single invocation — NOT executed or authorized by R:

```sh
python3 -B tools/dev/checkpoint-r.py \
  --execute \
  --approve single-use-read-only-fixed-path-four-runtime-identities-retain-evidence \
  --contract-sha256 8e080f97ffe1bae0eae30ba9c132e06a66066f91d4be1b3845cbbfd222c8c913 \
  --exclusive
```

Approval must explicitly accept the exact command/hash, lookup plus four reads,
pinned identities/minimal environment, fresh evidence retention, no retry and
exclusivity assertion above. It grants no new SQL lifecycle attempt or reuse of
P's identity. If sources/contract change, refresh review/hash before live approval.

## Verification and limits

- `python3 -B tools/dev/checkpoint-r.test.py`: 13 PASS; includes 28 transport
  failure cases across all four phases, lookup availability/errors, mismatches,
  malformed shapes, recording/close failures, invalid gates/plan drift, loaded
  and midrun source drift, same-instance/evidence reuse, unsafe roots, redaction
  allowlists and default/incomplete CLI non-execution.
- M 19 PASS and N 25 PASS: 57 total with R. N REVIEW_ONLY hash unchanged:
  `5f87442dcfb6210335fec648e1e6f8a333d51b6fec23113d894b18c6583df5ea`.
- R REVIEW_ONLY returns the exact proposed commands/hash. Focused independent
  subagent review found no blocking defect; ambiguous retention reporting was
  corrected and tested. Output-capture limits are documented above.
- `git diff --check`: PASS.

All lookup/runtime behavior was simulated; current executable/runtime availability
and historical P failure remain unproven. K SQL root cause, effective privileges,
migration compatibility and development baseline remain incomplete. Broader
historical suites were not repeated for this isolated addition. Application DB
suites were excluded because their setup implicitly migrates without permission.
No live query, environment update, resource cleanup, commit or push occurred.

R preparation COMPLETE. Stop at the AGENTS.md manual checkpoint gate; a generic
next-checkpoint approval permits repository review only, not the command above.
