# Backend observability

## Metrics contract

The backend exposes an anonymous, raw Prometheus endpoint at `GET /metrics`. It is `VERSION_NEUTRAL`, is not wrapped in the `/api/v1` response envelope, and is not protected by a web session or CSRF guard. This is the frozen CP0 contract: production access control belongs to the Nginx/network topology, not to an application guard.

The backend port must not be publicly reachable around Nginx. `/metrics` should be exposed only on the internal monitoring network or localhost. If deployment exposure is unsafe, tighten ingress or proxy rules before deployment rather than changing the endpoint into a session-authenticated route.

The registry is process-local and application-owned. A scrape serializes the registry only; it does not call PostgreSQL, Redis, readiness checks, or other external services. Metric recording is best-effort and must never change request responses, rate-limit fail-closed behavior, realtime recovery, scheduler behavior, retention errors, or readiness policy.

## Redis readiness semantics

`realtime_redis` represents the optional realtime adapter. In optional or local modes, an outage can be reported as degraded while the application continues local delivery. `login_rate_limit` represents the login limiter; when Redis-required mode is configured and unavailable, readiness is unready and protected login traffic fails closed. These dependencies have separate metrics and alerts and must not be collapsed into one generic Redis state.

## CP7 and OPS boundary

CP7 provides fixed low-cardinality metrics, alert-rule examples, this dashboard inventory, and safe application instrumentation. OPS owns Prometheus/Grafana deployment, scrape authentication/network isolation, threshold tuning, recording rules, retention, routing, and incident response. `dashboard-inventory.md` is the handoff; no Grafana JSON or deployment service is part of CP7.

## Manual Checkpoint 7

Run the targeted metrics tests and `npm run test:cp7:manual -- --runInBand`. Inspect the selected raw metric lines, dependency/readiness evidence, safe route labels, alert inventory, and the promtool/static validation result. Confirm that no account, IP, request/resource ID, URL/query, token/hash, question/answer content, or error message appears in serialized metrics. CP7 is not complete until the user explicitly confirms `Checkpoint 7 verified`.
