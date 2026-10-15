# Checkpoint AA — supplied Y/Z and adapter binding (2026-10-14)

## Delivered artifact

`checkpoint-aa.py` defines `sl-aa-binding-v1` and a separate canonical SHA-256
binding digest. Its exact fields are format, yContractId, repositorySources,
adapterSources and dependencyClosure. Repository commitments include V/X/Y/Z/AA.
The five explicit adapter roles are observe, authenticate, lookup, loadedSources
and recorder. A nonempty, explicitly reviewed dependency closure is mandatory;
it must cover the actual implementation/import dependencies of the comparator,
binding layer and adapters, including the binding authenticator and source
supplier. Named fixture closure entries do not establish a complete closure.

Expected commitments and digest are supplied review inputs. There is no factory
that accepts filesystem hashes as its own trusted baseline. Test-only source
reads and synthetic adapter bytes are fixtures, never deployment commitments.
`BoundVerifier` detaches expectations, checks the new binding digest, checks the
Y manifest/contract linkage and supplied bytes for every commitment, independently
invokes authenticate_binding(binding, digest), then invokes the supplied Z
ObservationVerifier. Missing/extra sections or sources, changed bytes, non-bytes,
failed/exceptional authentication, authentication mutation and manifest drift
reject with False and no raw diagnostics. Y invokes this wrapper at both guards.

## Integration and trust limits

The AA digest is distinct from Y's historical digest. Y's event contractId and
V metadata remain unchanged and identify only Y's contract. They are not proof
of AA binding authentication. The reviewed external proposal must separately
name and authenticate the AA digest, with serialization covering that exact
binding, Y contract/run and actual loaded callables through lookup. The new
binding contains the Y digest; Y's digest does not contain AA.

No actual reviewed external binding artifact, live observation/authentication
adapter or authenticated deployment exists. An injected loaded supplier can lie;
equality does not establish the identity of a supplied callable, immutable imports
or complete closure. authenticate_binding must independently authenticate actual
loaded Y/Z/AA bytes, all adapters/dependencies and externally serialized continuity
through lookup. Z still requires its separate observation authentication. Repeated
checks do not close the interval after the last guard. Neither booleans nor hashes
confer human permission. This is repository binding preparation only, not a live
executor proposal. Y implementation and CLI remain unchanged and REVIEW_ONLY.

## Verification, risk and next gate

`python3 -B tools/dev/checkpoint-aa.test.py`: 11 tests PASS (6 binding tests and
5 inherited Z observation tests), including each source/adapter/closure entry's
missing/changed/extra/invalid subcases, legacy digest rejection, changed commitment
digest rejection, missing binding fields, authentication failure/exception/mutation,
Z authentication failure, second-guard retention, single lookup and sanitized
recorder close failure overriding AVAILABLE.
`python3 -B tools/dev/checkpoint-z.test.py`: 5 tests PASS.
`python3 -B tools/dev/checkpoint-y.test.py`: 15 tests PASS, retaining CLI gates,
lookup classifications, redaction, identity and recorder durability/failure coverage.
`git diff --check`: PASS.

Medium risk trust-boundary preparation; no deployment rollout. Rollback removes
only AA implementation/test/review and its task entry; preserve earlier work.
No installed tooling discovery, caller environment inspection, candidate launch,
production reserved-identity access, provisioning, Docker, DB suites, migrations,
production cleanup, commit or push. Tests use unittest-owned temporary fixtures.
Next gate remains separately supplied reviewed, externally authenticated binding
and deployment artifacts plus explicit scope for any external reads/provisioning.
Generic checkpoint authorization cannot authorize obtaining those from the host.
Stop under AGENTS.md §1.
