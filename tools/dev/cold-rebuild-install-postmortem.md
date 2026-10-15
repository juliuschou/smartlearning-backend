# Cold rebuild install failure — 2026-10-15

Evidence: artifacts/local-env/sl-cold-rebuild-20261015-01/verified-summary.json.
The single authorized run was BLOCKED after3.910940872s at dependency install;
backup generation/hash/ACL checks passed. DB/app resources were never created.
This is a launcher configuration failure, not evidence of backup corruption or
PostgreSQL restore failure. The elapsed failure time is not an accepted RTO.

## Root cause and escape

1. To exclude inherited npm configuration, the launcher assigned /dev/null to
   both npm_config_userconfig and npm_config_globalconfig. npm11.17.0 rejects
   the same path loaded for both sources: double-loading config "/dev/null" as
   "global", previously loaded as "user". A real no-install npm --version with
   that exact environment reproduces the failure.
2. The build regression replaced run_build_command with a success mock; lifecycle
   tests replaced prepare_build entirely. These tests validated orchestration,
   not npm's environment parser. The top-level npm version pin used the parent
   environment, so it did not validate the later isolated build environment.
3. Build stdout/stderr were intentionally discarded to avoid exposing secrets.
   Before the fix, no per-stage receipt recorded exit code or elapsed time.
   Consequently the live driver reported only "failed: install". Diagnosis
   required the separate safe npm reproduction rather than raw log inspection.

## Implemented prevention

- create_build_env constructs two distinct empty mode0600 configuration files
  and the sanitized environment. The same function serves real CLI regression
  and production; no second hand-written approximation of the environment.
- Before npm ci, npm_configuration_preflight runs real npm --version in the
  actual build cwd/environment, with10s timeout and exact version pin. Failed
  config/version checks produce npm-preflight.json and block installation.
  Raw stderr/stdout are not persisted; only recognized category/status/code and
  validated version are retained. No installation or registry request is needed.
- Install/generate/build each write an initial RUNNING and final PASS/BLOCKED
  receipt with stage timeout, exit code where available, exception class and
  monotonic duration, including failure/timeout paths. Raw child output remains
  suppressed. The one-shot lifecycle and cleanup rules are unchanged.
- cold-rebuild-npm.test.py runs REAL npm with original broken configuration
  (expected BLOCKED) and actual corrected configuration (expected PASS), asserts
  private independent files and loader/config isolation, checks preflight failure
  prevents installation, and checks install failure preserves exit code while
  preventing generate/build. No installs, DB operations or downloads occur.

## Verification and limits

python3 -B tools/dev/cold-rebuild-npm.test.py:4/4 PASS.
python3 -B tools/dev/cold-rebuild.test.py:11/11 PASS.
Python syntax and git diff --check PASS.

This prevents the demonstrated parser failure from silently reaching install.
It does not prove registry availability, npm ci, native modules, Prisma generation,
compilation, SCRAM or runtime readiness. Those remain gates for the next explicitly
authorized fresh unique run. No failed run is replayed; historical artifacts and
backups remain untouched. Before live authorization, execute the real no-install
regression with the same pinned npm; mocked lifecycle tests alone are insufficient.
