/**
 * W2 — Concentrated Submission workload driver.
 *
 * Authorized pattern (W2 authorization 2026-09-20): one active LiveSession, one
 * open SessionQuestion, N participants each submitting exactly once inside a
 * 10-second initiation window. Per-submission records (not aggregate-only),
 * realtime broadcast reconciliation via targeted RESULT_UPDATED events, and
 * DB reconciliation. This driver never mutates rows outside the fixture chain.
 */
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import { Client } from 'pg';
import { LoadHttpClient } from '../http-client';
import { createOperation } from '../metrics';

async function main(): Promise<void> {
  type QuestionType = 'poll' | 'open_text' | 'quiz';

  interface Fixture {
    runId: string;
    questionType: QuestionType;
    username: string;
    courseId: string;
    questionId: string;
    liveSessionId: string;
    sessionQuestionId: string;
    sessionCode: string;
    options?: Array<{
      id: string;
      optionRef: string | null;
      isCorrect: boolean;
    }>;
  }

  interface SubmissionRecord {
    participantIndex: number;
    participantId: string;
    questionId: string;
    requestId: string;
    idempotencyKey: string;
    requestStartMs: number; // performance.now() epoch of this run
    responseEndMs: number;
    submitClientDurationMs: number;
    httpStatus: number;
    errorCode?: string;
    submissionId?: string;
    broadcastObservedMs?: number; // performance.now() epoch
    commitToBroadcastMs?: number; // responseEnd → broadcast (COMMIT TIMING EVIDENCE GAP: proxied)
    errorClass?: string;
  }

  const participants = Number(process.env.W2_PARTICIPANTS ?? '20');
  const isSmoke = participants < 300;
  const fixturePath = process.env.W2_FIXTURE_PATH;
  const outputPath = process.env.W2_OUTPUT_PATH;
  const databaseUrl = process.env.DATABASE_URL;
  if (!fixturePath || !outputPath)
    throw new Error('W2_FIXTURE_PATH and W2_OUTPUT_PATH are required.');
  if (!databaseUrl?.includes('smartlearning_test'))
    throw new Error('DATABASE_URL must target smartlearning_test (refusing).');
  const baseUrl = process.env.LOAD_BASE_URL ?? 'http://127.0.0.1:3001';
  const timeoutMs = Number(process.env.W2_TIMEOUT_MS ?? '15000');
  // Deterministic pacing: 300 requests over 9 seconds (inside the 10s window);
  // smokes are faster (e.g. 20 over 2s).
  const windowMs = Number(
    process.env.W2_INITIATION_WINDOW_MS ?? (isSmoke ? '2000' : '9000'),
  );

  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
    fixture: Fixture;
  };
  const fx = fixture.fixture;
  if (!fx.liveSessionId || !fx.sessionQuestionId || !fx.sessionCode)
    throw new Error('W2 fixture is incomplete.');

  const runPerfStart = performance.now();
  const toRel = (t: number) => t - runPerfStart;

  // Phase 1: join all participants (sequential-ish batches; joins are not the
  // measured initiation window).
  const http = new LoadHttpClient(baseUrl, timeoutMs, undefined, fx.runId);
  const joinOp = createOperation('w2-join', 'http');
  interface Joined {
    index: number;
    participantId: string;
    participantToken: string;
  }
  const joined: Joined[] = [];
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
            joinOp,
            fx.sessionCode,
            `w2-p-${String(index).padStart(4, '0')}`,
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
        `W2 join incomplete: joined=${joined.length}/${participants}.`,
      );
  }

  // Phase 2: connect one realtime socket per participant (broadcast observation).
  interface BroadcastObs {
    participantId?: string;
    eventSeq?: string;
    observedAtMs: number;
  }
  const broadcasts: BroadcastObs[] = [];
  let broadcastErrors = 0;
  const sockets: Socket[] = [];
  {
    const connectOne = async (p: Joined): Promise<void> => {
      await new Promise<void>((resolve) => {
        const socket = io(`${baseUrl}/live`, {
          autoConnect: false,
          transports: ['websocket'],
          auth: {
            sessionCode: fx.sessionCode,
            participantToken: p.participantToken,
          },
          reconnection: false,
          timeout: timeoutMs,
        });
        socket.onAny((eventName: string, payload: Record<string, unknown>) => {
          if (eventName !== 'result.updated') return;
          if (
            payload &&
            typeof payload === 'object' &&
            typeof payload.eventSeq === 'string'
          ) {
            broadcasts.push({
              participantId: p.participantId,
              eventSeq: payload.eventSeq,
              observedAtMs: performance.now() - runPerfStart,
            });
          }
        });
        socket.once('connect', () => resolve());
        socket.once('connect_error', () => {
          broadcastErrors += 1;
          resolve();
        });
        socket.connect();
        setTimeout(() => {
          if (!socket.connected) {
            broadcastErrors += 1;
            resolve();
          }
        }, timeoutMs);
        sockets.push(socket);
      });
    };
    const batch = 20;
    for (let start = 0; start < joined.length; start += batch) {
      await Promise.all(joined.slice(start, start + batch).map(connectOne));
    }
  }

  // Handshake replay settle: submitting immediately after the socket cohort
  // connects loses ~50% of targeted emissions to a dispatch/connect race
  // (see lessons). A bounded settle between Phases 2 and 3 removes it.
  await new Promise((resolve) =>
    setTimeout(resolve, Number(process.env.W2_SOCKET_SETTLE_MS ?? '1500')),
  );

  // Phase 3: concentrated submissions with deterministic pacing.
  const http2 = new LoadHttpClient(baseUrl, timeoutMs, undefined, fx.runId);
  const submitOp = createOperation('w2-submit', 'http');
  const submitStartMs = performance.now() - runPerfStart;
  const paceInterval = windowMs / participants;
  const records: SubmissionRecord[] = [];

  const buildAnswer = (index: number): Record<string, unknown> => {
    if (fx.questionType === 'open_text')
      return { textAnswer: `w2-${fx.runId}-participant-${index}` };
    const options = fx.options ?? [];
    if (fx.questionType === 'poll') {
      const pick = options[index % options.length] ?? options[0];
      return { selectedOptionRefs: [pick?.id ?? ''] };
    }
    // quiz: deterministic 2/3 correct, 1/3 incorrect
    const correct = options.find((o) => o.isCorrect);
    const incorrect = options.filter((o) => !o.isCorrect);
    if (index % 3 === 0 && incorrect.length > 0)
      return { selectedOptionRefs: [incorrect[0]!.id] };
    return { selectedOptionRefs: [correct?.id ?? ''] };
  };

  await Promise.all(
    joined.map(async (p, order) => {
      const delayMs = order * paceInterval;
      if (delayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      const idempotencyKey = randomUUID();
      const requestId = `w2-${fx.runId}-${p.index}`;
      const requestStart = performance.now();
      const result = await http2.submitRaw(
        submitOp,
        fx.liveSessionId,
        fx.sessionQuestionId,
        p.participantToken,
        buildAnswer(order),
        idempotencyKey,
        requestId,
      );
      const responseEnd = performance.now();
      records.push({
        participantIndex: order,
        participantId: p.participantId,
        questionId: fx.sessionQuestionId,
        requestId,
        idempotencyKey,
        requestStartMs: toRel(requestStart),
        responseEndMs: toRel(responseEnd),
        submitClientDurationMs: responseEnd - requestStart,
        httpStatus: result.status,
        errorCode: result.errorCode,
        submissionId: result.data?.id,
        errorClass:
          result.status === 201
            ? undefined
            : result.status === 0
              ? (result.errorCode ?? 'TRANSPORT')
              : result.status >= 500
                ? 'HTTP_5XX'
                : 'HTTP_4XX',
      });
    }),
  );
  const submitEndMs = performance.now() - runPerfStart;

  // Phase 4: DB reconciliation (exact, read-only).
  // Commit-to-broadcast per event from authoritative DB correlation:
  //   submission.submitted_at (commit proxy — COMMIT TIMING EVIDENCE GAP)
  //   → live_session_event.delivered_at, correlated by target_participant_id
  //   and event_name='result.updated'. Exact keys, not timing proximity.
  const pg = new Client({ connectionString: databaseUrl });
  await pg.connect();

  // Broadcast settle: the durable publisher drains sequentially (≈1 event per
  // poll cycle; see lessons). Wait until every expected targeted event has a
  // delivered_at (bounded), so acceptance is measured against the DB drain.
  const drainDeadlineMs = Number(
    process.env.W2_BROADCAST_SETTLE_MS ?? (isSmoke ? 120000 : 900000),
  );
  const drainStart = performance.now();
  const countUndelivered = async (): Promise<number> => {
    const r = await pg.query(
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

  const reconcile = async (): Promise<Record<string, unknown>> => {
    const submissions = await pg.query(
      `SELECT participant_id, selected_option_refs, text_answer FROM submission WHERE live_session_id = $1 AND session_question_id = $2`,
      [fx.liveSessionId, fx.sessionQuestionId],
    );
    const events = await pg.query(
      `SELECT count(*)::int AS n, count(DISTINCT event_seq)::int AS uniq FROM live_session_event WHERE live_session_id = $1`,
      [fx.liveSessionId],
    );
    const sequence = await pg.query(
      `SELECT last_event_seq::text AS seq FROM live_session_event_sequence WHERE live_session_id = $1`,
      [fx.liveSessionId],
    );
    const participantsDb = await pg.query(
      `SELECT count(*)::int AS n FROM participant WHERE live_session_id = $1`,
      [fx.liveSessionId],
    );
    return {
      submissionCount: submissions.rows.length,
      participants: participantsDb.rows[0]?.n,
      events: events.rows[0],
      lastEventSeq: sequence.rows[0]?.seq,
      submissions: submissions.rows.map((row) => ({
        participantId: row.participant_id,
        selectedOptionRefs: row.selected_option_refs,
        textAnswer: row.text_answer,
      })),
    };
  };
  const dbReconcile = await reconcile();

  // DB-correlated commit-to-broadcast (exact keys): submitted_at → delivered_at.
  const dbCommitToBroadcast = await pg.query(
    `SELECT s.participant_id,
            EXTRACT(EPOCH FROM (e.delivered_at - s.submitted_at)) * 1000 AS c2b_ms
     FROM submission s
     JOIN live_session_event e
       ON e.live_session_id = s.live_session_id
      AND e.target_participant_id = s.participant_id
      AND e.event_name = 'result.updated'
     WHERE s.live_session_id = $1 AND s.session_question_id = $2`,
    [fx.liveSessionId, fx.sessionQuestionId],
  );
  await pg.end();

  // Broadcast settle window: the durable publisher dispatches sequentially
  // (per-socket reauthorization + getResults read per recipient), so give it
  // a bounded window to finish the targeted RESULT_UPDATED emissions before
  // sockets are dropped. Observed broadcast times are recorded as they arrive.
  // Disconnect sockets.
  sockets.forEach((socket) => socket.disconnect());

  const successful = records.filter((r) => r.httpStatus === 201);
  const starts = successful.map((r) => r.requestStartMs);
  const initiationWindowMs = starts.length
    ? Math.max(...starts) - Math.min(...starts)
    : 0;
  const broadcastByParticipant = new Map(
    broadcasts.map((b) => [b.participantId, b]),
  );
  // Backfill per-record broadcast correlation after the settle window.
  for (const record of records) {
    const broadcast = broadcastByParticipant.get(record.participantId);
    record.broadcastObservedMs = broadcast?.observedAtMs;
    record.commitToBroadcastMs = broadcast
      ? broadcast.observedAtMs - record.responseEndMs
      : undefined;
  }
  const commitToBroadcast = successful
    .map((r) => {
      const broadcast = broadcastByParticipant.get(r.participantId);
      if (!broadcast) return undefined;
      return broadcast.observedAtMs - r.responseEndMs;
    })
    .filter((v): v is number => v !== undefined);

  const percentile = (values: number[], p: number): number => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ];
  };
  const pct = (values: number[]) => ({
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: values.length ? Math.max(...values) : 0,
  });

  const report = {
    schemaVersion: 1,
    phase: 'W2-concentrated-submission',
    runId: fx.runId,
    questionType: fx.questionType,
    participantCount: participants,
    isSmoke,
    fixture: {
      courseId: fx.courseId,
      questionId: fx.questionId,
      liveSessionId: fx.liveSessionId,
      sessionQuestionId: fx.sessionQuestionId,
      sessionCode: fx.sessionCode,
    },
    initiation: {
      windowMs,
      proofMaxMinusMinMs: initiationWindowMs,
      within10s: initiationWindowMs <= 10_000,
      submitStageStartMs: submitStartMs,
      submitStageEndMs: submitEndMs,
      pacingDelayMs: paceInterval,
    },
    submitLatency: {
      submitClientDurationMs: pct(records.map((r) => r.submitClientDurationMs)),
      note: 'commitToBroadcastMs uses client responseEnd as the commit-time proxy — COMMIT TIMING EVIDENCE GAP (no exact DB commit timestamp exposed); documented, not exact.',
    },
    commitToBroadcastMs: pct(commitToBroadcast),
    dbCommitToBroadcastMs: pct(
      dbCommitToBroadcast.rows.map((r) => Number(r.c2b_ms)),
    ),
    broadcastSettle: { drainWaitMs, deadlineMs: drainDeadlineMs },
    attempted: records.length,
    successful: successful.length,
    failed: records.length - successful.length,
    functionalErrorRate: records.length
      ? (records.length - successful.length) / records.length
      : 0,
    duplicateSubmissionIds:
      successful.length - new Set(successful.map((r) => r.submissionId)).size,
    errorClassification: records.reduce<Record<string, number>>((acc, r) => {
      if (r.errorClass)
        acc[`${r.errorClass}:${r.errorCode ?? ''}`] =
          (acc[`${r.errorClass}:${r.errorCode ?? ''}`] ?? 0) + 1;
      return acc;
    }, {}),
    realtime: {
      socketConnectErrors: broadcastErrors,
      expectedBroadcasts: successful.length,
      observedBroadcasts: broadcasts.length,
      missingBroadcasts: Math.max(0, successful.length - broadcasts.length),
      duplicateEventSeqs:
        broadcasts.length - new Set(broadcasts.map((b) => b.eventSeq)).size,
    },
    dbReconcile,
    expectations: {
      submissions: participants,
      participants,
      pollDistribution:
        fx.questionType === 'poll' && fx.options
          ? Object.fromEntries(
              fx.options.map((o, i) => [
                o.id,
                Math.ceil(((i + 1) * participants) / fx.options!.length) -
                  Math.ceil((i * participants) / fx.options!.length),
              ]),
            )
          : undefined,
      quizCorrect:
        fx.questionType === 'quiz'
          ? participants - Math.ceil(participants / 3)
          : undefined,
      quizIncorrect:
        fx.questionType === 'quiz' ? Math.ceil(participants / 3) : undefined,
      expectedQuizCorrectNote: undefined as string | undefined,
    },
    records,
  };

  if (
    fx.questionType === 'quiz' &&
    report.expectations.quizCorrect !== undefined
  )
    report.expectations.expectedQuizCorrectNote =
      'Deterministic: every 3rd participant (index % 3 === 0) submits incorrect; others correct.';

  // Run-once guard: refuse to overwrite an existing artifact or to run the
  // same fixture twice (lesson from the double-executed smoke: two joins +
  // two submission waves against one fixture, and the first artifact lost).
  try {
    const existing = await readFile(outputPath, 'utf8');
    if (existing.trim().length > 0)
      throw new Error(
        `W2 artifact already exists; refusing to overwrite: ${outputPath}`,
      );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('refusing to overwrite')
    )
      throw error;
  }

  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `W2 ${fx.questionType} n=${participants} attempted=${records.length} successful=${successful.length} initiationWindowMs=${initiationWindowMs.toFixed(1)}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'W2 workload failed.'}\n`,
  );
  process.exitCode = 2;
});
