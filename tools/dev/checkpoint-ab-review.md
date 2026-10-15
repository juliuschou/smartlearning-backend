# Checkpoint AB — composed AA/Y/Z review (2026-10-14)

## Scope and findings

Repository-only review found no concrete defect requiring AA/Y/Z implementation
changes. AB adds six focused injected cases in `checkpoint-ab.test.py`, reusing
AA's fixture class and eleven inherited cases. Expected binding inputs are
detached at AA construction; Y independently detaches execution inputs. AA
validates its separate digest and Y linkage before authenticating the binding,
then delegates to Z and rechecks binding and manifest continuity. Y invokes
the composed verifier before evidence and after durable intent.

New cases establish that missing supplied sections and each missing reviewed
adapter commitment block before evidence/lookup; a structurally valid different
Y manifest cannot reuse the AA binding; later caller edits do not rewrite the
constructed verifier's binding; loaded-supplier, binding-authenticator and
observation callback mutations of the verifier binding are rejected. Second-guard
binding authentication failure skips both lookup and second Z verification,
retains begin/intent/outcome/complete fixture evidence and reports GUARD_BLOCKED
without recordingFailed. Evidence contractId remains Y's digest, not AA's digest.

No additional executor, binding format, source commitment set, Y metadata or CLI
behavior was introduced. These cases exercise public composed outcomes rather
than supplying an external deployment or interpreting fixture hashes as trust.

## Verification and limits

- `python3 -B tools/dev/checkpoint-ab.test.py`: 17 PASS (6 new, 11 inherited).
- `python3 -B tools/dev/checkpoint-aa.test.py`: 11 PASS.
- `python3 -B tools/dev/checkpoint-z.test.py`: 5 PASS.
- `python3 -B tools/dev/checkpoint-y.test.py`: 15 PASS.
- `git diff --check`: PASS after final documentation update.

Initial AB setup failed because a fixture method with zero-argument super() was
assigned to an unrelated TestCase. Subclassing the fixture corrected that test
composition error; production implementation was unchanged. Entry over-read and
fixture error are recorded in tasks/lessons.md.

All storage and lookup results were injected/unittest-owned. No host/interpreter
or tool discovery, caller environment inspection, candidate launch, production
identity access, external artifacts, Docker, DB suites/migrations, cleanup,
staging, commit or push occurred. Prior workspace changes remain preserved.

Matching supplied bytes cannot prove actual loaded callable identities or a
complete closure. Independent binding authentication must cover AA's digest,
its Y linkage, loaded Y/Z/AA code, adapters/dependencies and serialized continuity
through lookup; Z observation authentication remains separate. Callback tests
cover detected persistent mutation, not dishonest suppliers, restored mutations
or changes after the final guard. No external authenticated artifact or live
adapter exists; status remains REVIEW_ONLY.

Medium risk trust-boundary review with no deployment rollout. Rollback removes
only AB test/review and its task/lesson additions. Any next repository slice needs
a concrete justified objective; obtaining external deployment artifacts or live
verification requires separately explicit scope. Generic next-checkpoint approval
does not authorize host exploration/provisioning. Stop under AGENTS.md §1.
