# W3 Phase C Forensic Report

Run: `w3fresh-20260925T114000Z-dd7baaa`

Original evidence: `artifacts/w3-diag/w3fresh-20260925T114000Z-dd7baaa/`

Forensic evidence: `artifacts/w3-diag/w3fresh-20260925T114000Z-dd7baaa-forensics-20260925T150329Z/`

The original directory was treated as immutable. This report uses only retained artifacts and read-only source inspection. No backend was started, no fixture or W3 driver was run, and no database mutation/cleanup was performed.

## A. Verdict

**SEQ455 FORENSIC: PARTIALLY RESOLVED**

The runtime failure mechanism and the trace-correlation false negative are resolved at the architectural/evidence level. The exact Prisma operation, Prisma error code, `meta`, and database cause are **not captured** in the retained run, so the Prisma root cause itself remains `UNKNOWN`.

Correct fresh-run conclusion:

> Fresh W3 reproduced a distinct publisher failure: close fan-out event seq 455 dead-lettered after repeated Prisma dispatch failures. The historical delivered-without-dispatch-trace anomaly did not reproduce and remains attribution-unresolved.

## B. Exact Prisma failure

| Field | Finding |
|---|---|
| Prisma error class | `PrismaClientKnownRequestError` |
| Prisma error code | **NOT CAPTURED** |
| Prisma `meta` | **NOT CAPTURED** |
| Client version | **NOT CAPTURED** |
| Failing repository function | Exact database statement is **UNRESOLVED**; failure escaped `LiveGateway.dispatchDurableEvent()` during close fan-out recipient work |
| Failing Prisma operation | **UNRESOLVED**; bounded to recipient authorization/result-materialization paths below |
| Transaction context | Candidate operations include ordinary Prisma reads and participant authorization transactions; no retained error payload identifies which one |
| Classification | `UNKNOWN`; evidence does not support deadlock, timeout, connection failure, or a particular P20xx code |

### Source boundary

- `src/modules/realtime/live-session-publisher.ts:198-257` processes a claimed row, invokes dispatch, and only calls `markDelivered()` after dispatch returns.
- `src/modules/realtime/live-session-publisher.ts:267-297` (`dispatchTraced`) records dispatch start, awaits `gateway.dispatchDurableEvent(event)`, records only the error type on throw, and rethrows the same error.
- `src/modules/realtime/live-gateway.ts:1176-1215` routes `result.updated` through teacher counts, teacher results, and participant results. For a close fan-out event, `session.closed` routes to `emitSessionClosed()`.
- `src/modules/realtime/live-gateway.ts:1379-1451` (`emitSessionClosed`) enumerates sockets, reauthorizes recipients, emits, and awaits all recipient promises with `Promise.all`.
- Teacher recipient authorization calls `SessionService.assertAccountActive()` (`src/common/auth/session.service.ts:163-179`, `db.account.findUnique`). Participant recipient authorization calls `reauthorizeParticipant()` (`src/modules/realtime/live-gateway.ts:708-743`) and `ParticipantService.resolveAccountParticipant()` (`src/modules/participants/application/participant.service.ts:242-315`), which performs live-session/account/enrollment/participant reads and transaction locking.
- For result materialization, `LiveSessionService.getResults()` (`src/modules/live-sessions/application/live-session.service.ts:1221-1395`) performs a transaction and nested `sessionQuestion.findUnique` with related rows.

The retained evidence proves the error escaped the gateway before the publisher could acknowledge the row. It does **not** prove which candidate query failed.

### Why the detail is absent

- `src/common/observability/error-type.ts:1-4` reduces an `Error` to `error.name`.
- `src/modules/realtime/diagnostics/realtime-trace.service.ts:208-214` stores `dispatchThrew` as `{ errorType: errorType(error) }` only.
- `src/modules/realtime/diagnostics/realtime-trace.service.ts:406-445` likewise stores only error types for emit/delivery failures.
- `src/modules/realtime/live-session-publisher.ts:440-449` logs `error.name`, not Prisma `code`, `meta`, or client version.

