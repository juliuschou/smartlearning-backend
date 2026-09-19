# Reproducible one-shot Gate3 harness

Gate3 is a disposable harness, not a service to restart. Every run creates a fresh `RUN_ID`, Compose project, private dependency network, QA-only publish network, Redis container, secret volume, and backend containers. The old `gate3-qa-a`/`gate3-qa-b` resources are not reused; recovery is always `down` followed by fresh `up`.

The private `gate3` network is `internal: true` and carries Redis, secret initialization, the temporary test-DB attachment, and both QA services. The QA containers are created and started only on this private network while retaining their create-time loopback `ports:` declarations. After both services are healthy and private DB/Redis connectivity, topology, and route state are recorded, the harness attaches only `qa-a` and `qa-b` to the per-run non-internal `gate3-publish` bridge. It then proves the default-route transition and materialized loopback bindings before any external source probe. The published QA containers consequently gain non-internal outbound semantics only after readiness; Redis and PostgreSQL remain private-only and never gain that egress path.

## Safety model

- The only database authority is the external `smart-learning-pg-test` container and database `smartlearning_test`. The harness never starts a database, runs migrations, seeds, truncates, resets, or drops data.
- The development `smartlearning-db` and `smartlearning-redis` resources are outside the Gate3 project and are never targeted.
- The test DB is temporarily connected only to the private per-run `gate3` network and disconnected during `down`; it is never connected to `gate3-publish`, and its existing memberships and volume are preserved.
- Secrets are generated in a private temporary host directory, copied by a short-lived init container into a per-run named Docker volume, chowned to the image's `nodejs` UID/GID (`999:999`), and mounted read-only by the backends. The long-lived backends do not bind the Rancher Desktop materialized host path.
- Secret values are loaded at process start and are not placed in `Config.Env`, `Config.Cmd`, entrypoints, labels, or repository files.
- The image's native runtime is retained: `nodejs:nodejs` (`999:999`), `/app`, `/usr/bin/tini --`, `node dist/src/main`.

`127.0.0.1` may be the HTTP destination for the loopback-published ports. It is never used as the source identity. Source identity is extracted from backend request evidence after readiness requests and both backend observations must match.

## Commands

Run from the backend repository:

```bash
./tools/gate3/gate3.sh preflight
./tools/gate3/gate3.sh up
./tools/gate3/gate3.sh status
./tools/gate3/gate3.sh source
./tools/gate3/gate3.sh doctor
./tools/gate3/gate3.sh down
```

`up` starts lifecycle capture before creating any disposable resource. It records environment/Docker/WSL/Rancher evidence, filtered Docker events, rendered private-first configuration, Redis `PONG`, in-container DB-bearing readiness, private topology and route state, metadata exposure checks, and service-resolved heartbeat samples. Only then does it attach the two QA containers to `gate3-publish`, record the published topology/default route, require exact materialized loopback bindings, and collect externally correlated source identity through each published QA port. Source correlation polls Compose logs for a bounded number of attempts (`GATE3_SOURCE_TIMEOUT_SECONDS`, `GATE3_SOURCE_POLL_INTERVAL_SECONDS`, and `GATE3_SOURCE_MAX_ATTEMPTS`) and keeps the exact-one-record contract; duplicate valid records fail. `down` is phase-independent: it captures available evidence, conditionally removes only the temporary DB attachment, continues exact project teardown after individual cleanup errors, stops both samplers, and writes post-down evidence proving both per-run networks are absent and the protected database's original memberships are restored.

The dynamic `gate3-publish` network is removed by `down` based on identity verified from the network's own labels (`com.docker.compose.project`, `com.docker.compose.network=gate3-publish`, and the per-run `com.smartlearning.gate3.run-id`), never from the `PUBLISH_NETWORK_CREATED` state flag: Compose may materialize the project-scoped network independently of the harness's explicit creation. Removal is idempotent — an already-absent network is recorded as `ALREADY-ABSENT` and is a success, never a `network not found` failure. If a verified publish network still has attached containers, `down` fails closed: it lists the container IDs and names (for example an external diagnostic container), refuses broad disconnect and force removal, and reports `cleanup blocked by attached external container(s)`. A network whose labels do not match the run identity is likewise never removed.

