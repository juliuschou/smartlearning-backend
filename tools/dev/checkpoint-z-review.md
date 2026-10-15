# Checkpoint Z — supplied trust-boundary observations (2026-10-14)

## Delivered scope

`checkpoint-z.py` supplies an explicitly injected `ObservationVerifier` callable
for Y's `verify` boundary. It compares a supplied full deployment observation
against the reviewed manifest, including platform, repository hashes, upstream
source/build, import/loader closure commitments, startup/bootstrap and supervisor
attestations. Serialization observations must bind the same contract/run and an
exact JSON boolean continuity assertion. Missing/extra fields or drift reject.
Inputs are detached and authentication mutations reject; exceptions return False
without exposing raw diagnostics. No Y implementation or CLI behavior changed.

Observation shape: exactly `deployment` (the full X/Y manifest) and
`serialization` (`contractId`, `runId`, `unchangedThroughLookup: true`). The
explicit `authenticate(expected, observed)` callback must return exactly True.
It must independently authenticate external provenance and unchanged state
through lookup; equality checks are performed before this callback. Hashes are
commitments, not file enumeration or proof that code actually loaded. Both Y
guards invoke the comparator, so supplied drift after intent blocks lookup while
retaining the fixture evidence.

## Trust and deployment limits

This is a concrete comparison implementation, not an authenticated external
verifier/supervisor. No live observation supplier or authenticator exists.
Fixture True callbacks and continuity booleans establish decision logic only.
There is no real loaded-code/import inventory, host/platform check, attested
deployment, live command/hash or human live approval. CLI remains REVIEW_ONLY.
V/X/Y remain authoritative; unknown closure entries must change the commitment
or be rejected by the independent authenticator. A dishonest observation supplier
cannot be detected by equality alone.

Z is not added to Y's historical source set: no live adapter uses it. Any future
deployment proposal using this comparator must bind its loaded bytes, dependencies
and observation/authentication adapters into a newly reviewed source/closure
digest. Reusing Y's digest as proof of Z's code would be invalid. External
serialization must cover the interval after the last guard through lookup;
repeated fixture comparisons cannot eliminate that race.

## Verification and next gate

`python3 -B tools/dev/checkpoint-z.test.py`: 5 tests PASS with subcases covering
deployment/platform/source/import/bootstrap/supervisor drift, missing/extra
observation fields, serialization drift, integer boolean impostors, authentication
failure/exception/mutation and second-guard rejection with retained evidence.
Matching fixtures invoke authentication twice and perform exactly one injected
lookup. Reuses Y's temporary fixture setup; no candidate launch or production
identity access. `python3 -B tools/dev/checkpoint-y.test.py`: 15 tests PASS.
`git diff --check`: PASS.

No installed-tool discovery, caller environment inspection, provisioning, Docker,
application/DB suite, migration, production evidence access, cleanup, commit or
push. Rollback removes only Z files/task entry; preserve prior work and evidence.
Next gate needs separately supplied external deployment artifacts and a scoped
authenticated supervisor/observation implementation. Generic checkpoint approval
does not authorize obtaining those from the host. Stop under AGENTS.md §1.