Therefore the retained trace/log path did not explicitly redact a known Prisma code; it never projected the required fields. A future minimal diagnostic projection should allow-list `name`, `code`, `clientVersion`, and safe, reviewed `meta` keys. It must not serialize full errors, URLs, SQL parameters, credentials, tokens, or PII.

## C. Seq 455 lifecycle

Identity from `trace-final.json`:

- `eventId`: `01a0d874-0a1e-77cb-ac32-8e1bbf3b5c33`
- `eventSeq`: `455`
- `eventType`: `result.updated`
- `liveSessionId`: `01a0d864-b657-706c-8b05-ecc932f34b62`
- `sessionQuestionId`: `01a0d864-b68b-776f-ac37-4e60f5097f15`
- payload correlation: aggregate version `151`, visibility `participant`
- backend instance: `01a0d85e-923a-746a-a657-98243f3ee87c`
- publisher instance: `01a0d85e-92dd-71f1-8e1a-7a357ea1fc65`
- process ID: `91145`
- trace service run ID/instance ID: `01a0d85e-92cb-7254-8cd7-7030c203ceac`

Backend stdout provides the attempt transitions at lines 1782-1802:

| Attempt | Claim/dispatch evidence | Error | Retry/reclaim | Final |
|---:|---|---|---|---|
| 1 | claimed/dispatch logged at `20:04:39.208 +0800`; failure at `20:04:41.270` | `PrismaClientKnownRequestError` | `transient`, state `retry` | retry |
| 2 | claimed/dispatch logged at `20:04:42.214`; failure at `20:04:44.260` | same class | `transient`, state `retry` | retry |
| 3 | claimed/dispatch logged at `20:04:45.230`; failure at `20:04:47.289` | same class | `transient`, state `retry` | retry |
| 4 | claimed/dispatch logged at `20:04:49.224`; failure at `20:04:51.300` | same class | `transient`, state `retry` | retry |
| 5 | claimed/dispatch logged at `20:04:54.230`; detailed trace claim at `2026-09-25T12:04:54.217Z` | same class | trace records `leaseTransition=reclaimed`; `oldClaimOwnerEvidenceGap=true` | `dead` at `2026-09-25T12:04:58.318Z` |

Attempt-specific claim token/dispatch trace fields for attempts 1–4 are **NOT CAPTURED** in the retained trace. The final attempt has:

- claim token: `01a0d85e-92dd-71f1-8e1a-7f7606c3857e`
- lease expiry: `2026-09-25T12:05:04.217Z`
- `claimOnly=true`
- `gatewayDispatchCalled=true`
- `dispatchThrew.errorType=PrismaClientKnownRequestError`
- final transition `dead`

DB reconciliation (`source-references/db-reconciliation.txt`) reports 455 total durable events: `454 delivered`, `1 dead`.

### Retry classification

The same error class occurred on all five attempts, and the same backend/publisher/process identity is present in the detailed trace. This supports **repeatable at the observed boundary**, but not a proven deterministic database cause. The only defensible root-cause classification is `UNKNOWN`; the publisher's own policy classified the error as transient and dead-lettered at attempt 5.

### Lease reclaim

The evidence supports:

```text
dispatch failure
→ retry transition
→ subsequent claim/reclaim
→ next attempt
→ attempt 5 dead-letter
```

`leaseTransition=reclaimed` and `oldClaimOwnerEvidenceGap=true` do not prove that lease reclaim caused the Prisma failure. The same publisher identity is recorded, and the reclaim is better treated as retry lifecycle evidence/consequence. Prior owner details are explicitly not captured.

## D. Recipient effects

From the complete internal trace and driver report:

- expected close recipients: `301` (300 participants + 1 teacher)
- traced room membership: `301`
- traced participant emits: `291`
- traced teacher emit: `1` (`counts.updated`; the later result guard was identity-mismatch)
- traced participant delivery outcomes: `224 fulfilled`, `67 rejected` with `PrismaClientKnownRequestError`
- participant sockets with no corresponding seq 455 participant emit record: `9`
- client participants with at least one recorded close observation: `286`
- duplicate close observations: `286` clients received 2–5 copies
- receipt multiplicity: `224` clients received 5, `37` received 4, `14` received 3, `11` received 2
- missing client observations: `14` in the extracted driver mapping; nine were explicitly classified as dead-letter/event-not-published, while five did not have the same explicit classification object in the extracted report

