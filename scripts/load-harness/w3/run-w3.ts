/**
 * W3 — Realtime Result Broadcast verification driver.
 *
 * Authorized pattern (W3 authorization 2026-09-20): one fresh disposable fixture
 * (1 teacher + 1 active LiveSession + 1 open SessionQuestion + N participants),
 * teacher socket + N participant sockets held open, staged execution, and the
 * question "does every client that should receive a result actually receive it,
 * and can no client see a restricted result".
 *
 * This is a VERIFICATION driver. It never mutates rows directly, never tunes the
 * server, and closes questions only through the real teacher application flow.
 *
 * Formal thresholds (../docs/智學互動平台/00_專案規劃/MVP 效能目標.md):
 *   Commit-to-broadcast p95 <= 2s, p99 <= 5s (W2, W3).
 *   Metric boundary: submission 成功 commit -> client receipt. Exact commit
 *   timestamps are unavailable (track_commit_timestamp=off), so commit->receipt
 *   uses the submit response end as the closest explainable proxy and is labelled
 *   COMMIT TIMING EVIDENCE GAP.
 */
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { LoadHttpClient } from '../http-client';
import { createOperation } from '../metrics';
import { W3SocketClient, type SocketReceipt } from './w3-socket';
import {
  classifyMissing,
  type ClassifyResult,
  type PipelineEventRow,
  type ServerEmitEvidence,
  type SocketEvidence,
} from './pipeline-classify';
import {
  rollupByEventSeq,
  TraceClient,
  type EventTraceRollup,
  type TraceSnapshot,
} from './trace-client';

type QuestionType = 'poll' | 'quiz';

interface Fixture {
  runId: string;
  questionType: QuestionType;
  username: string;
  courseId: string;
  questionId: string;
  liveSessionId: string;
  sessionQuestionId: string;
  sessionCode: string;
  options: Array<{ id: string; optionRef: string | null; isCorrect: boolean }>;
}

function assertFixture(value: unknown): asserts value is { fixture: Fixture } {
  if (!value || typeof value !== 'object')
    throw new Error('W3 fixture must be an object.');
  const fixture = (value as { fixture?: unknown }).fixture;
  if (!fixture || typeof fixture !== 'object')
    throw new Error('W3 fixture payload is missing.');
  const record = fixture as Record<string, unknown>;
  for (const field of [
    'runId',
    'username',
    'courseId',
    'questionId',
    'liveSessionId',
    'sessionQuestionId',
    'sessionCode',
  ]) {
    if (typeof record[field] !== 'string' || !record[field])
      throw new Error(`W3 fixture field ${field} is required.`);
  }
  if (record.questionType !== 'poll' && record.questionType !== 'quiz')
    throw new Error('W3 fixture questionType is invalid.');
  if (
    !Array.isArray(record.options) ||
    record.options.length !== 3 ||
    record.options.some(
      (option) =>
        !option ||
        typeof option !== 'object' ||
        typeof (option as Record<string, unknown>).id !== 'string' ||
        !(option as Record<string, unknown>).id,
    )
  ) {
    throw new Error('W3 fixture options are incomplete.');
  }
}

interface ParticipantClient {
  index: number;
  participantId: string;
  participantToken: string;
  socket: W3SocketClient;
  /** Deterministic cohort: answered (true) vs abstained (false). */
  answered: boolean;
  answerOptionId?: string;
}

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ]!;
}

function stats(values: readonly number[]) {
  const finite = values.filter((v) => Number.isFinite(v));
  return {
    count: finite.length,
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
    p99: percentile(finite, 99),
    max: finite.length ? Math.max(...finite) : 0,
  };
}

function withClient(values: Array<{ id: string; value: number }>) {
  const finite = values.filter((v) => Number.isFinite(v.value));
  const sorted = [...finite].sort((a, b) => a.value - b.value);
  const pick = (frac: number) =>
    sorted.length
      ? sorted[
          Math.min(sorted.length - 1, Math.floor(frac * (sorted.length - 1)))
        ]
      : undefined;
  return {
    stats: stats(finite.map((v) => v.value)),
    fastest: sorted[0],
    median: pick(0.5),
    p95Near: pick(0.95),
    slowest: sorted[sorted.length - 1],
  };
}