By default, a failed `up` automatically performs exact Gate3 teardown while preserving the original lifecycle failure and recording cleanup failures separately. For debugging only, set `GATE3_PRESERVE_ON_FAILURE=1`; the run is retained at its actual failure phase, which may be private-only, partially attached to `gate3-publish`, or fully published. Containers, networks, the temporary DB attachment, restricted host secret directory, sampler processes, per-run state, and sanitized artifacts may therefore remain available. Preserved runs must be cleaned explicitly:

```bash
GATE3_RUN_ID=<run-id> npm run gate3:status
GATE3_RUN_ID=<run-id> npm run gate3:source
GATE3_RUN_ID=<run-id> npm run gate3:doctor
GATE3_RUN_ID=<run-id> npm run gate3:down
```

`GATE3_RUN_ID` targets `artifacts/gate3/<run-id>/state.env` directly; without it, commands use the current-run pointer. Source diagnostics are sanitized and stored under the run directory in `source-probe.tsv`, `<service>-probe.tsv`, `source-correlation.tsv`, and `source-evidence.txt`; raw headers, response bodies, and unfiltered Compose logs are not written by the source probe.

### Source correlation contract

Real pino-pretty request logs render the message **outside** the JSON payload (for example `… INFO (7): request completed {"req":{…},"res":{…}}`), and Compose output may carry a service prefix, timestamp, and ANSI residue. Correlation therefore matches the pretty message on the pre-JSON text (after stripping ANSI) and reads all correlation fields from the JSON object itself, which carries no `.msg` key: request and response `x-request-id` equal to the marker, `req.method=GET`, `req.url=/health/live`, `res.statusCode=200`, and a non-empty `req.remoteAddress`. Every probe execution mints a fresh correlation marker `gate3-<RUN_ID>-<service>-<phase>-<nanos>-<random-hex>` (phase = up / source / doctor), generated only by `probe_marker()` in `source-evidence.sh`; repeated probes in the same run never share a marker. Exactly one valid correlated record is required **per probe marker**; more than one fails. Rejection reasons are recorded per attempt in `source-correlation.tsv` (marker not found, pretty message mismatch, JSON payload not found, invalid JSON payload, request ID mismatch, response request ID mismatch, method mismatch, URL mismatch, HTTP status mismatch, missing remoteAddress, duplicate correlated records, bounded timeout); malformed pretty logs never pass.

The parser can also be exercised container-free — no Docker, HTTP, or run state — for parser regression tests:

```bash
GATE3_PARSER_ONLY=1 tools/gate3/source-evidence.sh <marker> < <log-file>
# prints SOURCE_IDENTITY=<addr> and exits 0 on exactly one valid correlated record
```

`tools/gate3/tests/run.sh` feeds real captured-format pino-pretty fixtures (message outside the JSON) through this mode in addition to the mocked end-to-end correlation cases.

Run static checks without creating Gate3 resources:

```bash
./tools/gate3/static-check.sh
```

## Artifacts and interruption recovery

Sanitized evidence is retained in `artifacts/gate3/<RUN_ID>/`:

- `environment.txt`
- `docker-events.jsonl` and `docker-events.stderr`
- `heartbeat.tsv`
- `private-readiness.txt` and `private-dependencies.txt`
- `qa-a-runtime-private.json`, `qa-b-runtime-private.json`, and matching private route artifacts
- `publish-attachment.tsv`
- `qa-a-runtime-published.json`, `qa-b-runtime-published.json`, and matching published route artifacts
- private/published network, DB-membership, and topology snapshots
- `security.txt`
- `source-evidence.txt`
- `cleanup.tsv`, final Compose status, and service logs

If the shell or Docker daemon is interrupted, inspect the last RUN_ID and run `./tools/gate3/gate3.sh down` only after verifying the persisted project/network names. Do not run generic Docker cleanup and do not use `docker start` or `docker restart` on old Gate3 containers. A subsequent test must use a new RUN_ID.

## Deliberate exclusions

This harness does not perform Redis boundary seed `99`, `99 → 100 → 429`, the Redis six-test suite, outage/recovery, S3, full regression, migrations, database reset/drop/truncate, development database mutation, or development Redis mutation. It is a lifecycle/repeatability harness only; a successful smoke round is not Redis boundary proof or W1–W8 capacity certification.
