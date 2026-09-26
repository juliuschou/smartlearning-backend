# W3 Phase D1 — Static Fix Review

Run context: `w3fresh-20260925T114000Z-dd7baaa`

Phase C verdict: `SEQ455 FORENSIC: PARTIALLY RESOLVED`

Scope: static review only. No production, diagnostics, or harness code was changed. No backend, fixture, W3 driver, DB mutation, cleanup, commit, or push was performed.

## Executive decision

| Fix | Decision | Readiness |
|---|---|---|
| A — `REALTIME_TRACE_RUN_ID` launch wiring + preflight | Implement | **Implementation-ready** |
| B — safe Prisma diagnostic projection | Implement, diagnostics-only | **Implementation-ready with allow-list review** |
| C — close fan-out retry/idempotency | Design review only | **Not implementation-ready as a broad idempotency change** |

Priority remains **A > B > C**.

---

## Fix A — `REALTIME_TRACE_RUN_ID` launch wiring + preflight

### Classification

**MULTIPLE:** primary `HARNESS_CONTRACT_GAP` plus concrete `LAUNCH_CONFIGURATION_BUG`; secondary preflight/reporting gap.

The trace service and query API already support run scoping. The checked-in W3 driver does not own backend startup, and no checked-in W3 orchestration wrapper generates one run ID and propagates it to backend, fixture, and driver.

### Current data flow

| Stage | Source | Current value / behavior | Output |
|---|---|---|---|
| W3 run ID creation | `scripts/load-harness/w3/create-fixture.ts:45-51` | `process.env.W3_RUN_ID ?? randomUUID()` | Fixture run ID, persisted in fixture JSON at `:227-251` |
| Backend trace initialization | `src/modules/realtime/diagnostics/realtime-trace.service.ts:66-77` | Reads env once at construction; `REALTIME_TRACE_RUN_ID?.trim() || instanceId` | Immutable process-wide `trace.runId` |
| Trace record stamping | `src/modules/realtime/diagnostics/realtime-trace.service.ts:633-655` | Uses service `runId` | Every record carries backend trace run ID |
| Driver construction | `scripts/load-harness/w3/run-w3.ts:159-195` | Reads fixture, creates `TraceClient(baseUrl, fx.runId, ...)` | Driver queries using fixture run ID |
| Trace query | `scripts/load-harness/w3/trace-client.ts:125-189` | Requests `...?runId=<fixture run ID>` | Strictly rejects mismatched `stats.runId` as `RUN_ID_MISMATCH` |
| Server filtering | `src/modules/realtime/diagnostics/realtime-trace.service.ts:587-609` | Exact equality on requested run ID | Wrong ID returns empty records/timings, while stats expose actual backend ID |
| Classification | `scripts/load-harness/w3/run-w3.ts:209-228,1169-1237` | Missing/unusable trace becomes absent server evidence | Delivered events can be misclassified; `coverageComplete` also treats absent stats as zero drops |

### Actual gaps

1. **Two independent run-ID sources.** Backend falls back to a generated instance ID; fixture independently generates or receives `W3_RUN_ID`. No source joins them.
2. **No repository-owned W3 backend launcher.** `package.json:53` defines `load:w3:diag` as only `W3_TRACE=1 tsx scripts/load-harness/w3/run-w3.ts`; it does not start/configure the backend or fixture.
3. **Preflight occurs too late.** `run-w3.ts:592-595` performs the first trace fetch only after joins, setup probes, and Phase B submissions/drain. A mismatch can consume the workload before discovery.
4. **The existing strict mismatch behavior is correct.** Do not weaken `TraceClient` to accept the backend instance ID or query by returned `stats.runId`.
5. **Secondary coverage bug.** `run-w3.ts:217` and `:1236` compute `(snapshot.stats?.droppedCount ?? 0) === 0`; a mismatched/unavailable snapshot with no stats can therefore appear `coverageComplete=true`.

### Minimal Fix A proposal

1. Add a narrow repository-owned W3 diagnostic orchestrator, preferably `scripts/run-w3.ts`, modeled on the existing disposable launcher patterns rather than changing `RealtimeTraceService` fallback semantics.
2. Generate or require one run ID before backend startup.
3. Pass the exact same value to:
   - backend: `REALTIME_TRACE_RUN_ID=<runId>`;
   - fixture: `W3_RUN_ID=<runId>`;
   - driver indirectly through fixture JSON.
4. Preserve required existing env (`REALTIME_TRACE_ENABLED=1`, buffer size, `LOAD_CORS_ORIGIN`, fixture/output/credential paths, test DB protections).
5. Add a pre-traffic trace preflight in a pure helper used by `run-w3.ts`:
   - `stats.enabled === true`;
   - `stats.runId === driverRunId`;
   - buffer meets the formal run requirement (current W3-300 contract: `>=20000`);
   - `droppedCount === 0` before traffic.
