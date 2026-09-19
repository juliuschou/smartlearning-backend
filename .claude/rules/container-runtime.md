# Disposable Test Environment & Container Runtime Rules

These rules apply to all temporary development, QA, integration-test, E2E-test, performance-test, rehearsal, POC, and diagnostic container environments.

Primary environment:

- Windows 11
- WSL2
- Rancher Desktop
- Docker / Docker Compose

The environment may involve multiple runtime boundaries:

```text
Windows
→ WSL2
→ Rancher Desktop
→ Docker network/runtime
→ Container
→ Application
```

Do not assume behavior observed at one layer is identical at another layer.

---

## 1. Temporary test environments must be reproducible and disposable

Temporary test containers MUST be treated as disposable execution environments rather than durable infrastructure.

The preferred lifecycle is:

```text
preflight
→ create fresh environment
→ verify readiness
→ execute authorized test
→ capture evidence
→ cleanup
→ destroy
```

Do not design temporary test environments around:

```text
create once
→ stop
→ restart later
```

### Recovery rule

When a disposable environment becomes invalid or stopped unexpectedly:

```text
collect evidence
→ determine cleanup boundary
→ cleanup owned disposable resources
→ recreate fresh environment
```

Do NOT use the following as the default recovery strategy:

```bash
docker start <old-test-container>
docker restart <old-test-container>
```

unless restart behavior itself is the explicit subject of the test.

### Reason

Under WSL2 + Rancher Desktop, host bind mounts, networking, runtime state, and translated mount paths may change across:

- Rancher Desktop restarts
- Docker runtime restarts
- WSL lifecycle changes
- Windows lifecycle changes

A previously valid stopped container is therefore not automatically considered reproducible or restart-safe.

---

## 2. Runtime-observed network identity is authoritative

Never assume that the address used by a test client to reach a service is the same address observed by the application.

For example:

```text
client destination:
127.0.0.1
```

does NOT imply:

```text
application-observed source:
127.0.0.1
```

Windows, WSL2, Rancher Desktop, Docker bridges, proxies, NAT, and IPv4-mapped IPv6 addresses may transform the connection identity.

### Required rule

For logic depending on:

- source IP
- client IP
- request origin
- remote address
- proxy address
- rate-limit source identity
- audit source identity

the authoritative value MUST come from application/runtime evidence, such as:

- structured application logs
- `request.ip`
- `socket.remoteAddress`
- trusted proxy-derived fields
- another field actually consumed by production logic

### Forbidden assumptions

Do not hard-code a source identity solely because a client connects to:

```text
127.0.0.1
localhost
host.docker.internal
```

Historical IP addresses from earlier runs MUST NOT automatically be reused.

Each new disposable environment must rediscover any runtime-dependent network identity required by the test.

---

## 3. Infrastructure must be defined as code

Do not rely on shell history, remembered Docker commands, or manually reconstructed configuration to create test infrastructure.

Container-based test environments MUST be reproducible from repository-controlled artifacts such as:

- Docker Compose
- shell scripts
- PowerShell scripts
- test harness code
- documented environment configuration
- CI workflows

Prefer repository structures such as:

```text
tools/<test-harness>/
scripts/<test-harness>/
tests/infrastructure/
```

Follow existing repository conventions when they already exist.

### Required properties

Infrastructure code must clearly define:

- container image/version
- ports
- networks
- aliases
- environment variables
- secret injection strategy
- health checks
- volumes
- cleanup behavior
- dependencies
- test-only resources

### Shell history is not configuration

Commands manually entered during investigation may be used for diagnosis.

They MUST NOT become the only source of truth for creating a reusable test environment.

If a manual command proves necessary for repeated execution, convert it into version-controlled configuration or script before considering the environment reproducible.

---

## 4. Use unique execution identities for disposable environments

Each disposable test run SHOULD have a unique execution identifier.

Example:

```text
RUN_ID=<timestamp-or-unique-id>
```

Use this identifier to scope disposable resources such as:

- containers
- networks
- volumes
- temporary files
- evidence artifacts
- logs

For Docker Compose, prefer a unique project identity rather than globally fixed resource names.

Example concept:

```text
COMPOSE_PROJECT_NAME=<test-name>-<RUN_ID>
```

This reduces collision with:

- previous failed runs
- parallel test runs
- development environments
- unrelated containers

Never use broad cleanup when exact run ownership is available.

---

## 5. Containers should run as non-root by default

Application containers MUST use the image-supported non-root runtime user whenever possible.

Before overriding the container user, inspect and understand:

- image `Config.User`
- application UID
- application GID
- mounted-file ownership
- mounted-file permissions

Do NOT solve permission problems by automatically switching to:

```text
root
0:0
```

### Preferred model

Fix ownership and permissions instead.

Examples:

```text
owner = application UID
mode  = 0400
```

or:

```text
owner = root
group = application GID
mode  = 0440
```

Directory permissions must allow required traversal without making sensitive material broadly readable.

### Root exception

Running as root is permitted only when:

1. technically required,
2. explicitly justified,
3. limited in scope,
4. recorded as a known exception.

It must not become the default workaround for mount-permission problems.

---

## 6. Secrets must not be persisted in inspectable container metadata

Sensitive values MUST NOT be placed directly into Docker metadata when a safer supported mechanism exists.

Avoid putting sensitive values into:

```text
docker run -e SECRET=value
--env-file containing secrets
Compose environment:
Docker labels
command-line literals
```

because they may become inspectable through container metadata.

Examples of sensitive values include:

- database passwords
- connection strings containing credentials
- signing keys
- cookie/session secrets
- API keys
- HMAC secrets
- access tokens

### Preferred secret model

Prefer secret files or disposable secret storage.

For Rancher Desktop environments, a preferred pattern is:

```text
temporary local source
        ↓
short-lived initialization step
        ↓
Docker-managed disposable volume
        ↓
application read-only mount
```

Long-running application containers SHOULD NOT depend directly on temporary Rancher Desktop materialized paths when this can be avoided.

### Secret lifecycle

Temporary secrets must:

- be test-only
- have restrictive permissions
- never be committed
- never be printed into logs
- never be written into evidence reports
- be removed during exact test cleanup

---

## 7. Do not treat Rancher Desktop materialized paths as durable configuration

Paths resembling:

```text
/mnt/wsl/rancher-desktop/run/docker-mounts/<id>
```

must be treated as runtime implementation details.

Do not:

- store them as configuration
- document them as canonical host paths
- assume they survive runtime restart
- recreate infrastructure by copying those paths from `docker inspect`

If Docker metadata refers to such a path but the original configuration cannot be reproduced, classify the environment as non-reproducible rather than guessing the source.

---

## 8. Preflight is required before mutating shared test infrastructure

Before creating or modifying a test environment, perform a preflight appropriate to the task.

At minimum, verify applicable items such as:

- Docker runtime available
- correct Docker context
- expected image exists
- expected repository/revision
- expected database identity
- expected Redis/service identity
- network availability
- required ports
- non-root UID/GID
- required scripts/tools
- temporary storage availability
- authorization boundary
- development/production resources that must not be touched

If environment identity is ambiguous:

```text
STOP
```

Do not guess.

Examples of dangerous ambiguity:

```text
test-db
vs
development-db
```

or:

```text
test Redis
vs
shared development Redis
```

Resolve resource identity before mutation.

---

## 9. Shared infrastructure requires explicit identity verification

Before using an existing database, Redis instance, queue, object storage service, or other shared dependency, verify:

- container/service identity
- environment classification
- database/schema name
- network
- aliases
- whether test usage is authorized
- whether data is disposable
- cleanup ownership

Do not infer safety from a resource name alone.

A service named:

```text
test
qa
dev
sandbox
```

is not automatically disposable.

---

## 10. Capture lifecycle evidence before the test begins

For container-based integration, E2E, load, resilience, or infrastructure tests, lifecycle evidence SHOULD begin before test containers are created.

The goal is to prevent future incidents from ending only with:

```text
UNKNOWN — INSUFFICIENT EVIDENCE
```

Capture sanitized evidence appropriate to the environment.

### Host / WSL evidence

Examples:

- timestamp
- WSL version
- distribution
- kernel version
- boot/uptime
- network addresses
- routes

### Docker evidence

Examples:

- Docker client/server versions
- Docker context
- container IDs
- image IDs
- networks
- start/finish timestamps

### Rancher Desktop evidence

When safely available:

- Rancher Desktop version
- container engine
- networking mode
- relevant runtime state

Do not dump arbitrary configuration containing credentials.

---

## 11. Capture Docker lifecycle events during important tests

For tests where unexpected container termination would invalidate evidence, capture Docker events during the test window.

Useful events include:

```text
create
start
stop
kill
die
destroy
connect
disconnect
health_status
```

Store evidence under a per-run directory such as:

```text
artifacts/<RUN_ID>/
```

If lifecycle capture fails, record that failure explicitly.

Do not silently proceed while assuming lifecycle evidence still exists.

---

