# Checkpoint V — executable-discovery specification (2026-10-14)

## Status and purpose

Repository-only specification; no live discovery authorized or performed.
The contract answers one question: does the existing explicit R search domain
return a candidate for the literal name `docker` at the time of one lookup?
It does not seek other installations or propose a PATH correction. U findings
and their limits remain authoritative in `checkpoint-u-diagnosis.md`.

## Candidate domain and allowed operation

The sole proposed future discovery operation is exactly:

```python
shutil.which('docker', path='/usr/local/bin:/usr/bin:/bin:/mnt/c/Windows/System32/WindowsPowerShell/v1.0')
```

This domain is copied from R's repository constant, not inferred from the host.
Use its existing order and platform-native `shutil.which` semantics; do not
enumerate directories or run a separate lookup for each component. Platform
semantics can consult executable suffix rules and follow filesystem links:
this is a lexical search domain, not a guarantee about a candidate's physical
location. This contract does not authorize reading caller PATH, HOME, env files,
registry or additional locations. It does not authorize explicitly inspecting
PATHEXT or other caller variables. An implementation must review implicit
platform environment dependencies before proposing a live command; if it cannot
bound them to the reviewed environment, preparation must stop.

Do not launch the candidate, resolve its symlink, read contents, hash it, query
version, invoke a shell or inspect runtime identity. Only filesystem access
inherent in that single lookup is proposed. No Docker command, installation,
PATH change, DB suite, migration or resource lifecycle operation is included.

## Metadata, classification and redaction

Persist only a reviewed schema containing fixed contract/run identifiers,
phase/event names, status/cause enums, `available` (boolean or null when lookup
did not return), `evidenceStarted`, `recordingFailed` and a no-deletion
`retentionPolicy`. Never record resolved candidate paths, raw environment,
exception messages, stack traces, stdout/stderr or candidate contents.

A nonempty lookup return yields AVAILABLE/available=true; None yields
NOT_FOUND/available=false. Raised PermissionError yields PERMISSION_DENIED;
other OSError yields OS_ERROR; other exceptions yield UNKNOWN, with
available=null. Malformed injected return types yield INVALID_RESULT rather
than coercion. These are lookup outcomes, not explanations of underlying
filesystem failures. AVAILABLE proves neither launchability nor runtime identity.
Even AVAILABLE terminates discovery; it cannot trigger a runtime probe.

## Identity, durability and stopping

Reserve new identity `sl-v-discovery-20261014-01` for a future reviewed proposal,
with evidence at `artifacts/local-env/sl-v-discovery-20261014-01/discovery.jsonl`.
Reservation in this document creates no artifact and consumes no live permission.
Never adopt or retry R/T, N/P or H/I/K identities. If this reserved directory
already exists when a future implementation runs, block before lookup; do not
inspect, overwrite, delete or choose another identity automatically.

Before lookup, validate explicit human-approved scope, exact source-bound
contract hash and externally serialized unchanged source/tooling/evidence state.
Atomically create a protected directory (0700) and file (0600), then durably
record/fsync begin and sanitized lookup intent. Guard or recorder failure stops
before lookup. Attempt lookup at most once, then record its outcome and complete;
any failure blocks further activity. Never retry in the same or another run.
Retain all evidence, including partially initialized artifacts, on every outcome.
No automatic cleanup is permitted. A future attempt requires a new reviewed
identity and separate authorization.

Report retention policy separately from evidence initialization success. Any
record/close failure makes the final result BLOCKED with recordingFailed=true,
even if an earlier durable event says AVAILABLE. Return sanitized status as a
fallback when evidence storage fails; do not claim durable final evidence then.
There is no promised overall wall-clock bound for filesystem lookup or evidence
I/O; do not present a subprocess timeout as a discovery deadline.

## Prerequisites for a runnable approval proposal

V intentionally introduces no executor, live CLI command or approval hash.
R's historical command/hash is consumed and cannot execute this contract.
A later repository-only checkpoint may implement this specification and must:

- Default to pure REVIEW_ONLY without lookup, caller environment inspection or
  evidence creation; incomplete CLI gates also perform no discovery.
- Bind the exact operation, domain, schema, identity, environment dependencies
  and loaded implementation sources to a newly reviewed contract digest.
- Test success, absence, all exception classifications, invalid return types,
  incomplete approval, source drift, existing identity, initialization/write/close
  failures and redaction with explicitly injected lookup callables and temporary
  fixtures. No installed executable discovery or fixture launch in tests.
- Produce the exact runnable command and source hash for review, documenting
  platform/environment semantics and remaining timing/race limitations.

Only after that concrete proposal exists may separate explicit live authorization
be requested. Software flags and a generic next-checkpoint approval cannot supply
it. If broader discovery is needed, first specify the additional domain and
metadata in a new repository review; never widen this domain during execution.

## Verification and next gate

V verification checks the literal domain against R's source and reviews these
requirements against U and R evidence/retention limits. No implementation changed,
so lookup/runtime test suites are not needed for this documentation-only slice.
Stop at AGENTS.md section 1 after recording V results. Suggested next checkpoint:
repository-only implementation and injected verification of this contract, with
no live operation authorized by that suggestion.
