/**
 * W3 pipeline classifier tests.
 *
 * These pin the classification ORDER that makes a W3 miss report trustworthy:
 * database state, then server-side emit evidence (when tracing is enabled), then
 * the client-side fallbacks. A regression here would silently re-label a
 * server-side drop as a client miss (or vice versa) — exactly the confusion this
 * diagnostic exists to remove.
 *
 * Run with `npm run load:w3:unit` (tsx), matching `metrics.spec.ts`.
 */
import assert from 'node:assert/strict';
import { classifyMissing, type ServerEmitEvidence } from './pipeline-classify';
import type { SocketReceipt } from './w3-socket';

const snapshotReceipt = {
  eventName: 'session.snapshot',
  payload: {},
  receivedAtMs: 300,
  receivedAtIso: '2026-09-20T00:00:00.300Z',
} as SocketReceipt;

function socketEvidence(
  overrides: Partial<Parameters<typeof classifyMissing>[0]['socket']> = {},
) {
  return {
    label: 'p0',
    participantId: 'p0',
    isTeacher: false,
    connectedAtMs: 100,
    everConnected: true,
    receipts: [snapshotReceipt],
    ...overrides,
  };
}

const deliveredRow = {
  event_seq: '25',
  event_name: 'result.updated',
  visibility: 'participant_after_submit',
  target_participant_id: 'p0',
  delivery_state: 'delivered',
};

const fullCoverage: ServerEmitEvidence = {
  traceEnabled: true,
  coverageComplete: true,
  gatewayDispatchCalled: true,
  emittedSocketIds: [],
  guardSkips: [],
  deliveryRejected: [],
  rooms: [{ room: 'session:s1', memberCount: 21, recipientCount: 1 }],
};

function classify(
  overrides: Partial<Parameters<typeof classifyMissing>[0]> = {},
) {
  return classifyMissing({
    label: 'p0',
    expectedEventSeq: '25',
    expectedEvent: deliveredRow,
    socket: socketEvidence(),
    socketId: 'sock-1',
    ...overrides,
  });
}

// --- database state --------------------------------------------------------

assert.equal(
  classifyMissing({
    label: 'p0',
    expectedEventSeq: '25',
    socket: socketEvidence(),
  }).classification,
  'EVENT NOT CREATED',
);

assert.equal(
  classify({ expectedEvent: { ...deliveredRow, delivery_state: 'pending' } })
    .classification,
  'EVENT NOT CLAIMED',
);

assert.equal(
  classify({ expectedEvent: { ...deliveredRow, delivery_state: 'retry' } })
    .classification,
  'EVENT NOT PUBLISHED',
);

// --- server-side emit evidence --------------------------------------------

const guardSkip = classify({
  serverEmit: {
    ...fullCoverage,
    guardSkips: [{ socketId: 'sock-1', guard: 'reveal_gate' }],
  },
});
assert.equal(guardSkip.classification, 'SERVER GUARD SKIP');
assert.match(guardSkip.detail, /reveal_gate/);

assert.equal(
  classify({
    serverEmit: {
      ...fullCoverage,
      deliveryRejected: [{ socketId: 'sock-1', errorType: 'Error' }],
    },
  }).classification,
  'SERVER DELIVERY REJECTED',
);

assert.equal(
  classify({
    serverEmit: {
      ...fullCoverage,
      rooms: [{ room: 'session:s1', memberCount: 0, recipientCount: 0 }],
    },
  }).classification,
  'SERVER ROOM EMPTY',
);

assert.equal(
  classify({ serverEmit: { ...fullCoverage, emittedSocketIds: ['sock-1'] } })
    .classification,
  'SERVER EMITTED, CLIENT MISSED',
);

assert.equal(
  classify({ serverEmit: { ...fullCoverage, gatewayDispatchCalled: false } })
    .classification,
  'SERVER DID NOT EMIT',
);

