# CP8 production-like topology fixture

This directory is a **verification-only** backend fixture for BE-8.8. It is not
an OPS-1 Nginx/Next.js production deployment and does not provide W1–W8 capacity
certification.

## Topology

```text
browser -- HTTPS :8443 (loopback) --> nginx
                                      |--> api-a :3000
                                      |--> api-b :3000
api-a/api-b --> postgres :5432 (PostgreSQL remains domain authority)
api-a/api-b --> redis-realtime :6379 (Socket.IO fan-out only)
api-a/api-b --> redis-login :6379 (login limiter only)
```

The backend/data-plane `cp8` network is internal. Nginx also joins a narrowly
scoped edge network with the one-shot certificate helper so its only published
listener can cross the host boundary. Only Nginx publishes `127.0.0.1:8443`;
the backend instances, PostgreSQL, Redis, and `/metrics` have no host port. The
certificate is self-signed and generated in an isolated named volume by the
one-shot `cert-init` service.

## Safe startup

Copy the sanitized template and replace every placeholder with test-only
values. Do not reuse development or production credentials.

```bash
cd /home/user/projects/smartLearning/smartLearning-backend
cp ops/topology/.env.cp8.example ops/topology/.env.cp8
# edit ops/topology/.env.cp8 with test-only values
set -a; . ops/topology/.env.cp8; set +a
PROJECT="smartlearning-cp8-$(date +%s)"
docker compose -p "$PROJECT" -f docker-compose.cp8.yml config
# Review the rendered config before any lifecycle command.
docker compose -p "$PROJECT" -f docker-compose.cp8.yml up -d --build
curl -k https://localhost:8443/health/live
curl -k https://localhost:8443/health/ready
```

The Compose project name must be unique. Keep the project and volumes until
runtime evidence has been reviewed; remove only that project after the drill:

```bash
docker compose -p "$PROJECT" -f docker-compose.cp8.yml down --remove-orphans
```

The migration service applies the repository's additive migrations to the
isolated `smartlearning_cp8` database. It must never point at
`smartlearning_dev`, a shared test database, or production.

## Frozen backend contract

- `TRUST_PROXY_HOPS=1`: only one Nginx hop is trusted. Nginx overwrites
  `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-For`, and clears
  identity-like headers. The backend does not authorize from forwarded identity
  headers.
- `CORS_ORIGIN=https://localhost:8443` and `SESSION_COOKIE_SECURE=true` prove
  the `__Host-session` and `__Host-csrf` cookies through TLS termination.
- `REALTIME_REDIS_MODE=required` and `REDIS_URL=redis://redis-realtime:6379/0`
  control Socket.IO fan-out. `LOGIN_RATE_LIMIT_REDIS_URL` points only to
  `redis-login`; the two Redis responsibilities are not interchangeable.
  Nginx uses `ip_hash` for Engine.IO polling-session affinity; Redis still
  carries application fan-out and is not the Engine.IO session store.
- `/health/live` is process-only. `/health/ready` is 503 during shutdown or
  when PostgreSQL, required realtime Redis, or required login limiting is not
  safe for mutation.
- `/metrics` is not proxied by Nginx. Scrape it only from an explicitly
  isolated monitoring path/network; never expose the backend port as a
  workaround.
- Shutdown rejects new application work with `SERVER_SHUTTING_DOWN`, keeps
  liveness available, emits retryable `server.shutdown` to live clients, and
  lets existing requests/publisher leases drain within `SHUTDOWN_TIMEOUT_MS`.

## Verification checklist

1. Render review: exactly one Nginx loopback port; no backend/PostgreSQL/Redis
   host ports; internal network; migration health dependency; two API instances.
2. TLS and proxy: `openssl s_client -connect localhost:8443 -servername localhost`
   and health probes succeed with `-k`.
3. Auth: login through `https://localhost:8443` returns Secure `__Host-*`
   cookies; exact Origin plus matching CSRF succeeds; missing/wrong token,
   wrong Origin, and `Origin: *` remain 403 `AUTH_CSRF_INVALID`.
4. Realtime: teacher cookie and participant credential handshakes use the
   `/socket.io/` upgrade; rooms and participant-safe projections remain
   isolated; event delivery is observed after PostgreSQL commit.
5. Authority: query only the isolated PostgreSQL database for one accepted
   Submission, its aggregate, and session/question state. Do not use Redis or
   logs as domain truth.
6. Failure drills: stop/restart `redis-realtime`, interrupt/restart an API or
   Nginx, and verify required-mode readiness/retryable reconnect behavior,
   publisher recovery, and no duplicate accepted Submission.
7. Shutdown: send SIGTERM to an API container; observe readiness 503, socket
   close signal, bounded drain, lease cleanup, and clean restart recovery.
8. Disclosure: retain only sanitized status/header/timeline evidence. Never
   record passwords, cookies, CSRF/session/participant/CLI tokens, answer text,
   or raw request bodies.

If durable replay cannot be proven for a scenario, record `DEFERRED/BLOCKED`;
do not substitute a snapshot result for replay evidence.

## Ownership and handoff

| Area                                                                                | Backend                      | OPS-1             | OPS-2     |
| ----------------------------------------------------------------------------------- | ---------------------------- | ----------------- | --------- |
| Nest proxy trust, cookie/CSRF/Origin, Socket.IO, Redis adapter, readiness, shutdown | Owns                         | Integrates        | Observes  |
| Production Nginx, TLS certificates/hostname, Next.js, ingress and scrape ACL        | Supports contract            | Owns              | Consulted |
| W1–W8 load/capacity, browser matrix, saturated-pool drills                          | Provides correctness signals | Provides topology | Owns      |
| Prometheus/Grafana deployment, thresholds, routing, retention                       | Provides metric contract     | Owns deployment   | Consulted |

## Rollout and rollback

Roll out the compiled image and topology with `REALTIME_REDIS_MODE=required`
only after the rendered config and isolated smoke pass. Monitor readiness,
HTTP 5xx, Socket.IO reconnects, realtime retry/dead counters, and PostgreSQL
submission/aggregate consistency. If the adapter or proxy is unsafe, stop the
rollout and return to the previously verified single-instance/local adapter
configuration; preserve PostgreSQL state and do not weaken authentication,
CSRF, Origin, or Secure-cookie policy. Schema rollback is outside this fixture
and must follow the additive migration policy.
