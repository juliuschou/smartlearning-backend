# Checkpoint U — fixed-PATH lookup diagnosis (2026-10-14)

## Findings

R `PATH`/`plan` and N `Adapter.__init__` supply the same fixed PATH. R
`Probe.step` calls `shutil.which("docker", path=...)`, reduces its result to a
boolean, and then launches the reviewed argv using `docker` by name and the
same minimal environment. No source defect or justified replacement PATH was
established. Approval-bound implementation sources are unchanged.

The six tests in `checkpoint-u.test.py` use injected calls and isolated temporary
fixtures only. Missing candidates, a nonexecutable regular file, a directory,
and an executable candidate outside the search domain all produce lookup
NOT_FOUND/available=false. A regular file with execute permission can produce
AVAILABLE even when its contents are not a valid executable; no fixture is
launched. Thus availability does not establish launchability or runtime identity.
An injected PermissionError maps to PERMISSION_DENIED, whereas a nonexecutable
candidate rejected by which maps to NOT_FOUND. Classification distinguishes
raised exceptions, not every underlying filesystem reason for lookup failure.

A simulated successful lookup followed by FileNotFoundError at context-show
produces BLOCKED with one launch attempt and no later reads or retry. Such a
launch error does not identify whether the executable, interpreter or other
launch prerequisite was missing. No actual cause is inferred from this simulation.

T's existing lookup NOT_FOUND proves only that its reviewed lookup returned no
available candidate. It cannot prove absence in other paths, actual permission
state, executable installation, pinned runtime identity or historical P cause.

## Verification and decision

- `python3 -B tools/dev/checkpoint-u.test.py`: 6 PASS.
- `python3 -B tools/dev/checkpoint-r.test.py`: 13 PASS.
- Pure `python3 -B tools/dev/checkpoint-r.py`: REVIEW_ONLY; hash unchanged at
  `8e080f97ffe1bae0eae30ba9c132e06a66066f91d4be1b3845cbbfd222c8c913`.
- `git diff --check`: PASS.

No M/N suite rerun was required: their implementations and bound sources were
not changed; U directly tests R/N environment agreement. Application DB suites
were excluded because implicit migrations are not authorized. No caller PATH,
actual installation, executable availability or runtime query was inspected.
No migration, evidence cleanup, commit or push occurred.

No fresh live proposal/identity/command is prepared: there is no evidence-backed
PATH correction. R/T and N/P identities remain consumed; the unchanged hash is
not renewed authorization. A possible next checkpoint is repository-only
preparation of a narrowly specified discovery contract, defining candidate scope,
allowed metadata, retention and stop conditions before requesting separate live
authorization. It must not silently widen PATH or guess an executable location.

U complete. Stop under AGENTS.md section 1 at the human checkpoint gate.