The driver report's final-broadcast observation count is `292`, with p50 `1808.132 ms`, p95 `5680.536 ms`, p99 `8771.760 ms`, and max `8786.945 ms`.

### Duplicate mechanism

**Confirmed non-idempotent retry window:**

```text
recipient fan-out begins
→ per-recipient authorization/emit work runs concurrently
→ some sockets emit successfully
→ another recipient's Prisma operation rejects
→ Promise.all rejects
→ dispatch does not return successfully
→ durable row remains retryable
→ whole event is claimed and fan-out repeats
→ already-emitted sockets receive duplicates
```

This follows directly from:

- `emitSessionClosed()` awaiting all recipient promises with `Promise.all` (`live-gateway.ts:1379-1451`)
- publisher acknowledgement only after dispatch returns (`live-session-publisher.ts:219-243`)
- whole-row retry in `markFailure()` (`live-session-publisher.ts:395-455`)
- per-socket queueing that preserves socket-local order but provides no cross-recipient atomicity

Claim tokens fence stale database acknowledgements; they cannot retract packets already emitted. This is an at-least-once, whole-event retry window, not exactly-once multi-recipient delivery.

### Missing recipient attribution

The nine missing socket emits are real trace-level gaps, but the retained evidence does not completely map all nine missing socket IDs to all driver participant IDs or identify the exact recipient at which `Promise.all` first rejected. Therefore:

`MISSING CLOSE RECIPIENT ATTRIBUTION: UNRESOLVED`

The dead-letter state alone is not a sufficient explanation. The supported explanation is partial fan-out plus repeated whole-event retries; the exact per-recipient failure order is not captured.

## E. Lease reclaim

- cause or consequence: **consequence/continuation of repeated dispatch failure; not proven as root cause**
- same publisher: **yes**, same publisher instance is recorded
- old owner evidence: **gap**, explicitly indicated by `oldClaimOwnerEvidenceGap=true`

## F. Trace run ID audit

| Field | Value |
|---|---|
| driver/fixture run ID | `w3fresh-20260925T114000Z-dd7baaa` |
| backend trace run ID | `01a0d85e-92cb-7254-8cd7-7030c203ceac` |
| `REALTIME_TRACE_RUN_ID` | **missing from `backend-env.json`** |
| trace records retained | `2393` |
| trace dropped | `0` |
| driver query result for fixture run ID | HTTP 200 with zero matching records/timings; client marks `RUN_ID_MISMATCH` |

Source evidence:

- `src/modules/realtime/diagnostics/realtime-trace.service.ts:70-75` falls back to generated `instanceId` when `REALTIME_TRACE_RUN_ID` is absent.
- `scripts/load-harness/w3/run-w3.ts:193-196` constructs the trace client with the fixture run ID.
- `scripts/load-harness/w3/trace-client.ts:125-127` queries using that ID.
- `src/modules/realtime/diagnostics/realtime-trace.service.ts:587-609` filters records/timings by exact run ID.
- `scripts/load-harness/w3/trace-client.ts:172-180` rejects a response whose `stats.runId` differs from the requested ID.

Conclusion: **HARNESS TRACE CORRELATION FALSE NEGATIVE: YES**.

This is supported as a launch-configuration/harness contract bug. The trace service was enabled and retained complete records; the backend and driver simply used different run IDs. No trace-buffer loss occurred.

## G. 150 vote classification audit

Reported classification:

- `UNRESOLVED_DELIVERED_NO_PUBLISHER_RECORD`: **150**

Actual retained run evidence:

- Phase-B vote events: `150`
- valid submissions: `150`
- expected targeted vote receipts: `150`
- actual targeted vote receipts: `150`
- missing targeted receipts: `0`
- forbidden abstainer deliveries: `0`
- authoritative result exactness: true
- trace records under backend internal run ID: present; total trace records `2393`, dropped `0`