6. Run this preflight after backend health but before fixture provisioning/join/submission. On mismatch or unavailable diagnostics, fail closed with `BLOCK BEFORE FIXTURE / DRIVER`.
7. Change coverage semantics so unavailable/mismatched trace is never `coverageComplete=true`; require `snapshot.enabled === true`, stats present, and matching run ID before declaring coverage.
8. Keep the current instance-ID fallback for generic tracing and existing fallback tests; W3 formal diagnostics must reject fallback through the contract preflight instead of removing the fallback globally.

No trace endpoint API change is required: the existing mismatch response exposes `stats.runId` and the client already validates it.

### Fix A tests

**Unit / pure helper**

- explicit `REALTIME_TRACE_RUN_ID` → records use that exact run ID;
- absent/blank env → existing instance-ID fallback remains unchanged;
- matching enabled stats/run ID and sufficient buffer → preflight passes;
- mismatch → preflight blocks;
- disabled endpoint, HTTP failure, malformed response → preflight blocks;
- dropped records or insufficient buffer → preflight blocks;
- trace explicitly disabled mode remains available only when formal diagnostics are not required.

**Trace client/controller regression**

- matching query returns usable records;
- valid mismatched query returns empty records plus actual `stats.runId`, and client returns `RUN_ID_MISMATCH`;
- invalid/missing run ID retains controller validation behavior;
- disabled/non-test diagnostics retain existing 404 behavior.

**Orchestrator/preflight ordering**

Use mocks/pure helpers to prove mismatch fails before `pg.connect`, fixture mutation, joins, or socket creation. Do not require a 300-user W3.

### Fix A risks

- **Low/medium:** launcher changes process lifecycle and environment propagation; must preserve disposable cleanup and unique run identity.
- Do not set `REALTIME_TRACE_RUN_ID` in only the driver command; the backend reads it before driver startup.
- Do not pass the run ID through ordinary request headers; trace identity is process-scoped and asynchronous.
- Preflight must retain the current trace buffer and test-environment safety checks.

---

## Fix B — safe Prisma diagnostic projection

### Current error path

```text
catch(error)
  → LiveSessionPublisher.dispatchTraced / markFailure
  → RealtimeTraceService.recordDispatchThrew / recordDelivery
  → errorType(error)
  → trace artifact / structured logger
```

Relevant source:

- `src/common/observability/error-type.ts:1-4`: returns only `error.name` for `Error` instances.
- `src/modules/realtime/diagnostics/realtime-trace.service.ts:208-214`: stores `dispatchThrew: { errorType: errorType(error) }`.
- `src/modules/realtime/diagnostics/realtime-trace.service.ts:406-445`: stores only error type for emit/delivery failures.
- `src/modules/realtime/live-session-publisher.ts:440-449`: logs `error: error.name`; `:477-484` logs recovery `errorType` only.
- `src/modules/realtime/diagnostics/realtime-trace.types.ts:76-85,136`: trace types only expose error type fields.

The HTTP exception filter has Prisma detection and mapping (`src/common/http/global-exception-filter.ts:64,102-122`), but background publisher/gateway failures never pass through that filter.

### Why fields are lost

The loss is not shown to be caused by redaction or non-enumerability. The code intentionally projects the error to its constructor/name before trace/log persistence. Therefore:

- `error.code`: not read by the realtime diagnostic path;
- `error.meta`: not read or allow-listed by the realtime diagnostic path;
- `clientVersion`: not read;
- operation/model/query identity: not present on the caught error projection and not added by the publisher/gateway boundary.

Existing tests construct `Prisma.PrismaClientKnownRequestError` with `code`, `clientVersion`, and `meta` (`src/common/http/global-exception-filter.spec.ts:226-235`), proving the repository's Prisma 7.9.1 type exposes those fields to application code. The current realtime path simply discards them.

### Minimal safe projection

Add one small diagnostics-only helper, preferably adjacent to the existing error-type utility or realtime diagnostics service, with an output shape such as:

```ts
type SafeErrorDiagnostic = {
  errorType: string;
  prismaCode?: string;
  prismaClientVersion?: string;
  prismaMeta?: Record<string, string | number | boolean | null>;
};
```

Detection should prefer the repository's existing Prisma type import and `instanceof Prisma.PrismaClientKnownRequestError`, matching existing code in `global-exception-filter.ts`, `transaction.service.ts`, and governance policy. Do not build a general error framework. If cross-package/mocked instances are a concern, add a narrow structural fallback requiring a valid Prisma code pattern and known safe fields; do not trust arbitrary objects wholesale.

### Meta allow-list

Because the actual seq 455 code is unknown, do not record arbitrary `meta`. Treat candidate fields as follows:

| Field/category | Decision | Rationale |
|---|---|---|
| `error.name` / `errorType` | SAFE TO RECORD | Existing behavior; non-secret class identifier |
| `error.code` matching `P\d{4}` | SAFE TO RECORD | Required root-cause classifier |
| `clientVersion` | SAFE TO RECORD after bounded string validation | Runtime/library diagnostic, not a credential |
| `meta.modelName` | CONDITIONAL / SANITIZE | Useful for Prisma failures; bounded allow-list and length limit |
| `meta.target` | CONDITIONAL / SANITIZE | May identify a constraint/field; record only normalized field labels, bounded and reviewed |
| `meta.field_name` / `meta.column` / similar documented Prisma labels | CONDITIONAL / SANITIZE | Only if explicitly allow-listed and length-limited |
| `meta.cause` | CONDITIONAL / SANITIZE | Record a bounded category only; never raw nested error text |
| unknown meta keys / arbitrary nested objects / arrays | DO NOT RECORD by default | Could contain query details, identifiers, or PII |
| message, raw SQL, query parameters, connection URL, credentials, tokens, passwords, participant/user payloads | DO NOT RECORD | Secret/privacy and high-cardinality risk |

The precise allow-list should be tied to the encountered Prisma error code once a future controlled reproduction captures it. Until then, an empty/filtered `prismaMeta` is safer than generic `JSON.stringify(error)`.

### Diagnostic fail-open requirement

Projection must never change publisher behavior. Wrap projection in a total, non-throwing helper:

- if projection succeeds, attach safe fields;
- if projection itself fails, return `{ errorType }` (or a fixed `diagnosticProjectionFailed: true` marker) and rethrow/return the original error unchanged;
- `markFailure`, retry classification, dead-letter state, and socket behavior remain unchanged.

### Fix B tests

1. **Known request error:** synthetic Prisma 7.9.1 error with `name`, `P2002`/representative code, client version, safe meta; assert safe fields appear and unsafe fields do not.
2. **Unknown/unsafe meta:** nested objects, long strings, target-like sensitive values, URL/token/password-shaped values; assert filtering and bounded output.
3. **Generic Error:** `new Error(...)` retains current `errorType`-only behavior and never throws.
4. **Cross-boundary mock:** verify the chosen `instanceof`/structural detection behavior with repository test doubles; do not rely only on a plain object that bypasses the real class.
5. **Projection failure:** force malformed getter/meta or helper failure; assert original publisher error/retry behavior is unchanged and diagnostics degrade to error type.
6. **Trace schema:** update focused realtime trace tests for dispatch-thrown and delivery-error projections; assert no raw message/query payload is serialized.

### Fix B risks

- **Medium:** diagnostics can leak schema/field information or create high-cardinality logs if meta is copied broadly.
- Keep projection bounded, allow-listed, and diagnostics-only.
- Do not infer the seq 455 root cause from newly added fields until a controlled reproduction captures the code and operation.

---

## Fix C — close fan-out retry/idempotency design review

### Exact source execution order

1. Close transaction updates session/question state and appends `session.state_changed` and `session.closed` outbox rows atomically (`src/modules/live-sessions/application/live-session.service.ts:170-224`; outbox sequence/insert in `src/modules/realtime/live-session-outbox.service.ts:33-38,129-163`).
2. The in-process bus is only a wake hint; polling/startup recovery is authoritative (`src/modules/realtime/live-session-event-bus.ts:4-11,55-69`).
3. Publisher claims the whole event as `processing`, increments attempt count, assigns claim token and lease (`src/modules/realtime/live-session-publisher.ts:165-180,299-345`).
4. `dispatchTraced()` calls `gateway.dispatchDurableEvent()` (`live-session-publisher.ts:267-297`).
5. `dispatchDurableEvent()` routes `SESSION_CLOSED` to `emitSessionClosed()` (`src/modules/realtime/live-gateway.ts:1175-1214`).
6. `emitSessionClosed()` snapshots current room membership using `fetchSockets()` (`live-gateway.ts:1379-1395`). The recipient set is transient adapter state.
7. It queues one in-memory delivery per socket through `enqueueDelivery()` (`live-gateway.ts:303-359,1397-1430`). Queues serialize only within a process/socket and are not durable.
8. Teacher recipients perform account-active validation; participant recipients call `reauthorizeParticipant()`. Account-bound participant resolution uses the join/create authorization path (`live-gateway.ts:708-743`; `participant.service.ts:247-315`).
9. On success, `socket.emit('session.closed', ...)` occurs before deferred disconnect (`live-gateway.ts:1431-1445`). Ordinary `socket.emit()` has no client acknowledgement.
10. `Promise.all` waits for all recipient promises. One unexpected Prisma rejection rejects the whole gateway dispatch.
11. Only after gateway dispatch returns does publisher call event-level `markDelivered()` (`live-session-publisher.ts:219-243,376-393`). If any recipient rejects, `markFailure()` retries/dead-letters the entire row (`:395-455`).