## 12. Record heartbeat evidence for long-running or timing-sensitive tests

For important tests, periodically capture lightweight runtime state such as:

```text
timestamp
container state
health state
dependency availability
Docker availability
```

The purpose is to establish:

```text
last-known-good
first-known-failure
```

without requiring guesswork after the environment disappears.

Heartbeat checks must be read-only and must not modify application state.

---

## 13. Timing-sensitive tests must minimize orchestration overhead

When correctness depends on short TTLs, time windows, leases, locks, or rate-limit periods, avoid multi-shell/manual test sequences.

Bad pattern:

```text
command 1
→ inspect manually
→ start another shell
→ command 2
→ inspect manually
```

Preferred pattern:

```text
single test driver
→ pre-establish connections
→ prepare payloads
→ start timing-sensitive state
→ execute requests
→ capture state immediately
```

Do not change production-equivalent timing parameters merely to make a fragile harness pass.

If the timing window expires before evidence is collected, classify it as a test-evidence problem rather than automatically as an application failure.

---

## 14. Cleanup must be exact, scoped, and idempotent

Temporary test cleanup must affect only resources owned by the current test/run.

Prefer exact cleanup using known identifiers.

Examples:

```text
exact container
exact network
exact volume
exact Redis key
exact temporary directory
```

Avoid broad destructive cleanup such as:

```bash
docker system prune
docker volume prune
docker network prune
redis FLUSHDB
redis FLUSHALL
wildcard key deletion
```

unless the environment is explicitly disposable and such operations are separately authorized.

### Idempotency

Running cleanup twice should not damage unrelated resources.

A failed cleanup is itself a test result and must be reported.

Do not hide cleanup failures.

---

## 15. Preserve evidence before destroying failed environments

When a test fails unexpectedly:

```text
DO NOT immediately recreate
```

First capture available evidence such as:

- container inspect
- container logs
- timestamps
- exit code
- OOMKilled
- restart count
- Docker events
- dependency status
- network state
- mount existence

Only after evidence capture should cleanup/recreation proceed.

Otherwise, root-cause evidence may be permanently lost.

---

## 16. Distinguish application failure from infrastructure failure

Do not classify a test as application FAIL solely because:

- a request timed out
- a container stopped
- Docker returned exit code 255
- a health endpoint became unreachable

First distinguish among:

```text
APPLICATION FAILURE
DEPENDENCY FAILURE
NETWORK FAILURE
BIND-MOUNT FAILURE
CONTAINER-RUNTIME FAILURE
WSL FAILURE
RANCHER DESKTOP FAILURE
HOST LIFECYCLE INTERRUPTION
TEST HARNESS FAILURE
INSUFFICIENT EVIDENCE
```

Application FAIL should require evidence tying the observed result to application behavior.

Infrastructure instability should not be reported as application correctness failure.

---

## 17. Historical runtime evidence is not automatically reusable

Values observed during one execution may change in another execution.

Examples:

- source IP
- container IP
- network gateway
- container ID
- volume ID
- Rancher Desktop mount path
- Docker network address
- temporary file path

Do not hard-code these values into reusable test logic unless they are intentionally stable configuration values.

Rediscovered runtime values should come from current-run evidence.

---

## 18. Test environments must prove reproducibility

For important reusable harnesses, a single successful run is insufficient to establish infrastructure reliability.

Before depending on a newly created harness for formal test evidence, prefer validating:

```text
Run A:
fresh create
→ ready
→ cleanup

Run B:
fresh create
→ ready
→ cleanup
```

Run B must not depend on restarting Run A resources.

Successful recreation is stronger evidence than successful restart.

---

## 19. Development resources must be protected by default

Temporary test scripts must assume that development resources are protected unless explicitly authorized otherwise.

Do not modify:

- development database
- development Redis
- existing developer containers
- unrelated networks
- unrelated volumes
- persistent shared services

without explicit authorization.

Test tooling should prefer creating dedicated disposable resources.

When an existing shared test dependency must be used, perform only the explicitly authorized interaction.

---

## 20. General engineering principle

For Windows 11 + WSL2 + Rancher Desktop environments, optimize container-based test infrastructure for:

```text
reproducibility
isolation
evidence
exact cleanup
```

rather than:

```text
preserving yesterday's temporary containers
```

The preferred question is not:

```text
"Can this stopped container be restarted?"
```

It is:

```text
"Can this environment be recreated safely and deterministically from source-controlled configuration?"
```

Temporary infrastructure that cannot answer that question should be treated as non-reproducible and should not be used as authoritative test evidence.
