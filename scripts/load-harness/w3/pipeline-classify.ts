/**
 * W3 pipeline classification + authorization helpers.
 *
 * When a durable event exists but a client did not receive it inside the bounded
 * drain window, W3 must say WHERE it stopped, not just "missing=N". This module
 * classifies along the pipeline:
 *
 *   EVENT NOT CREATED / EVENT NOT CLAIMED / EVENT NOT PUBLISHED /
 *   WRONG TARGET / SOCKET LOST / CLIENT NOT RECEIVED / HARNESS GAP / UNKNOWN
 *
 * Pure functions only — no I/O — so the logic is unit-testable.
 */
import type { SocketReceipt } from './w3-socket';

export interface PipelineEventRow {
  event_id?: string;
  event_seq: string;
  event_name: string;
  visibility: string;
  target_participant_id: string | null;
  delivery_state: string;
  coalesced?: boolean;
  last_failure_class?: string | null;
  claimed_at?: string | Date | null;
  delivered_at?: string | Date | null;
  server_timestamp?: string | Date | null;
}

export interface SocketEvidence {
  label: string;
  participantId?: string;
  isTeacher: boolean;
  connectedAtMs: number;
  disconnectedAtMs?: number;
  everConnected: boolean;
  receipts: SocketReceipt[];
  /** True when the any-listener was armed after connect resolved (race risk). */
  listenerArmedAfterConnect?: boolean;
}

export type MissingClassification =
  | 'EVENT NOT CREATED'
  | 'EVENT NOT CLAIMED'
  | 'EVENT NOT PUBLISHED'
  | 'COALESCED_SUPPRESSED'
  | 'SERVER ROOM EMPTY'
  | 'SERVER GUARD SKIP'
  | 'SERVER DELIVERY REJECTED'
  | 'SERVER EMITTED, CLIENT MISSED'
  | 'SERVER EMIT NOT RECORDED'
  | 'SERVER DID NOT EMIT'
  | 'DELIVERED WITHOUT DISPATCH TRACE'
  | 'WRONG TARGET'
  | 'SOCKET LOST'
  | 'CLIENT NOT RECEIVED'
  | 'HARNESS GAP'
  | 'UNKNOWN';

/**
 * Server-side emit evidence for one `eventSeq`, from the diagnostic trace
 * endpoint. All fields are optional/absent when tracing was disabled, in which
 * case the classifier must fall back to the client-side reasoning below rather
 * than assert a server conclusion.
 */
export interface ServerEmitEvidence {
  /** Tracing was enabled and the run id matched — server evidence is usable. */
  traceEnabled: boolean;
  /** True only when the trace buffer reported zero drops for this run. */
  coverageComplete: boolean;
  /**
   * True when the trace contains a publisher-phase record for this event
   * (claim/dispatch/ack). A delivered row with no publisher record at all was
   * delivered outside this trace's attribution scope — it must not be asserted
   * as "our publisher skipped dispatch".
   */
  hasPublisherRecord?: boolean;
  /**
   * True when the publisher record was created at claim time (pre-dispatch)
   * and dispatch was never entered — i.e. the claim IS attributed to this
   * trace's publisher, it just never dispatched.
   */
  claimOnly?: boolean;
  gatewayDispatchCalled?: boolean;
  dispatchThrew?: string;
  /** Rooms the fan-out enumerated, with membership and narrowed recipient counts. */
  rooms?: Array<{
    room: string;
    memberCount?: number;
    recipientCount?: number;
  }>;
  /** Socket ids for which an emit was actually attempted. */
  emittedSocketIds?: string[];
  guardSkips?: Array<{ socketId: string; guard: string }>;
  deliveryRejected?: Array<{ socketId: string; errorType?: string }>;
}

export interface ClassifyInput {
  label: string;
  expectedEventSeq: string;
  expectedEvent?: PipelineEventRow;
  socket: SocketEvidence;
  /** Optional window end (run-relative ms) for socket-lost reasoning. */
  windowEndMs?: number;
  /** Optional server-side emit evidence from the diagnostic trace endpoint. */
  serverEmit?: ServerEmitEvidence;
  /** The socket under test, matched against server emit/guard evidence. */
  socketId?: string;
}

export interface ClassifyResult {
  label: string;
  eventSeq: string;
  classification: MissingClassification;
  detail: string;
}