### Durability boundary

Durable:

- close state, sequence, and event rows in the close transaction;
- event claim/lease/attempt state;
- event-level delivered/retry/dead state.

Not durable:

- room membership/recipient snapshot;
- per-socket queue;
- authorization/materialization result per recipient;
- which sockets were attempted/emitted/disconnected;
- client processing/acknowledgement;
- progress cursor for a partial fan-out.

**PER-RECIPIENT DELIVERY STATE: NONE.** The schema has only event-level delivery fields (`prisma/schema.prisma:339-372`).

### Exact retry window

The non-idempotent window begins at the first successful `socket.emit()` in an attempt and ends only when the event-level conditional `markDelivered()` succeeds. A later recipient failure, process death, lease expiry/reclaim, or stale claim can cause a whole-event retry after earlier packets have already been accepted by Socket.IO. Claim tokens fence database writes, not network side effects.

This confirms the Phase C finding: close fan-out is at-least-once and non-atomic across recipients. It does **not** make a broad idempotency redesign implementation-ready.

### Additional static finding: terminal account-bound participants

The source review identifies a separate correctness issue that must be handled before claiming terminal delivery semantics are correct: close commits the session as closed before the publisher runs, while account-bound participant reauthorization uses the joinable-session path. A closed session can therefore reject that authorization and disconnect without emitting `session.closed`. This is distinct from duplicate retry behavior and needs an isolated design/test decision.

### Design options and recommendation

**Option 1 — terminal authorization correction first (recommended immediate design slice):** add a closed-session-safe, non-creating entitlement check for already-connected account-bound participants. This fixes deterministic omission without claiming exactly-once delivery. Must define account disable/enrollment removal race semantics and must not create a participant after closure.

**Option 2 — explicit at-least-once + client idempotency/ACK:** keep event-level outbox, document/dedupe `(liveSessionId,eventSeq)`, optionally use bounded Socket.IO ACKs, and add a terminal replay/status path because current terminal reconnect rejection limits recovery. ACK remains non-transactional with DB acknowledgement.

**Option 3 — durable per-recipient rows:** logical recipient IDs with independent states/cursors and actor-safe materialization. Higher auditability, but substantial schema, authorization, multi-device, ordering, and write-amplification design.

**Option 4 — durable per-session recipient cursor/inbox:** lower row count, but requires visibility semantics, multi-device policy, coalescing/dead-row handling, and terminal replay authentication.

Decision: **Fix C is design-review-only and not implementation-ready as a general retry/idempotency patch.** First separate requirements for (a) offering close to currently entitled connected sockets and (b) durable per-recipient acknowledgement/exactly-once user-visible effect. Do not add Socket.IO ACKs alone and call that exactly-once.

### Fix C test strategy before implementation

Required focused tests:

- account-bound participant receives `session.closed` after close commit without participant creation;
- mixed teacher/anonymous/account-bound fan-out;
- one recipient emits, another authorization/materialization throws → event retries and duplicate behavior is explicitly asserted;
- crash/lease reclaim after emit but before `markDelivered`;
- two-publisher stale-claim overlap;
- terminal reconnect/replay behavior for a missed close;
- client dedupe/ACK semantics if that contract is selected;
- event ordering and visibility safety under concurrent disable/enrollment removal.

A narrow terminal-authorization slice may be implemented separately only after design approval; it does not solve the general non-idempotent window.

---

## Recommended implementation sequence

1. **A:** add shared run-ID orchestration and pre-traffic trace preflight; correct unavailable coverage semantics.
2. **B:** add bounded Prisma diagnostic projection without changing retry/dispatch behavior; add unit tests.
3. Capture a narrow controlled reproduction using A+B before attempting another W3. The goal is to obtain the actual Prisma code/meta and failing operation.
4. **C:** decide terminal authorization and recipient durability requirements; then write a separate design/implementation plan. Do not fold C into A/B.

## Review evidence

- Phase C forensic report: `artifacts/w3-diag/w3fresh-20260925T114000Z-dd7baaa-forensics-20260925T150329Z/forensic-report.md`
- Existing trace/run-ID lesson: `tasks/lessons.md:499-504`
- Existing W3 diagnostic contract notes: `tasks/todo.md:5319-5341,5650-5669`
- Prisma known-error test shape: `src/common/http/global-exception-filter.spec.ts:226-235`

## Non-actions confirmed

No production code, diagnostics code, load harness, scripts, package metadata, backend process, fixture, database, or retained fresh rows were modified or executed destructively during this review.
