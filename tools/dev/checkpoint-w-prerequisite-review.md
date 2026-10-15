# Checkpoint W — discovery prerequisite review (2026-10-14)

## Status

Repository-only review. Implementation preparation stopped at V's explicit
platform/environment prerequisite. W has not delivered the suggested executor
or injected executor suite. No runnable command or approval hash is proposed.
No live operation is authorized by the next-checkpoint request.

## Repository evidence

- `checkpoint-v-discovery-contract.md`, candidate-domain section, requires
  platform-native `shutil.which` semantics, forbids caller variable inspection,
  and directs preparation to stop if implicit dependencies cannot be bounded.
- `checkpoint-r.py` imports `shutil`; `Probe.__init__` captures `shutil.which`
  as its default. `plan()` binds the literal PATH and repository source
  snapshots, but not an interpreter version, platform or standard-library
  implementation. Its historical hash/permission remains consumed.
- `checkpoint-r-review.md` proposes generic `python3 -B`; that command does not
  specify the missing semantic assumptions. It is not W permission.
- `checkpoint-u.test.py` translates lookup into temporary fixture directories.
  Its fixtures establish classification limits, not a production environment
  contract. No U test was run in W.
- `tools/dev/README.md` also uses generic `python3 -B`. `package.json` describes
  the Node application, not a discovery interpreter contract. The Dockerfile's
  builder installs unversioned `python3` as a build dependency; it does not bind
  the host used by the proposed discovery command.
- A filename-limited repository search for Python version/dependency manifests
  (`*python*`, `*requirements*`, `*pyproject*`, `*Pipfile*`, `.tool-versions`,
  `*Dockerfile*`, `*runtime*`, excluding dependencies/build/artifacts) found
  Dockerfile and the application realtime identity source. This is bounded
  evidence, not proof that every repository document lacks relevant constraints.

The existing slash-separated search domain does not by itself authorize a
POSIX-only interpreter restriction. W does not assume the platform or infer
installed Python/tooling from the current shell. It makes no claim about the
actual standard-library implementation or caller environment.

## Required next preparation

A repository-only environment-contract amendment is the recommended next slice:

1. Explicitly propose a supported platform and interpreter implementation/version
   as future contract requirements, rather than claiming they describe the host.
   A POSIX-only proposal is a candidate requiring review; Windows semantics
   remain outside that proposal until their implicit dependencies are bounded.
2. Review the corresponding authoritative `shutil.which` implementation and its
   reachable helpers, documenting every implicit environment dependency and
   how the exact future launch contract constrains it without caller-variable
   inspection. No installed-tool query is needed for this specification step.
3. Specify fail-closed interpreter/platform/source verification and its permitted
   reads. Decide how standard-library semantics enter the source-bound digest;
   repository snapshots alone cannot establish the callable's implementation.
4. Resolve the exact Python launch environment and bootstrap trust boundary:
   generic `python3` selection/import behavior must not silently introduce
   unreviewed tooling assumptions. Do not install or locate an interpreter.

Only after those requirements are concrete should the isolated executor and
explicitly injected tests be implemented against V's remaining requirements.
Do not alter V's domain/metadata, inspect PATHEXT/PATH, substitute custom search,
reuse historical sources/permissions, or reserve another identity to bypass the
prerequisite. The reserved `sl-v-discovery-20261014-01` remains unused by W;
its actual existence was not inspected.

## Verification, limits and rollback

Repository-only AST/text assertions verify the exact R/V domain agreement,
R's generic lookup default, and V's mandatory stop language. `git diff --check`
checks whitespace. These assertions establish repository facts only; they do
not validate lookup/evidence behavior. No executor exists to test yet.

No lookup, caller environment inspection, candidate launch, Docker operation,
DB suite/migration, identity-directory inspection/creation, evidence cleanup,
commit or push occurred. All preexisting work and retained resources/evidence
are preserved. Rollback removes only this W document and its task/lesson notes.
Stop at AGENTS.md section 1; implementation remains deferred, live approval
remains pending.