async function main(): Promise<void> {
  // ---- P0 preflight -------------------------------------------------------
  const fixturePath = process.env.W3_FIXTURE_PATH;
  const outputPath = process.env.W3_OUTPUT_PATH;
  const databaseUrl = process.env.DATABASE_URL;
  if (!fixturePath || !outputPath)
    throw new Error('W3_FIXTURE_PATH and W3_OUTPUT_PATH are required.');
  if (!databaseUrl?.includes('smartlearning_test'))
    throw new Error('DATABASE_URL must target smartlearning_test (refusing).');
  const baseUrl = process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3001';
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(baseUrl))
    throw new Error('W3 requires a loopback base URL (refusing).');
  const timeoutMs = toNumber(process.env.W3_TIMEOUT_MS, 15_000);

  let fixture: { fixture: Fixture };
  try {
    fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
      fixture: Fixture;
    };
    assertFixture(fixture);
  } catch (error) {
    throw new Error(
      `W3 fixture validation failed: ${error instanceof Error ? error.message : 'invalid JSON.'}`,
    );
  }
  const fx = fixture.fixture;
  if (!fx.liveSessionId || !fx.sessionQuestionId || !fx.sessionCode)
    throw new Error('W3 fixture is incomplete.');

  const participants = toNumber(process.env.W3_PARTICIPANTS, 20);
  // Deterministic cohort: alternate index submits / abstains.
  const answeredCount = Math.ceil(participants / 2);
  const splitMode = process.env.W3_COHORT_SPLIT ?? 'alternate';
  const isAnswered = (index: number) =>
    splitMode === 'first-half' ? index < answeredCount : index % 2 === 0;

  const runStart = performance.now();
  const toRel = (t: number) => t - runStart;
  const http = new LoadHttpClient(baseUrl, timeoutMs, undefined, fx.runId);
  const op = createOperation('w3', 'http');
  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();

  // Diagnostic trace (optional): when the backend was started with
  // REALTIME_TRACE_ENABLED=1 and this run's id, fetch server-side emit evidence
  // so a missing receipt can be attributed to the exact layer that dropped it.
  // Absent/disabled tracing is surfaced as `enabled=false` and never treated as
  // "the server did not emit" (see trace-client.ts).
  const traceEnabled = process.env.W3_TRACE !== '0';
  const traceClient = traceEnabled
    ? new TraceClient(baseUrl, fx.runId, runStart, timeoutMs)
    : undefined;
  let phaseBTrace: TraceSnapshot | undefined;
  let phaseCTrace: TraceSnapshot | undefined;
  const traceRollups = (
    snapshot: TraceSnapshot | undefined,
  ): Map<string, EventTraceRollup> => {
    const map = new Map<string, EventTraceRollup>();
    if (!snapshot) return map;
    for (const rollup of rollupByEventSeq(snapshot.records)) {
      map.set(rollup.eventSeq, rollup);
    }
    return map;
  };
  const serverEvidenceFor = (
    snapshot: TraceSnapshot | undefined,
    eventSeq: string,
  ): ServerEmitEvidence | undefined => {
    if (!snapshot?.enabled) return undefined;
    const rollup = traceRollups(snapshot).get(eventSeq);
    return {
      traceEnabled: true,
      coverageComplete: (snapshot.stats?.droppedCount ?? 0) === 0,
      // No publisher-phase record for this eventSeq at all → the row was
      // claimed/delivered outside this trace's attribution scope.
      hasPublisherRecord: rollup !== undefined,
      claimOnly: rollup?.claimOnly ?? false,
      gatewayDispatchCalled: rollup?.gatewayDispatchCalled ?? false,
      ...(rollup?.dispatchThrew ? { dispatchThrew: rollup.dispatchThrew } : {}),
      rooms: rollup?.rooms ?? [],
      emittedSocketIds: rollup?.emittedSocketIds ?? [],
      guardSkips: rollup?.guardSkips ?? [],
      deliveryRejected: rollup?.deliveryRejected ?? [],
    };
  };

  // ---- P1 join + connect --------------------------------------------------
  const joined: Array<{
    index: number;
    participantId: string;
    participantToken: string;
  }> = [];
  {
    const batch = 20;
    for (let start = 0; start < participants; start += batch) {
      const slice = Array.from(
        { length: Math.min(batch, participants - start) },
        (_, k) => start + k,
      );
      const results = await Promise.all(
        slice.map(async (index) => {
          const result = await http.join(
            op,
            fx.sessionCode,
            `w3-p-${String(index).padStart(4, '0')}`,
          );
          return {
            index,
            participantId: result.data?.participantId ?? '',
            participantToken: result.data?.participantToken ?? '',
          };
        }),
      );
      joined.push(...results);
    }
    if (
      joined.length !== participants ||
      joined.some((p) => !p.participantId || !p.participantToken)
    )
      throw new Error(
        `W3 join incomplete: joined=${joined.length}/${participants}.`,
      );
  }

  const clients: ParticipantClient[] = joined.map((p) => ({
    index: p.index,
    participantId: p.participantId,
    participantToken: p.participantToken,
    answered: isAnswered(p.index),
    socket: new W3SocketClient(`p${p.index}`, {
      baseUrl,
      runStartMs: runStart,
      timeoutMs,
      sessionCode: fx.sessionCode,
      participantToken: p.participantToken,
    }),
  }));

  // Teacher socket: needs a web-session login (separate cookie jar from the
  // fixture's teacher client) and the __Host-session cookie in the handshake.
  // The password is read from the run-owned ephemeral credential file (never an
  // artifact, never a log); it is never echoed.
  const credentialFile =
    process.env.W3_CREDENTIAL_FILE ??
    (fx as { credentialFile?: string }).credentialFile;
  if (!credentialFile)
    throw new Error('W3_CREDENTIAL_FILE is required for the teacher socket.');
  const teacherPassword = (await readFile(credentialFile, 'utf8')).trim();
  const teacherHttp = new LoadHttpClient(
    baseUrl,
    timeoutMs,
    undefined,
    fx.runId,
  );
  const teacherOp = createOperation('w3-teacher-login', 'http');
  await teacherHttp.loginTeacher(teacherOp, fx.username, teacherPassword);
  const teacherSocket = new W3SocketClient('teacher', {
    baseUrl,
    runStartMs: runStart,
    timeoutMs,
    cookieHeader: teacherHttp.getCookieHeader(),
    liveSessionId: fx.liveSessionId,
  });

  const connectErrors: Array<{ client: string; error: string }> = [];
  {
    const batch = 20;
    for (let start = 0; start < clients.length; start += batch) {
      await Promise.all(
        clients.slice(start, start + batch).map(async (client) => {
          try {
            await client.socket.connect();
          } catch (error) {
            connectErrors.push({
              client: `p${client.index}`,
              error: error instanceof Error ? error.message : 'CONNECT_ERROR',
            });
          }
        }),
      );
    }
    try {
      await teacherSocket.connect();
    } catch (error) {
      connectErrors.push({
        client: 'teacher',
        error: error instanceof Error ? error.message : 'CONNECT_ERROR',
      });
    }
  }

  // ---- P2 connection hard gate + stabilization ---------------------------
  const connectedParticipants = clients.filter((c) => c.socket.isConnected);
  const participantIds = new Set(clients.map((c) => c.participantId));
  const socketIds = clients
    .map((c) => c.socket.socketId)
    .filter((id): id is string => typeof id === 'string');
  const duplicateSocketIds = socketIds.length - new Set(socketIds).size;
  const connectionManifest = {
    teacherConnected: teacherSocket.isConnected,
    teacherSocketId: teacherSocket.socketId,
    participantsRequested: participants,
    participantsConnected: connectedParticipants.length,
    participantsJoined: participantIds.size,
    duplicateSocketIds,
    connectErrors,
    manifest: clients.map((c) => ({
      participantId: c.participantId,
      participantIndex: c.index,
      socketId: c.socket.socketId,
      connected: c.socket.isConnected,
      connectedAtMs: c.socket.connectedAtMs,
      everConnected: c.socket.everConnected,
      hasDisconnected: c.socket.hasDisconnected,
    })),
  };

  const stabilizeProbes: Array<{ atMs: number; connected: number }> = [];
  const stabilizeProbeCount = toNumber(process.env.W3_STABILIZE_PROBES, 3);
  for (let probe = 0; probe < stabilizeProbeCount; probe += 1) {
    await new Promise((resolve) =>
      setTimeout(resolve, toNumber(process.env.W3_STABILIZE_INTERVAL_MS, 300)),
    );
    stabilizeProbes.push({
      atMs: toRel(performance.now()),
      connected: clients.filter((c) => c.socket.isConnected).length,
    });
  }

  const hardGatePassed =
    teacherSocket.isConnected &&
    connectedParticipants.length === participants &&
    duplicateSocketIds === 0 &&
    stabilizeProbes.every((p) => p.connected === participants);

  const socketEvidence = (): SocketEvidence[] => [
    ...clients.map((c) => ({
      label: `p${c.index}`,
      participantId: c.participantId,
      isTeacher: false,
      connectedAtMs: c.socket.connectedAtMs ?? -1,
      disconnectedAtMs: c.socket.lifecycle.find((l) => l.kind === 'disconnect')
        ?.atMs,
      everConnected: c.socket.everConnected,
      receipts: c.socket.receipts,
      listenerArmedAfterConnect: c.socket.listenerArmedAfterConnect,
    })),
    {
      label: 'teacher',
      isTeacher: true,
      connectedAtMs: teacherSocket.connectedAtMs ?? -1,
      disconnectedAtMs: teacherSocket.lifecycle.find(
        (l) => l.kind === 'disconnect',
      )?.atMs,
      everConnected: teacherSocket.everConnected,
      receipts: teacherSocket.receipts,
      listenerArmedAfterConnect: teacherSocket.listenerArmedAfterConnect,
    },
  ];

  const writeArtifact = async (report: Record<string, unknown>) => {
    try {
      const existing = await readFile(outputPath, 'utf8');
      if (existing.trim().length > 0)
        throw new Error(
          `W3 artifact already exists; refusing to overwrite: ${outputPath}`,
        );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('refusing to overwrite')
      )
        throw error;
    }
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  };

  if (!hardGatePassed) {
    const blocked = {
      schemaVersion: 1,
      phase: 'W3-realtime-result-broadcast',
      runId: fx.runId,
      questionType: fx.questionType,
      participants,
      verdict: { correctness: 'BLOCKED', performance: 'BLOCKED' },
      blockedReason:
        'Realtime connection hard gate failed: teacher + N participant sockets were not stably connected.',
      connectionManifest,
      stabilizeProbes,
      safety: { secretsRedacted: true, destructiveCleanup: false },
    };
    // Do not overwrite a real artifact; blocked runs go to a sidecar path.
    const blockedPath = outputPath.replace(/\.json$/, '-blocked.json');
    await writeFile(
      blockedPath,
      `${JSON.stringify(blocked, null, 2)}\n`,
      'utf8',
    );
    clients.forEach((c) => c.socket.disconnect());
    teacherSocket.disconnect();
    await pg.end();
    process.stdout.write(
      `W3 BLOCKED: connected=${connectedParticipants.length}/${participants} teacher=${teacherSocket.isConnected}\n`,
    );
    return;
  }

  // ---- P3 Phase A: open, nobody answered (access control) ---------------
  // Give the open transition's own events time to settle before probing, but do
  // not count startup traffic as a delivery failure.
  await new Promise((resolve) =>
    setTimeout(resolve, toNumber(process.env.W3_SOCKET_SETTLE_MS, 1500)),
  );

  const openEvents = await pg.query<PipelineEventRow>(
    `SELECT event_seq::text AS event_seq, event_name, visibility,
            target_participant_id, delivery_state
     FROM live_session_event
     WHERE live_session_id = $1 AND session_question_id = $2 AND event_name = 'result.updated'
     ORDER BY event_seq`,
    [fx.liveSessionId, fx.sessionQuestionId],
  );
  const openResultSeqs = new Set(openEvents.rows.map((r) => r.event_seq));

  const isResultUpdated = (receipt: SocketReceipt) =>
    receipt.eventName === 'result.updated' &&
    (receipt.eventSeq === undefined || !openResultSeqs.has(receipt.eventSeq));
  const restrictedLeak = clients.filter((c) =>
    c.socket.receipts.some(
      (r) => isResultUpdated(r) && typeof r.payload.data === 'object',
    ),
  );

  // Teacher must see the open aggregate through the authoritative query.
  const openTeacherResults = await teacherHttp.teacherGetResults(
    teacherOp,
    fx.liveSessionId,
    fx.sessionQuestionId,
  );

  // Explicit authoritative access-control probe (not inferred from receipts):
  // an abstaining participant's own results query must be refused while open.
  const abstainer = clients.find((c) => !c.answered);
  const abstainerProbe = abstainer
    ? await http.participantGetResults(
        op,
        fx.liveSessionId,
        fx.sessionQuestionId,
        abstainer.participantToken,
      )
    : undefined;
  // The error envelope carries `data: null` (not undefined) on refusal.
  const abstainerRefused =
    abstainerProbe !== undefined &&
    abstainerProbe.status === 409 &&
    abstainerProbe.errorCode === 'RESULTS_NOT_REVEALED' &&
    abstainerProbe.data == null;

  const phaseA = {
    openResultEventCount: openEvents.rows.length,
    participantsWithRestrictedReceiptBeforeAnswering: restrictedLeak.length,
    leakingParticipants: restrictedLeak.map((c) => `p${c.index}`),
    teacherSawAggregate: Array.isArray(openTeacherResults.data?.options),
    abstainerProbe: {
      status: abstainerProbe?.status ?? null,
      errorCode: abstainerProbe?.errorCode ?? null,
      refused: abstainerRefused,
    },
    leakage: restrictedLeak.length > 0 || !abstainerRefused,
  };

  if (phaseA.leakage) {
    const failed = {
      schemaVersion: 1,
      phase: 'W3-realtime-result-broadcast',
      runId: fx.runId,
      questionType: fx.questionType,
      participants,
      verdict: { correctness: 'FAIL', performance: 'NOT_MEASURED' },
      reason: 'W3 ACCESS-CONTROL FAIL: restricted result leaked while open.',
      connectionManifest,
      phaseA,
      safety: { secretsRedacted: true, destructiveCleanup: false },
    };
    await writeArtifact(failed);
    clients.forEach((c) => c.socket.disconnect());
    teacherSocket.disconnect();
    await pg.end();
    process.stdout.write('W3 ACCESS-CONTROL FAIL\n');
    return;
  }

  // ---- P4 Phase B: vote-to-reveal ---------------------------------------
  const submitOp = createOperation('w3-submit', 'http');
  const optionPool = fx.options.map((o) => o.id);
  const answerByIndex = new Map<number, string>();
  const submitRecords = new Map<
    number,
    { requestStartMs: number; responseEndMs: number; submissionId?: string }
  >();
  const answeredClients = clients.filter((c) => c.answered);
  await Promise.all(
    answeredClients.map(async (client) => {
      const optionId = optionPool[client.index % optionPool.length] ?? '';
      client.answerOptionId = optionId;
      answerByIndex.set(client.index, optionId);
      const requestStart = performance.now();
      const result = await http.submitRaw(
        submitOp,
        fx.liveSessionId,
        fx.sessionQuestionId,
        client.participantToken,
        { selectedOptionRefs: [optionId] },
        randomUUID(),
        `w3-${fx.runId}-${client.index}`,
      );
      const responseEnd = performance.now();
      submitRecords.set(client.index, {
        requestStartMs: toRel(requestStart),
        responseEndMs: toRel(responseEnd),
        submissionId: result.data?.id,
      });
    }),
  );

  // Bounded drain: wait until every open-state result.updated row is delivered.
  const drainDeadlineMs = toNumber(process.env.W3_BROADCAST_SETTLE_MS, 900_000);
  const drainStart = performance.now();
  const countUndelivered = async (): Promise<number> => {
    const r = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM live_session_event
       WHERE live_session_id = $1 AND event_name = 'result.updated' AND delivery_state <> 'delivered'`,
      [fx.liveSessionId],
    );
    return Number(r.rows[0]?.n ?? 0);
  };
  let undelivered = await countUndelivered();
  while (undelivered > 0 && performance.now() - drainStart < drainDeadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    undelivered = await countUndelivered();
  }
  const drainWaitMs = performance.now() - drainStart;
  // A final grace so late socket frames land before we freeze receipts.
  await new Promise((resolve) =>
    setTimeout(resolve, toNumber(process.env.W3_TAIL_SETTLE_MS, 2000)),
  );

  // Fetch point 1: phase-B server-side trace, before close traffic can crowd the
  // bounded buffer.
  if (traceClient) phaseBTrace = await traceClient.fetch();

  const voteEvents = await pg.query<PipelineEventRow>(
    `SELECT id AS event_id, event_seq::text AS event_seq, event_name, visibility,
            target_participant_id, delivery_state, coalesced, last_failure_class,
            claimed_at, delivered_at, server_timestamp
     FROM live_session_event
     WHERE live_session_id = $1 AND session_question_id = $2 AND event_name = 'result.updated'
     ORDER BY event_seq`,
    [fx.liveSessionId, fx.sessionQuestionId],
  );
  const voteRows = voteEvents.rows.filter(
    (r) => r.visibility === 'participant_after_submit',
  );
  const voteSeqByParticipant = new Map<string, string>();
  for (const row of voteRows) {
    if (row.target_participant_id)
      voteSeqByParticipant.set(row.target_participant_id, row.event_seq);
  }

  // Recipient matrix over ALL participants (no sampling).
  const recipientMatrix = clients.map((client) => {
    const expectedReveal = client.answered;
    const expectedSeq = voteSeqByParticipant.get(client.participantId);
    const receipt = client.socket.receipts.find(
      (r) => r.eventName === 'result.updated' && r.eventSeq === expectedSeq,
    );
    return {
      client: `p${client.index}`,
      participantId: client.participantId,
      answered: client.answered,
      expectedReveal,
      expectedEventSeq: expectedSeq ?? null,
      actualReceipt: Boolean(receipt),
      receiptEventSeq: receipt?.eventSeq ?? null,
      receiptAtMs: receipt?.receivedAtMs ?? null,
    };
  });
  const expectedYes = recipientMatrix.filter((m) => m.expectedReveal).length;
  const actualYes = recipientMatrix.filter(
    (m) => m.expectedReveal && m.actualReceipt,
  ).length;
  const expectedNo = recipientMatrix.filter((m) => !m.expectedReveal).length;
  const forbiddenDelivery = recipientMatrix.filter(
    (m) => !m.expectedReveal && m.actualReceipt,
  ).length;
  // Delayed-but-received = the event was delivered late (beyond the threshold)
  // but still landed; permanent missing = no receipt at all after drain+tail.
  const missingYes = expectedYes - actualYes;
  const missingClients = recipientMatrix.filter(
    (m) => m.expectedReveal && !m.actualReceipt,
  );

  const missingClassification: ClassifyResult[] = missingClients.map((m) => {
    const client = clients.find((c) => c.participantId === m.participantId)!;
    const seq = voteSeqByParticipant.get(m.participantId) ?? '';
    const serverEmit = serverEvidenceFor(phaseBTrace, seq);
    return classifyMissing({
      label: `p${client.index}`,
      expectedEventSeq: seq,
      expectedEvent: voteRows.find((r) => r.event_seq === seq),
      socket: {
        label: `p${client.index}`,
        participantId: m.participantId,
        isTeacher: false,
        connectedAtMs: client.socket.connectedAtMs ?? -1,
        disconnectedAtMs: client.socket.lifecycle.find(
          (l) => l.kind === 'disconnect',
        )?.atMs,
        everConnected: client.socket.everConnected,
        receipts: client.socket.receipts,
      },
      ...(client.socket.socketId ? { socketId: client.socket.socketId } : {}),
      ...(serverEmit ? { serverEmit } : {}),
    });
  });

  // Duplicates: same eventSeq received more than once by one socket.
  const duplicateDeliveries = clients.flatMap((client) => {
    const counts = new Map<string, number>();
    for (const r of client.socket.receipts) {
      if (r.eventName !== 'result.updated' || r.eventSeq === undefined)
        continue;
      counts.set(r.eventSeq, (counts.get(r.eventSeq) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([seq, n]) => ({
        client: `p${client.index}`,
        eventSeq: seq,
        count: n,
      }));
  });

  // Vote-to-reveal latency: commit proxy (submit response end) -> receipt.
  const voteLatency = answeredClients.map((client) => {
    const record = submitRecords.get(client.index);
    const seq = voteSeqByParticipant.get(client.participantId);
    const receipt = client.socket.receipts.find(
      (r) => r.eventName === 'result.updated' && r.eventSeq === seq,
    );
    return {
      id: `p${client.index}`,
      value:
        record && receipt ? receipt.receivedAtMs - record.responseEndMs : NaN,
    };
  });

  // Publish-proxy latency: server publish (event server_timestamp) -> receipt.
  // Both ends use wall-clock ISO: mixing performance.now() with a DB timestamp
  // produces nonsense (caught during W3 smoke).
  const wallDeltaMs = (receivedIso: string | undefined, published: unknown) => {
    if (!receivedIso || published === undefined || published === null)
      return NaN;
    return Date.parse(receivedIso) - Date.parse(String(published));
  };
  const votePublishLatency = answeredClients.map((client) => {
    const seq = voteSeqByParticipant.get(client.participantId);
    const row = voteRows.find((r) => r.event_seq === seq);
    const receipt = client.socket.receipts.find(
      (r) => r.eventName === 'result.updated' && r.eventSeq === seq,
    );
    return {
      id: `p${client.index}`,
      value: wallDeltaMs(receipt?.receivedAtIso, row?.server_timestamp),
    };
  });

  // Teacher Phase-B receipts: measured separately (the repo fans out a
  // teacher-visibility result.updated for every claimed result row via
  // emitTeacherResults, so the teacher receives N events during Phase B). This
  // is recorded as a finding — a plausible contributor to the W2 drain time —
  // and is NOT part of the "missing required = 0" participant gate.
  const teacherPhaseBReceipts = teacherSocket.receipts.filter(
    (r) => r.eventName === 'result.updated',
  );

  // Authoritative results query while open (only answered participants reveal).
  const openResults = await teacherHttp.teacherGetResults(
    teacherOp,
    fx.liveSessionId,
    fx.sessionQuestionId,
  );

  const phaseBTraceRollups = traceRollups(phaseBTrace);
  const voteEventMatrix = voteRows.map((row) => {
    const trace = phaseBTraceRollups.get(row.event_seq);
    const receipt = clients
      .flatMap((client) => client.socket.receipts)
      .find(
        (r) => r.eventName === 'result.updated' && r.eventSeq === row.event_seq,
      );
    // Lifecycle attribution (mutually exclusive):
    //   A COALESCED_BEFORE_CLAIM — superseded before claimDueRows(); no
    //     publisher dispatch is expected for this row.
    //   B CLAIMED_NOT_DISPATCHED — publisher claimed the row but dispatch was
    //     never entered (trace coverage complete).
    //   C DISPATCHED_NOT_DELIVERED — dispatch entered but the ack did not
    //     succeed.
    //   D DELIVERED — claim → dispatch → ack all succeeded.
    //   UNRESOLVED_DELIVERED_NO_PUBLISHER_RECORD — DB says delivered, not
    //     coalesced, and no publisher-phase record exists under complete
    //     coverage: delivered outside this trace's attribution scope.
    //   UNRESOLVED — anything else.
    const dispatchEntered = trace?.gatewayDispatchCalled === true;
    const claimOnly = trace?.claimOnly === true;
    const transitionTo = trace?.transitionTo;
    let finalClassification: string;
    if (row.coalesced === true) {
      finalClassification = 'COALESCED_BEFORE_CLAIM';
    } else if (claimOnly && !dispatchEntered) {
      // Claim attributed to this trace's publisher, dispatch never entered.
      finalClassification = 'CLAIMED_NOT_DISPATCHED';
    } else if (trace === undefined) {
      finalClassification = 'UNRESOLVED_DELIVERED_NO_PUBLISHER_RECORD';
    } else if (!dispatchEntered) {
      finalClassification = 'CLAIMED_NOT_DISPATCHED';
    } else if (transitionTo !== 'delivered') {
      finalClassification = 'DISPATCHED_NOT_DELIVERED';
    } else {
      finalClassification = 'DELIVERED';
    }
    return {
      eventId: row.event_id ?? null,
      eventSeq: row.event_seq,
      expectedParticipantId: row.target_participant_id,
      deliveryState: row.delivery_state,
      lastFailureClass: row.last_failure_class ?? null,
      coalesced: row.coalesced === true,
      supersedingEventId: trace?.coalescedByEventId ?? null,
      supersedingEventSeq: trace?.coalescedByEventSeq ?? null,
      dispatchEntered,
      gatewayEmitted: (trace?.emittedSocketIds.length ?? 0) > 0,
      clientReceived: Boolean(receipt),
      finalClassification,
    };
  });
  const phaseB = {
    answeredCount,
    abstainedCount: participants - answeredCount,
    expectedYes,
    actualYes,
    expectedNo,
    forbiddenDelivery,
    missingYes,
    delayedButReceived: 0,
    votePermanentMissing: missingClients.length,
    voteResultEvents: voteRows.length,
    coalescedCount: voteRows.filter((row) => row.coalesced === true).length,
    coalescedBeforeClaimCount: voteEventMatrix.filter(
      (row) => row.finalClassification === 'COALESCED_BEFORE_CLAIM',
    ).length,
    claimedNotDispatchedCount: voteEventMatrix.filter(
      (row) => row.finalClassification === 'CLAIMED_NOT_DISPATCHED',
    ).length,
    dispatchedNotDeliveredCount: voteEventMatrix.filter(
      (row) => row.finalClassification === 'DISPATCHED_NOT_DELIVERED',
    ).length,
    deliveredCount: voteEventMatrix.filter(
      (row) => row.finalClassification === 'DELIVERED',
    ).length,
    unresolvedDeliveredNoPublisherRecordCount: voteEventMatrix.filter(
      (row) =>
        row.finalClassification === 'UNRESOLVED_DELIVERED_NO_PUBLISHER_RECORD',
    ).length,
    dispatchedCount: voteRows.filter((row) => row.coalesced !== true).length,
    gatewayEmittedCount: voteEventMatrix.filter((row) => row.gatewayEmitted)
      .length,
    clientReceivedCount: voteEventMatrix.filter((row) => row.clientReceived)
      .length,
    voteEventMatrix,
    drainWaitMs,
    recipientMatrix,
    missingClassification,
    duplicateDeliveries,
    voteLatency: withClient(voteLatency),
    votePublishLatency: withClient(votePublishLatency),
    teacherPhaseB: {
      note: 'Teacher receives a teacher-visibility result.updated per claimed result row (emitTeacherResults). Measured separately; excluded from the participant required-delivery gate.',
      receiptCount: teacherPhaseBReceipts.length,
      expectedAtLeast: answeredCount,
      eventSeqs: teacherPhaseBReceipts.map((r) => r.eventSeq ?? null),
    },
    authoritativeOptions: (openResults.data?.options ?? []).map(
      (o: { optionId: string; count?: number }) => ({
        optionId: o.optionId,
        count: o.count,
      }),
    ),
  };

  // ---- P5/P6 Phase C: close + final broadcast ---------------------------
  const closeOp = createOperation('w3-close', 'http');
  const closeRequestStart = performance.now();
  const closeResult = await teacherHttp.closeSessionQuestion(
    closeOp,
    fx.liveSessionId,
    fx.sessionQuestionId,
  );
  const closeResponseEnd = performance.now();
  if (closeResult.status < 200 || closeResult.status >= 300)
    throw new Error(
      `W3 close failed (${closeResult.errorCode ?? closeResult.status}).`,
    );

  // Bounded drain for the close-time room-wide result row.
  const closeDrainStart = performance.now();
  undelivered = await countUndelivered();
  while (
    undelivered > 0 &&
    performance.now() - closeDrainStart < drainDeadlineMs
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    undelivered = await countUndelivered();
  }
  const closeDrainMs = performance.now() - closeDrainStart;
  await new Promise((resolve) =>
    setTimeout(resolve, toNumber(process.env.W3_TAIL_SETTLE_MS, 2000)),
  );

  // Fetch point 2: phase-C server-side trace, before sockets disconnect and
  // before the DB client ends.
  if (traceClient) phaseCTrace = await traceClient.fetch();

  const finalEvents = await pg.query<PipelineEventRow>(
    `SELECT id AS event_id, event_seq::text AS event_seq, event_name, visibility,
            target_participant_id, delivery_state, coalesced, last_failure_class,
            claimed_at, delivered_at, server_timestamp
     FROM live_session_event
     WHERE live_session_id = $1 AND session_question_id = $2 AND event_name = 'result.updated'
     ORDER BY event_seq`,
    [fx.liveSessionId, fx.sessionQuestionId],
  );
  const closeRows = finalEvents.rows.filter(
    (r) => r.visibility === 'participant',
  );
  const closeSeq = closeRows[closeRows.length - 1]?.event_seq;

  const closedRecipients = [
    ...clients.map((client) => {
      const receipt = client.socket.receipts.find(
        (r) => r.eventName === 'result.updated' && r.eventSeq === closeSeq,
      );
      return {
        client: `p${client.index}`,
        kind: 'participant',
        expected: true,
        received: Boolean(receipt),
        receiptEventSeq: receipt?.eventSeq ?? null,
        receiptAtMs: receipt?.receivedAtMs ?? null,
      };
    }),
    {
      client: 'teacher',
      kind: 'teacher',
      expected: true,
      received: teacherSocket.receipts.some(
        (r) =>
          r.eventName === 'result.updated' &&
          (closeSeq === undefined || r.eventSeq === closeSeq),
      ),
      receiptEventSeq:
        teacherSocket.receipts.find((r) => r.eventName === 'result.updated')
          ?.eventSeq ?? null,
      receiptAtMs:
        teacherSocket.receipts.find(
          (r) =>
            r.eventName === 'result.updated' &&
            (closeSeq === undefined || r.eventSeq === closeSeq),
        )?.receivedAtMs ?? null,
    },
  ];
  const closedExpected = closedRecipients.filter((r) => r.expected).length;
  const closedActual = closedRecipients.filter(
    (r) => r.expected && r.received,
  ).length;
  const closedMissing = closedRecipients.filter(
    (r) => r.expected && !r.received,
  );

  const closedMissingClassification = closedMissing.map((m) => {
    const client = clients.find((c) => `p${c.index}` === m.client);
    const socket = m.kind === 'teacher' ? teacherSocket : client?.socket;
    const serverEmit = serverEvidenceFor(phaseCTrace, closeSeq ?? '');
    return classifyMissing({
      label: m.client,
      expectedEventSeq: closeSeq ?? '',
      expectedEvent: closeRows[closeRows.length - 1],
      socket: {
        label: m.client,
        participantId: client?.participantId,
        isTeacher: m.kind === 'teacher',
        connectedAtMs: socket?.connectedAtMs ?? -1,
        disconnectedAtMs: socket?.lifecycle.find((l) => l.kind === 'disconnect')
          ?.atMs,
        everConnected: socket?.everConnected ?? false,
        receipts: socket?.receipts ?? [],
      },
      ...(socket?.socketId ? { socketId: socket.socketId } : {}),
      ...(serverEmit ? { serverEmit } : {}),
    });
  });

  const closeLatency = [
    ...clients.map((client) => {
      const receipt = client.socket.receipts.find(
        (r) => r.eventName === 'result.updated' && r.eventSeq === closeSeq,
      );
      return {
        id: `p${client.index}`,
        value: receipt ? receipt.receivedAtMs - toRel(closeResponseEnd) : NaN,
      };
    }),
    {
      id: 'teacher',
      value: (() => {
        const receipt = teacherSocket.receipts.find(
          (r) => r.eventName === 'result.updated' && r.eventSeq === closeSeq,
        );
        return receipt ? receipt.receivedAtMs - toRel(closeResponseEnd) : NaN;
      })(),
    },
  ];

  // Final-broadcast duplicates: same close eventSeq delivered more than once
  // to a single socket (per-recipient; one seq is shared by all recipients).
  const closeDuplicateDeliveries = clients
    .map((client) => {
      const count = client.socket.receipts.filter(
        (r) => r.eventName === 'result.updated' && r.eventSeq === closeSeq,
      ).length;
      return { client: `p${client.index}`, eventSeq: closeSeq ?? null, count };
    })
    .filter((entry) => entry.count > 1);

  // Final-broadcast publish-proxy latency (server_timestamp -> receipt), using
  // wall-clock on both ends (see votePublishLatency note).
  const closeRow = closeRows[closeRows.length - 1];
  const closePublishLatency = [
    ...clients.map((client) => {
      const receipt = client.socket.receipts.find(
        (r) => r.eventName === 'result.updated' && r.eventSeq === closeSeq,
      );
      return {
        id: `p${client.index}`,
        value: wallDeltaMs(receipt?.receivedAtIso, closeRow?.server_timestamp),
      };
    }),
    {
      id: 'teacher',
      value: (() => {
        const receipt = teacherSocket.receipts.find(
          (r) => r.eventName === 'result.updated' && r.eventSeq === closeSeq,
        );
        return wallDeltaMs(receipt?.receivedAtIso, closeRow?.server_timestamp);
      })(),
    },
  ];

  // ---- P11 authoritative consistency ------------------------------------
  const dbSubmissions = await pg.query<{
    participant_id: string;
    selected_option_refs: unknown;
  }>(
    `SELECT participant_id, selected_option_refs FROM submission
     WHERE live_session_id = $1 AND session_question_id = $2`,
    [fx.liveSessionId, fx.sessionQuestionId],
  );
  const finalResults = await teacherHttp.teacherGetResults(
    teacherOp,
    fx.liveSessionId,
    fx.sessionQuestionId,
  );
  const dbOptionCounts = new Map<string, number>();
  for (const row of dbSubmissions.rows) {
    const refs = Array.isArray(row.selected_option_refs)
      ? (row.selected_option_refs as string[])
      : [];
    for (const ref of refs)
      dbOptionCounts.set(ref, (dbOptionCounts.get(ref) ?? 0) + 1);
  }
  const authoritativeOptions = (finalResults.data?.options ?? []).map(
    (o: { optionId: string; count?: number; isCorrect?: boolean }) => ({
      optionId: o.optionId,
      count: o.count,
      isCorrect: o.isCorrect,
    }),
  );
  const authoritativeExact =
    dbSubmissions.rows.length === answeredCount &&
    authoritativeOptions.every(
      (o) => (o.count ?? 0) === (dbOptionCounts.get(o.optionId) ?? 0),
    ) &&
    [...dbOptionCounts.keys()].every((id) =>
      authoritativeOptions.some((o) => o.optionId === id),
    );

  // Participant-side authoritative view AFTER close: the aggregate must now be
  // visible to a participant and must equal the teacher aggregate exactly.
  const answeredClient = clients.find((c) => c.answered);
  const participantAfterClose = answeredClient
    ? await http.participantGetResults(
        op,
        fx.liveSessionId,
        fx.sessionQuestionId,
        answeredClient.participantToken,
      )
    : undefined;
  const participantViewOptions = (
    participantAfterClose?.data?.options ?? []
  ).map((o) => ({ optionId: o.optionId, count: o.count }));
  const participantViewExact =
    participantViewOptions.length > 0 &&
    participantViewOptions.every(
      (o) =>
        (o.count ?? 0) ===
        (authoritativeOptions.find((a) => a.optionId === o.optionId)?.count ??
          -1),
    );

  // ---- P8 verdicts -------------------------------------------------------
  const voteStats = phaseB.voteLatency.stats;
  const closeStats = withClient(closeLatency).stats;

  // Missing-delivery taxonomy: a targeted vote-to-reveal receipt that never
  // arrived after the bounded drain+tail window is a PERMANENT miss and fails
  // required-delivery correctness (delayed-but-received would not).
  const votePermanentMissing = missingClients.length;

  const correctnessPass =
    !phaseA.leakage &&
    forbiddenDelivery === 0 &&
    votePermanentMissing === 0 &&
    closedMissing.length === 0 &&
    duplicateDeliveries.length === 0 &&
    closeDuplicateDeliveries.length === 0 &&
    authoritativeExact &&
    participantViewExact;
  const performancePass =
    voteStats.p95 <= 2000 &&
    voteStats.p99 <= 5000 &&
    closeStats.p95 <= 2000 &&
    closeStats.p99 <= 5000;

  const report = {
    schemaVersion: 1,
    phase: 'W3-realtime-result-broadcast',
    runId: fx.runId,
    questionType: fx.questionType,
    participants,
    fixture: {
      courseId: fx.courseId,
      questionId: fx.questionId,
      liveSessionId: fx.liveSessionId,
      sessionQuestionId: fx.sessionQuestionId,
      sessionCode: fx.sessionCode,
    },
    connectionManifest,
    stabilizeProbes,
    socketTimelines: socketEvidence().map((s) => ({
      label: s.label,
      participantId: s.participantId ?? null,
      isTeacher: s.isTeacher,
      everConnected: s.everConnected,
      connectedAtMs: s.connectedAtMs,
      disconnectedAtMs: s.disconnectedAtMs ?? null,
      receiptCount: s.receipts.length,
      resultUpdatedSeqs: s.receipts
        .filter((r) => r.eventName === 'result.updated')
        .map((r) => r.eventSeq ?? null),
    })),
    phaseA,
    phaseB,
    phaseC: {
      closeSeq: closeSeq ?? null,
      closeRows: closeRows.length,
      closeRequestStartMs: toRel(closeRequestStart),
      closeResponseEndMs: toRel(closeResponseEnd),
      closeDrainMs,
      closedExpected,
      closedActual,
      closedMissing: closedMissing.map((m) => m.client),
      closedMissingClassification,
      duplicateDeliveries: closeDuplicateDeliveries,
      recipients: closedRecipients,
      closeLatency: withClient(closeLatency),
      closePublishLatency: withClient(closePublishLatency),
    },
    missingClassification,
    authoritative: {
      dbSubmissionCount: dbSubmissions.rows.length,
      expectedSubmissionCount: answeredCount,
      options: authoritativeOptions,
      dbOptionCounts: Object.fromEntries(dbOptionCounts),
      exact: authoritativeExact,
      participantAfterClose: {
        status: participantAfterClose?.status ?? null,
        options: participantViewOptions,
        exact: participantViewExact,
      },
    },
    latency: {
      threshold: {
        commitToBroadcastP95Ms: 2000,
        commitToBroadcastP99Ms: 5000,
        source: '../docs/智學互動平台/00_專案規劃/MVP 效能目標.md',
      },
      commitToBroadcastNote:
        'COMMIT TIMING EVIDENCE GAP: exact commit timestamp unavailable (track_commit_timestamp=off); submit/close response end used as the closest explainable proxy, per W2 precedent.',
      voteToReveal: phaseB.voteLatency,
      voteToRevealPublishProxy: phaseB.votePublishLatency,
      finalBroadcast: withClient(closeLatency),
      finalBroadcastPublishProxy: withClient(closePublishLatency),
    },
    // Diagnostic trace: server-side emit evidence. `enabled=false` means the
    // backend was not started with REALTIME_TRACE_ENABLED=1 for this run id, so
    // a missing receipt CANNOT be attributed to the server layer from this run.
    serverTrace: {
      traceEnabled,
      deliveryStateSemantics:
        "delivery_state='delivered' is split in this diagnostic: DELIVERED when the publisher claim→dispatch→ack path all succeeded, COALESCED_BEFORE_CLAIM when coalescing superseded the row before claim, or UNRESOLVED_DELIVERED_NO_PUBLISHER_RECORD when the row is delivered with no publisher record under complete coverage (delivered outside this trace's attribution scope); none of these mean client-delivered by themselves.",
      documentedContract: {
        source: '../docs/智學互動平台/30_系統設計/即時同步與結果治理設計.md',
        summary:
          'Open vote-to-reveal results are targeted to the submitting participant; close publishes the final participant-safe result to all eligible participants. Latest non-authoritative result.updated notifications may coalesce.',
        contractAmbiguity:
          'High-level W3 wording does not explicitly require every answered participant to receive every intermediate aggregate update; repository API/runtime docs define the own-submit targeted event and final close fan-out.',
      },
      phaseB: summarizeTrace(phaseBTrace),
      phaseC: summarizeTrace(phaseCTrace),
      phaseBRollups: [...traceRollups(phaseBTrace).values()],
      phaseCRollups: [...traceRollups(phaseCTrace).values()],
    },
    verdict: {
      correctness: correctnessPass ? 'PASS' : 'FAIL',
      performance: performancePass ? 'PASS' : 'FAIL',
      performanceSignal: performancePass
        ? null
        : 'W3 PERFORMANCE THRESHOLD FAIL SIGNAL',
    },
    safety: { secretsRedacted: true, destructiveCleanup: false },
  };

  // ---- P12 artifact ------------------------------------------------------
  await writeArtifact(report);

  clients.forEach((c) => c.socket.disconnect());
  teacherSocket.disconnect();
  await pg.end();

  process.stdout.write(
    `W3 n=${participants} correctness=${report.verdict.correctness} performance=${report.verdict.performance} ` +
      `voteYes=${actualYes}/${expectedYes} forbidden=${forbiddenDelivery} closed=${closedActual}/${closedExpected} ` +
      `missClass=${missingClassification.map((m) => m.classification).join(',') || 'none'}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'W3 workload failed.'}\n`,
  );
  process.exitCode = 2;
});

/**
 * Compact completeness view of one trace snapshot. `enabled=false` with a reason
 * is the honest signal that server-side evidence is unavailable for this run —
 * it must never be read as "the server did not emit".
 */
function summarizeTrace(snapshot: TraceSnapshot | undefined) {
  if (!snapshot) {
    return { enabled: false, unavailableReason: 'NOT_FETCHED', records: 0 };
  }
  return {
    enabled: snapshot.enabled,
    ...(snapshot.unavailableReason
      ? { unavailableReason: snapshot.unavailableReason }
      : {}),
    runId: snapshot.runId ?? null,
    fetchedAtMs: snapshot.fetchedAtMs,
    records: snapshot.records.length,
    stats: snapshot.stats ?? null,
    coverageComplete: (snapshot.stats?.droppedCount ?? 0) === 0,
  };
}