The driver used an empty trace rollup because its query ID did not match the backend trace ID. In `run-w3.ts:738-775`, absent trace rollups fall into `UNRESOLVED_DELIVERED_NO_PUBLISHER_RECORD`; receipt presence is recorded separately and does not repair that classification. Thus all 150 labels are false positives from correlation failure, not evidence of missing publisher records.

- actual events with publisher lifecycle trace: **150/150** under the internal trace run ID
- actual missing publisher lifecycle trace: **0 demonstrated**
- harness false-negative: **150/150**

The report also derives `coverageComplete` from a null-safe dropped count, so unavailable mismatch evidence can appear as complete coverage. That is a secondary reporting defect, not a runtime delivery failure.

## H. Root causes (separate)

### Runtime root cause

**Partially resolved / exact database cause unknown.** A `PrismaClientKnownRequestError` escaped close fan-out recipient work on every attempt. The precise query, model/table, Prisma code, and meta were not captured. The failure caused the whole event to retry and eventually dead-letter.

### Diagnostic correlation root cause

**Resolved:** backend launch omitted `REALTIME_TRACE_RUN_ID`; the service defaulted to its instance ID while the driver queried by fixture run ID. Strict filtering returned no matching records, and the harness misclassified all 150 delivered vote events.

### Close delivery semantics

**Confirmed design-level failure mode:** close fan-out is non-atomic and whole-event retry is non-idempotent with respect to already-emitted socket packets. This is a separate runtime consequence of the seq 455 failure, not the trace-correlation bug.

## I. Proposed minimal fixes (not applied)

### Fix 1 — safe Prisma error diagnostic projection

- scope: realtime trace `dispatchThrew`/delivery failure and publisher warning serialization
- risk: low if strict allow-listing is used; medium if `meta` fields are not reviewed
- behavior change: diagnostics only; no retry/publisher semantics change
- test requirement: unit tests for Prisma known errors, ordinary errors, non-enumerable properties, safe meta allow-list, and redaction/no-secret guarantees

Suggested fields only: `name`, `code`, `clientVersion`, and explicitly allow-listed safe meta keys. Do not persist raw error objects, SQL, query parameters, connection URLs, credentials, tokens, or PII.

### Fix 2 — `REALTIME_TRACE_RUN_ID` launch wiring and preflight

- scope: W3 backend launch wrapper/execution contract and preflight
- risk: low; fail-closed if missing or mismatched
- behavior change: diagnostics launch contract only
- test requirement: preflight asserts `W3_RUN_ID === REALTIME_TRACE_RUN_ID` before backend start/traffic; a smoke query asserts returned `stats.runId` equals the requested run ID; report must not claim coverage when trace is unavailable

### Fix 3 — close fan-out retry/idempotency design

- scope: durable close delivery semantics; only after a separate design review
- risk: high because it changes realtime delivery guarantees and persistence/recipient state
- behavior change: potentially per-recipient progress/acknowledgement, idempotency keys, or a terminal snapshot/reconnect contract
- test requirement: targeted unit/integration tests for partial recipient failure, retry, reconnect, duplicate suppression, missing-recipient recovery, and claim/lease races; no W3 rerun until the design and reproduction gate are approved

## J. Next recommended gate

**STATIC FIX REVIEW REQUIRED → UNIT/INTEGRATION REPRO REQUIRED → DB-LEVEL REPRO REQUIRED**

Do not run another fresh W3 yet. First review the safe Prisma diagnostic projection and trace launch contract, then create a deterministic narrow reproduction of the close-fan-out failure with retained error code/meta and recipient-level failure injection. Only after those gates pass should a new W3 be considered.

## Evidence integrity

- Original evidence inventory and SHA-256 records: `original-sha256.txt`
- Copied read-only references: `source-references/`
- Original directory was not overwritten or regenerated.
- No production, diagnostics, or harness code was modified.
- No database mutation, backend launch, fixture provisioning, W3 execution, cleanup, commit, or push was performed.
