# Checkpoint Y — repository-only injected executor (2026-10-14)

## Delivered scope

`checkpoint-y.py` implements V's single-attempt classification/retention flow
against X's proposed manifest shape. No historical executor is imported.
Default and all CLI flag combinations are REVIEW_ONLY. There is no production
lookup, runtime runner, external attestation verifier, interpreter selection,
live command or approval hash. No candidate path or raw exception enters results
or the fixed event schema. AVAILABLE terminates the operation.

`Discovery` requires explicit lookup, verifier, loaded-source supplier and recorder
callables. Only temporary fixture adapters were exercised in Y. Source expectations
are supplied review inputs; they are compared to supplied loaded bytes, not created
from filesystem contents inside the executor as a trusted baseline. The digest
binds V/X/executor source hashes, manifest/build/closure/bootstrap attestations,
operation/domain, identity, schema and classifications. A verifier mutation causes
a second digest comparison to reject the operation. Boolean approval fields must
be JSON booleans, not integers. Full supplied inputs are frozen before use.

## External trust obligations and limits

A structurally valid manifest and matching fixture source bytes do not prove
that CPython actually loaded those artifacts. `verify(manifest)` is an explicit
external trust boundary: before returning exactly True it must authenticate the
reviewed deployment, actual loaded repository/import identities, pinned upstream
commit/source, platform/startup, immutable full closure and externally serialized
state through the lookup. The artifact fields are closure digest commitments,
not a claim that Y enumerated or audited the underlying files. Unknown imports,
platform/source/build drift, missing attestation or failed serialization must
return false or raise. Y supplies no implementation of this external verifier.
Tests returning True simulate that boundary; they establish no real attestation.
No real deployment artifact or host compatibility was verified.

The evidence adapter requires an existing trusted parent, checks only parent
state, and creates V's identity exclusively. It never reads an existing identity.
Created directory/file modes are 0700/0600. Directory creation is reported even
when file creation fails. Directory/parent fsync precedes durable begin/intent;
lookup follows those events and a renewed gate. Each event is written fully and
fsynced. Close/write/fsync failure overrides any prior AVAILABLE with sanitized
BLOCKED fallback and recordingFailed=true. All partial artifacts are retained.
A failed final/close event is not claimed as durable final evidence. No retry,
cleanup or wall-clock deadline is promised. Concurrent state safety relies on
X/V's external serialization; local checks alone cannot remove filesystem races.

## Verification

`python3 -B tools/dev/checkpoint-y.test.py`: 15 tests PASS, explicit callables and
fixture-owned temporary directories only. Cases include default/incomplete/CLI
gates, exact lookup arguments and single use, AVAILABLE/NOT_FOUND, malformed
results, PermissionError/OSError/other exceptions including interruption,
redaction, manifest/source/digest/approval drift, verifier mutation, second-gate
failure, durable intent ordering, modes, existing identity, unsafe/symlink parent,
partial initialization, factory/open/begin/intent/outcome/complete/close failures,
fsync/zero-write failures and schema extra-field rejection. Fixture cleanup is
owned by unittest temporary directories, not executor evidence cleanup.

`git diff --check`: PASS. No application suite, lookup of installed executables,
candidate launch, caller environment inspection, deployment discovery/provisioning,
Docker, DB/migration, reserved production identity access, cleanup, commit or push.

## Next gate

Y completes repository-only injected executor preparation, not a runnable live
proposal. A future separately scoped review must supply concrete externally
attested immutable deployment artifacts, implement/authenticate the trusted
supervisor/verifier and bind actual loaded bytes plus exact command/hash and
permitted reads. Do not discover/provision that deployment on generic checkpoint
permission. Keep REVIEW_ONLY until those requirements and distinct human live
scope exist. Rollback removes only Y implementation/tests/review/task/lesson
additions; preserve older work and retained evidence. Stop under AGENTS.md §1.
