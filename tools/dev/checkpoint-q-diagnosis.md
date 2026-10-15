# Checkpoint Q — repository-only transport diagnosis

Date: 2026-10-14. Authorization: repository inspection and fully mocked tests only.

## Findings

No demonstrated implementation defect warrants changing the bound sources.
P's actual transport root cause remains UNKNOWN. Fixed PATH is not proof of
executable availability, and availability was not probed in this checkpoint.

`checkpoint-n.py:Adapter.__init__` discards inherited PATH and supplies exactly:

```text
/usr/local/bin:/usr/bin:/bin:/mnt/c/Windows/System32/WindowsPowerShell/v1.0
```

The subprocess environment contains only this PATH; it does not inherit HOME,
Docker overrides or other caller environment. This is an intentional constrained
environment in the reviewed source. Repository inspection cannot establish
whether installed tooling and configuration can operate under it. Do not add
HOME, widen PATH or adopt another runtime identity speculatively.

`Adapter.preflight` starts with `Adapter.guard`, which calls
`checkpoint-f.py:Executor.runtime_identity`. Its ordered commands are:

1. `docker --context <pinned-context> context show`
2. `docker --context <pinned-context> context inspect <pinned-context>`
3. `docker --context <pinned-context> info --format {{.ID}}`
4. `docker --context <pinned-context> image inspect <pinned-image-id>`

No intermediate guard command is recorded as a completed lifecycle event.
Failure at ANY of these four commands can therefore produce P's
`begin/blocked/complete` evidence. The observed result does not prove that the
first command failed.

`checkpoint-m.py:diagnostic_run` behavior:

| Simulated boundary result | Public classification |
| --- | --- |
| FileNotFoundError, PermissionError, other OSError | TRANSPORT_UNAVAILABLE |
| subprocess.TimeoutExpired | TRANSPORT_UNAVAILABLE |
| Successful exit, invalid UTF-8 stdout | TRANSPORT_UNAVAILABLE |
| Nonzero exit without an allowlisted SQLSTATE error prefix | UNKNOWN |
| Nonzero exit with an allowlisted SQLSTATE error prefix | That SQLSTATE |
| Successful exit and UTF-8 stdout | Decoded output; guards still must validate it |

Raw exception messages, stdout and stderr are suppressed on failure. This
preserves secret safety but loses the failure phase and underlying cause.
A nonzero Docker exit without SQLSTATE would be UNKNOWN, so generic daemon or
configuration failure must not be asserted from TRANSPORT_UNAVAILABLE.

## Deterministic verification

- `python3 -B tools/dev/checkpoint-m.test.py`: 19 PASS. Added availability,
  permission/format, invalid UTF-8, explicit environment forwarding and nonzero
  runtime-exit classification checks; existing timeout/redaction checks pass.
- `python3 -B tools/dev/checkpoint-n.test.py`: 25 PASS. Added 16 mocked cases:
  four failure kinds at each of the four initial guard commands. All reproduce
  BLOCKED/TRANSPORT_UNAVAILABLE, checks=[], errors=[lifecycle-blocked],
  unresolvedCreates=[], recordingFailed=false and begin/blocked/complete only.
  Every subprocess receives the exact minimal PATH, despite an injected
  inherited PATH. No port probe, credential generation, creation or retry is
  reached. subprocess.run is patched for all these cases; evidence exists only
  in temporary fixtures.
- `python3 -B tools/dev/checkpoint-n.py`: REVIEW_ONLY; unchanged SHA-256
  `5f87442dcfb6210335fec648e1e6f8a333d51b6fec23113d894b18c6583df5ea`.

These tests prove the classification/guard behavior, not actual Docker/PATH
availability, PostgreSQL behavior or the historical P failure cause. Only test
and documentation files changed; no bound implementation was changed.

## Next scope and manual gate

Repository evidence cannot resolve P's actual cause. Before any further runtime
diagnosis, prepare a separate review-only read-only probe contract with exact
commands/hash, the same fixed environment and pinned runtime identity, bounded
timeouts, and allowlisted phase/cause/identity-match booleans only. Proposed
probe scope: executable lookup under the fixed PATH plus the four existing
initial identity reads above. No raw diagnostics, Docker lifecycle, ports,
SQL, old-container/volume reads, initdb, migrations or real environment files.
Running that probe requires explicit separate authorization; Q grants none.

Suggested Checkpoint R is repository-only preparation and simulated tests of
that bounded probe and its concrete review. Do not request another SQL lifecycle
attempt yet: no justified runtime correction has been established. If one later
becomes necessary, first prepare a fresh resource/evidence identity and refreshed
source-bound command/hash review, then obtain explicit single-use live approval.
The consumed sl-m-20261014-01 identity and all H/K/P resources/evidence remain
untouched; the unchanged N hash is not renewed human authorization.

K's historical SQL root cause, actual privilege validation, migration
compatibility and development baseline remain incomplete. Application suites
were not run because test/setup/db.ts implicitly migrates and no such permission
was granted. Broader historical suites were not rerun: no implementation change
requires them, and the targeted M/N suites cover the examined transport boundary.
