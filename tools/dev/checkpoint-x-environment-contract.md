# Checkpoint X — proposed discovery environment contract (2026-10-14)

## Status and authority

Repository-only proposal and semantic review, authorized from the after-W
handoff. This completes X preparation, not W's deferred executor. V remains
authoritative for the operation, domain, identity, schema, durability and tests;
this document does not duplicate or widen them. No live command/hash exists.
No assertion here describes the host or installed Python.

## Concrete supported-environment proposal

Propose Linux POSIX, CPython 3.12.0 final, upstream unmodified semantics, with
os.name=posix, sys.platform=linux, posixpath, pathsep colon, UTF-8 filesystem
encoding and no monkeypatching, injected import hooks or third-party startup
code. This is a narrow semantic reference for review, not a recommendation to
install an old release. Another patch version requires source re-review and a
new digest; version-family compatibility alone is insufficient. Windows and
other Python implementations are unsupported by this proposal.

Require a separately supplied, immutable deployment manifest identifying an
absolute interpreter path, executable/build digest, exact upstream commit and
source archive digest, build configuration, stdlib/import closure, loader/shared
library digests and trusted launcher. There are no placeholder values that may
pass verification. X neither supplies nor discovers such a deployment.

## Authoritative semantic review

Reviewed upstream tag v3.12.0, not installed modules:

- [shutil.py](https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/shutil.py),
  `_access_check` and `which` (1377–1458): explicit nonempty path skips the PATH
  and confstr fallback. String arguments skip byte decoding. Linux skips both
  Windows current-directory insertion and PATHEXT. Components retain order;
  normcase deduplicates them; each is joined with docker. Access checks require
  existence, executable access and non-directory status. No candidate is run.
  Importing the entire module also imports dependencies, including optional
  compression modules; those belong to the trusted import closure.
- [posixpath.py](https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/posixpath.py),
  `_get_sep`, `split`, `normcase`, `join`: string operations and fspath preserve
  these literal absolute components; no home expansion, realpath or directory
  enumeration. No empty component introduces the current working directory.
- [os.py](https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/os.py),
  POSIX import branch and `fsdecode`: selects posixpath; string input remains
  unchanged. Module initialization constructs an environment mapping. Therefore
  no caller environment may be inherited even though which itself skips it.
- [genericpath.py](https://raw.githubusercontent.com/python/cpython/v3.12.0/Lib/genericpath.py),
  `exists` and `isdir`: stat follows links; OSError/ValueError become false.
  Consequently NOT_FOUND cannot establish why filesystem checks failed.
- [posixmodule.c](https://raw.githubusercontent.com/python/cpython/v3.12.0/Modules/posixmodule.c),
  `os_access_impl`: native access checking depends on credentials and filesystem
  policy. Default access uses real IDs and follows links. Native stat/access,
  libc, kernel, mounts/ACLs and concurrent changes remain trusted operating
  dependencies, not evidence of launchability. No content read is needed.

Review covers the reachable lookup branch and named helpers, not a security
audit of CPython's entire import/build closure. The latter must be attested as
an immutable deployment artifact before live use. Semantic source tags alone
are not loaded-code attestations.

## Bootstrap, permitted reads and source binding

Future launch must use a trusted process supervisor with an explicit environment
replacement (only fixed LC_ALL=C.UTF-8), fixed repository cwd and an absolute
manifest-supplied interpreter; no shell/PATH search or env utility discovery.
The supervisor must not log or enumerate inherited environment values. It must
also exclude loader injection before interpreter startup. Proposed interpreter
options: isolated mode, no site import, no bytecode writes, UTF-8 mode
(`-I -S -B -X utf8`). These are requirements, not a runnable approval command.
[Official command-line documentation](https://docs.python.org/3.12/using/cmdline.html)
explains isolated/site flags; the page tracks 3.12 maintenance releases, so the
future implementation must bind the corresponding pinned startup source too.
Flags alone do not authenticate a binary or its imports.

Trust starts at the externally attested supervisor/deployment, before Python
runs. Self-reported version or hashing a source file after an untrusted import
cannot establish this root. The immutable manifest must cover frozen modules,
bytecode, extension modules and optional imports as actually packaged; hashing
only shutil.py or using -B is insufficient. Source-only imports or their exact
bytecode/frozen equivalents must be bound to the reviewed source. No arbitrary
sys.path enumeration/import probing is allowed to repair a mismatch.

Proposed future verification allowlist: manifest-listed interpreter/toolchain
files and stdlib closure, repository implementation snapshots, in-memory
implementation/version/platform/flags/module identities, and V's exact evidence
parent/state operations. These reads require explicit approval in the later live
scope; they are not authorized by X. Verification must never read candidate
contents, resolve candidate links, inspect caller variables or scan directories.
Keep the deployment immutable and externally serialize sources/tooling/evidence
through verification and the single lookup. Block before evidence/lookup on
missing manifest, mismatch, unsupported platform, unknown import, mutable
closure or unavailable supervisor attestation; no fallback interpreter.

The new contract digest must canonically bind this environment proposal, V's
requirements, executor and loaded repository bytes, reviewed upstream commit/
source hashes, deployment manifest and artifact hashes, bootstrap/options,
allowed reads and schema. Verification must compare loaded implementation to
that manifest; historical R hashes remain consumed. Expected hashes must come
from reviewed artifacts, never from unreviewed files accepted as their own
baseline. Fixed digest/manifest references belong in the approval proposal;
V's runtime metadata allowlist remains unchanged. Do not emit module/candidate
paths, environment or raw verification errors into evidence.

## Next gate and verification criteria

Next repository checkpoint can implement REVIEW_ONLY defaults and injected
verification against this explicit proposed environment, including rejection of
absent deployment attestations and platform/source/import drift. It must retain
V's full injected lookup/recorder suite. Tests use supplied manifests, callables
and temporary fixtures; no installed-tool discovery or fixture execution.
This proposal does not establish a real deployment or justify live approval.
Before any live request, supply concrete externally attested artifacts and the
new command/hash; if none exist, remain REVIEW_ONLY. Provisioning, installation
or host inspection requires its own explicit scope, never a generic checkpoint.

X verification is documentation/source review plus repository text assertions
and diff hygiene only. No executor tests or application DB suites apply. No
lookup, host inspection, Docker, migration, evidence creation/inspection,
cleanup, commit or push. Rollback removes X document/task/lesson additions only.
Stop here under AGENTS.md section 1; implementation belongs to the next gate.