function timeMs(value: string | Date | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Classify why `socket` did not receive `expectedEventSeq`.
 *
 * Ordering matters: confirm the row exists, was claimed, was dispatched, targets
 * this socket's identity, and the socket was actually connected — only then is a
 * genuine client-side miss asserted. Anything unprovable is HARNESS GAP/UNKNOWN
 * rather than a false "client did not receive".
 */
export function classifyMissing(input: ClassifyInput): ClassifyResult {
  const { label, expectedEventSeq, expectedEvent, socket } = input;
  const base = { label, eventSeq: expectedEventSeq };

  if (!expectedEvent) {
    return {
      ...base,
      classification: 'EVENT NOT CREATED',
      detail: 'No durable live_session_event row for the expected sequence.',
    };
  }
  if (expectedEvent.visibility === 'participant_after_submit') {
    const target = expectedEvent.target_participant_id;
    if (!target) {
      return {
        ...base,
        classification: 'WRONG TARGET',
        detail: 'participant_after_submit row has no target_participant_id.',
      };
    }
    if (!socket.isTeacher && socket.participantId !== target) {
      return {
        ...base,
        classification: 'WRONG TARGET',
        detail: `Row targets ${target}, socket is ${socket.participantId ?? 'unknown'}.`,
      };
    }
    // Note: the teacher socket also receives a `result.updated` for every
    // claimed result row via emitTeacherResults (teacher-visibility projection).
    // A teacher miss on a targeted row is therefore NOT WRONG TARGET; it falls
    // through to the delivery-state / client-side checks below.
  }
  if (expectedEvent.delivery_state === 'pending') {
    return {
      ...base,
      classification: 'EVENT NOT CLAIMED',
      detail: `delivery_state=${expectedEvent.delivery_state}; publisher never claimed it.`,
    };
  }
  if (expectedEvent.delivery_state === 'retry') {
    return {
      ...base,
      classification: 'EVENT NOT PUBLISHED',
      detail: 'delivery_state=retry; dispatch failed and has not succeeded.',
    };
  }
  if (
    expectedEvent.delivery_state === 'processing' &&
    timeMs(expectedEvent.claimed_at) !== undefined &&
    timeMs(expectedEvent.delivered_at) === undefined
  ) {
    return {
      ...base,
      classification: 'EVENT NOT PUBLISHED',
      detail: 'Row is still processing (claimed, not delivered).',
    };
  }
  if (expectedEvent.delivery_state === 'dead') {
    return {
      ...base,
      classification: 'EVENT NOT PUBLISHED',
      detail: 'Row is dead-lettered (delivery_state=dead).',
    };
  }

  if (expectedEvent.coalesced === true) {
    return {
      ...base,
      classification: 'COALESCED_SUPPRESSED',
      detail:
        'The durable row was coalesced and suppressed by a newer aggregate event; no gateway delivery is required for this row.',
    };
  }

  // --- server-side emit evidence (authoritative when available) -------------
  // With tracing enabled these checks run BEFORE the client-side reasoning, so a
  // miss is attributed to the exact layer that dropped it rather than inferred.
  const server = input.serverEmit;
  if (server?.traceEnabled) {
    const targetSocketId = input.socketId;
    const guardSkip = targetSocketId
      ? server.guardSkips?.find((entry) => entry.socketId === targetSocketId)
      : undefined;
    if (guardSkip) {
      return {
        ...base,
        classification: 'SERVER GUARD SKIP',
        detail: `Server skipped the emit for this socket: guard=${guardSkip.guard}.`,
      };
    }
    const rejected = targetSocketId
      ? server.deliveryRejected?.find(
          (entry) => entry.socketId === targetSocketId,
        )
      : undefined;
    if (rejected) {
      return {
        ...base,
        classification: 'SERVER DELIVERY REJECTED',
        detail: `Per-socket delivery rejected on the server: ${rejected.errorType ?? 'unknown error'}.`,
      };
    }
    const emptyRoom = (server.rooms ?? []).find(
      (room) => (room.memberCount ?? 0) === 0,
    );
    if (emptyRoom) {
      return {
        ...base,
        classification: 'SERVER ROOM EMPTY',
        detail: `Target room ${emptyRoom.room} had 0 members at emit time.`,
      };
    }
    const emitted =
      targetSocketId !== undefined &&
      (server.emittedSocketIds ?? []).includes(targetSocketId);
    if (emitted) {
      // The server attempted the emit to this socket, no guard skipped it, and
      // the delivery was not rejected — so this is a PROVEN client-side miss.
      return {
        ...base,
        classification: 'SERVER EMITTED, CLIENT MISSED',
        detail:
          'Server recorded an emit to this socket (no guard skip, no rejected delivery) while the socket was connected — proven client-side miss.',
      };
    }
    if (server.claimOnly && !server.gatewayDispatchCalled) {
      // The claim IS attributed to this trace's publisher (claim-time record
      // exists) but dispatch was never entered — a genuine single-publisher
      // claim/dispatch gap, not an attribution gap.
      return {
        ...base,
        classification: 'SERVER DID NOT EMIT',
        detail:
          'Publisher claimed the row (claim-time record, attributed to this trace) but never entered dispatch; row marked delivered.',
      };
    }
    if (server.hasPublisherRecord === false && !server.gatewayDispatchCalled) {
      // Delivered in the DB, not coalesced, and no publisher-phase record at
      // all. With complete coverage this publisher never claimed/dispatched the
      // row, so the delivery happened outside this trace's attribution scope
      // (e.g. a concurrent publisher process). Do NOT assert "our publisher
      // skipped dispatch" — that overstates the evidence.
      return {
        ...base,
        classification: 'DELIVERED WITHOUT DISPATCH TRACE',
        detail:
          'Row is delivered in the DB with complete trace coverage, but no publisher claim/dispatch record exists — delivery happened outside this trace attribution scope (e.g. a concurrent publisher process); this trace cannot attribute the emission.',
      };
    }
    if (!server.gatewayDispatchCalled) {
      return {
        ...base,
        classification: 'SERVER DID NOT EMIT',
        detail:
          'Trace shows the publisher claimed the row but never entered dispatch for it, yet the row is marked delivered.',
      };
    }
    if (server.dispatchThrew) {
      return {
        ...base,
        classification: 'SERVER DID NOT EMIT',
        detail: `Gateway dispatch threw (${server.dispatchThrew}); row marked delivered anyway.`,
      };
    }
    // Dispatch ran, but no emit was recorded for this socket. Only assert
    // non-emission when the trace is provably complete for this run.
    if (server.coverageComplete) {
      return {
        ...base,
        classification: 'SERVER DID NOT EMIT',
        detail:
          'Dispatch ran and the trace buffer reported no drops, but no emit was recorded for this socket.',
      };
    }
    return {
      ...base,
      classification: 'SERVER EMIT NOT RECORDED',
      detail:
        'Dispatch ran but no emit was recorded for this socket and the trace buffer reported drops — instrumentation completeness is not proven.',
    };
  }

  // Row was delivered server-side; the miss is client-side or harness-side.
  // Rigorous HARNESS GAP vs CLIENT NOT RECEIVED: a connected socket always
  // receives a `session.snapshot` on connect, so a socket that recorded no
  // snapshot at all means the harness listener/transport never carried a
  // server->client frame — a harness fault, not a proven client miss.
  const snapshotReceived = socket.receipts.some(
    (r) => r.eventName === 'session.snapshot',
  );
  if (!snapshotReceived) {
    return {
      ...base,
      classification: 'HARNESS GAP',
      detail:
        'Socket connected but recorded no session.snapshot — listener/transport evidence incomplete; cannot assert a client miss.',
    };
  }
  if (socket.listenerArmedAfterConnect) {
    return {
      ...base,
      classification: 'HARNESS GAP',
      detail:
        'Listener was armed after connect resolved — a dispatch race cannot be ruled out.',
    };
  }
  if (!socket.everConnected) {
    return {
      ...base,
      classification: 'SOCKET LOST',
      detail: 'Socket never connected; no receipt was possible.',
    };
  }
  if (socket.disconnectedAtMs !== undefined) {
    return {
      ...base,
      classification: 'SOCKET LOST',
      detail: `Socket disconnected at ${socket.disconnectedAtMs.toFixed(0)}ms (run-relative).`,
    };
  }

  const sawNeighbour = socket.receipts.some(
    (r) => r.eventName === 'result.updated' && r.eventSeq !== undefined,
  );
  if (sawNeighbour) {
    return {
      ...base,
      classification: 'CLIENT NOT RECEIVED',
      detail:
        'Socket received session.snapshot and other result.updated events but not this one, while connected.',
    };
  }

  // Connected socket, snapshot received (transport carried server->client
  // frames), row was dispatched server-side — but this socket saw NO
  // result.updated at all. The pipeline delivered the frame and the listener
  // was live, so this is a genuine client-side miss, not an unknown.
  return {
    ...base,
    classification: 'CLIENT NOT RECEIVED',
    detail:
      'Socket received its session.snapshot (listener/transport proven live) and the row was dispatched, but this socket saw no result.updated event.',
  };
}

/**
 * Confirm a socket's authenticated identity matches the expected actor, so
 * socket↔participant mapping is trustworthy (W3 hard gate). Returns null when OK,
 * or a failure reason string.
 */
export function authorize(
  expectedParticipantId: string | undefined,
  socket: SocketEvidence,
): string | null {
  if (socket.isTeacher)
    return 'teacher socket supplied for a participant check';
  if (!socket.everConnected) return 'socket never connected';
  if (expectedParticipantId === undefined) return 'no expected participant id';
  if (socket.participantId !== expectedParticipantId)
    return `identity mismatch: ${socket.participantId} != ${expectedParticipantId}`;
  return null;
}