// A delivered row with NO publisher record at all under complete coverage must
// NOT be asserted as "our publisher skipped dispatch" — the delivery happened
// outside this trace's attribution scope (e.g. a concurrent publisher process).
assert.equal(
  classify({
    serverEmit: {
      ...fullCoverage,
      gatewayDispatchCalled: false,
      hasPublisherRecord: false,
    },
  }).classification,
  'DELIVERED WITHOUT DISPATCH TRACE',
);

// A claim-only record (created at claim time, pre-dispatch) with no dispatch
// call IS attributed to this trace's publisher — it is a genuine
// claim/dispatch gap, NOT an attribution gap.
assert.equal(
  classify({
    serverEmit: {
      ...fullCoverage,
      gatewayDispatchCalled: false,
      hasPublisherRecord: true,
      claimOnly: true,
    },
  }).classification,
  'SERVER DID NOT EMIT',
);

// claimOnly must NOT override dispatch evidence: a claim-only record plus a
// later dispatch (e.g. recordClaim then dispatchTraced both fired) takes the
// dispatch-evidence path, not the claim-gap branch.
assert.equal(
  classify({
    serverEmit: {
      ...fullCoverage,
      gatewayDispatchCalled: true,
      hasPublisherRecord: true,
      claimOnly: true,
    },
  }).classification,
  'SERVER DID NOT EMIT',
);

// A coalesced row must never be classified as a publisher dispatch anomaly.
assert.equal(
  classify({
    expectedEvent: { ...deliveredRow, coalesced: true },
    serverEmit: {
      ...fullCoverage,
      gatewayDispatchCalled: false,
      hasPublisherRecord: false,
    },
  }).classification,
  'COALESCED_SUPPRESSED',
);

// An event that never entered claimDueRows (still pending) must not produce a
// publisher-dispatch anomaly classification.
assert.equal(
  classify({
    expectedEvent: { ...deliveredRow, delivery_state: 'pending' },
    serverEmit: {
      ...fullCoverage,
      gatewayDispatchCalled: false,
      hasPublisherRecord: false,
    },
  }).classification,
  'EVENT NOT CLAIMED',
);

// A claimed row with dispatch evidence and a successful ack classifies via the
// emit-evidence branch: emitted to the socket → proven client miss (not a
// publisher anomaly).
assert.equal(
  classify({
    serverEmit: { ...fullCoverage, emittedSocketIds: ['sock-1'] },
  }).classification,
  'SERVER EMITTED, CLIENT MISSED',
);

// hasPublisherRecord=true with dispatch called keeps the emit-evidence path.
assert.equal(
  classify({
    serverEmit: {
      ...fullCoverage,
      gatewayDispatchCalled: true,
      hasPublisherRecord: true,
    },
  }).classification,
  'SERVER DID NOT EMIT',
);

assert.equal(
  classify({ serverEmit: { ...fullCoverage, coverageComplete: false } })
    .classification,
  'SERVER EMIT NOT RECORDED',
);

// A guard skip is more specific than an empty room, and must win.
assert.equal(
  classify({
    serverEmit: {
      ...fullCoverage,
      rooms: [{ room: 'session:s1', memberCount: 0, recipientCount: 0 }],
      guardSkips: [{ socketId: 'sock-1', guard: 'reauthorize_failed' }],
    },
  }).classification,
  'SERVER GUARD SKIP',
);

// --- client-side fallbacks (tracing disabled) ------------------------------

assert.equal(classify().classification, 'CLIENT NOT RECEIVED');

assert.equal(
  classify({ socket: socketEvidence({ receipts: [] }) }).classification,
  'HARNESS GAP',
);

assert.equal(
  classify({ socket: socketEvidence({ disconnectedAtMs: 500 }) })
    .classification,
  'SOCKET LOST',
);

// --- target correctness ----------------------------------------------------

assert.equal(
  classify({
    socket: socketEvidence({ participantId: 'p9' }),
    expectedEvent: { ...deliveredRow, target_participant_id: 'p0' },
  }).classification,
  'WRONG TARGET',
);

process.stdout.write('load-harness w3 pipeline-classify tests passed\n');
