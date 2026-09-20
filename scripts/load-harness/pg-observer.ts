import { readFile, writeFile } from 'node:fs/promises';
import { Client, type QueryResultRow } from 'pg';
import { config as loadDotenv } from 'dotenv';

type Fixture = {
  liveSessionId: string;
  sessionQuestionId: string;
  sessionCode?: string;
  expectedParticipants?: number;
  participantCount?: number;
};

type ActivityRow = QueryResultRow & {
  pid: number;
  application_name: string | null;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  backend_type: string | null;
  xact_start: Date | null;
  query_start: Date | null;
  state_change: Date | null;
  transaction_age_ms: number | null;
  query_age_ms: number | null;
  blocking_pids: number[];
};

type LockRow = QueryResultRow & {
  pid: number;
  locktype: string;
  mode: string;
  granted: boolean;
  relation: string | null;
  object: string | null;
};

async function main(): Promise<void> {
  loadDotenv({ path: '.env.test', override: false });
  if (process.env.W1_DIAGNOSTICS !== '1')
    throw new Error('PostgreSQL observer requires W1_DIAGNOSTICS=1.');
  const databaseUrl = process.env.DATABASE_URL;
  const fixturePath = process.env.W1_PG_OBSERVER_FIXTURE;
  const outputPath = process.env.W1_PG_OBSERVER_OUTPUT;
  if (!databaseUrl?.includes('smartlearning_test'))
    throw new Error(
      'PostgreSQL observer requires DATABASE_URL targeting smartlearning_test.',
    );
  if (!fixturePath || !outputPath)
    throw new Error(
      'W1_PG_OBSERVER_FIXTURE and W1_PG_OBSERVER_OUTPUT are required.',
    );
  const parsed = JSON.parse(await readFile(fixturePath, 'utf8')) as {
    fixture?: Fixture;
  };
  const fixture = parsed.fixture;
  if (!fixture?.liveSessionId || !fixture.sessionQuestionId)
    throw new Error('Observer fixture is incomplete.');

  const client = new Client({
    connectionString: databaseUrl,
    application_name: 'smartlearning-w1-observer',
  });
  await client.connect();
  let queryTail = Promise.resolve();
  const query = <T extends QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => {
    const result = queryTail.then(() => client.query<T>(text, values));
    queryTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const samples: Array<{
    capturedAt: string;
    activeCount: number;
    activity: ActivityRow[];
    locks: {
      total: number;
      granted: number;
      waiting: number;
      modes: Record<string, number>;
      objects: Record<string, number>;
    };
    blockingEdges: Array<{
      blockedPid: number;
      blockingPid: number;
      waitEventType: string | null;
      waitEvent: string | null;
    }>;
  }> = [];
  const observerErrors: string[] = [];
  const connectionObservations: Array<{
    capturedAt: string;
    total: number;
    active: number;
    idle: number;
    waiting: number;
  }> = [];
  let sampling: Promise<void> | undefined;
  const samplingStartedAt = new Date().toISOString();
  const sample = async (): Promise<void> => {
    if (sampling) return sampling;
    sampling = (async () => {
      const activity = await query<ActivityRow>(
        `SELECT pid, application_name, state, wait_event_type, wait_event,
                backend_type, xact_start, query_start, state_change,
                CASE WHEN xact_start IS NULL THEN NULL
                     ELSE EXTRACT(EPOCH FROM (clock_timestamp() - xact_start)) * 1000 END AS transaction_age_ms,
                CASE WHEN query_start IS NULL THEN NULL
                     ELSE EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000 END AS query_age_ms,
                COALESCE(pg_blocking_pids(pid), ARRAY[]::integer[]) AS blocking_pids
         FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
         ORDER BY pid`,
      );
      const locks = await query<LockRow>(
        `SELECT pid, locktype, mode, granted, relation::regclass::text AS relation,
                CASE WHEN locktype IN ('advisory', 'object', 'userlock') THEN objid::text ELSE NULL END AS object
         FROM pg_locks WHERE pid <> pg_backend_pid()
         ORDER BY pid, locktype, mode, granted DESC, relation, object`,
      );
      const modes: Record<string, number> = {};
      const objects: Record<string, number> = {};
      let granted = 0;
      let waiting = 0;
      for (const row of locks.rows) {
        modes[row.mode] = (modes[row.mode] ?? 0) + 1;
        const classification = row.relation
          ? `relation:${row.relation}`
          : row.object
            ? 'object'
            : row.locktype;
        objects[classification] = (objects[classification] ?? 0) + 1;
        if (row.granted) granted += 1;
        else waiting += 1;
      }
      const capturedAt = new Date().toISOString();
      const active = activity.rows.filter(
        (row) => row.state === 'active',
      ).length;
      const idle = activity.rows.filter((row) => row.state === 'idle').length;
      const blockingEdges = activity.rows.flatMap((row) =>
        row.blocking_pids.map((blockingPid) => ({
          blockedPid: row.pid,
          blockingPid,
          waitEventType: row.wait_event_type,
          waitEvent: row.wait_event,
        })),
      );
      connectionObservations.push({
        capturedAt,
        total: activity.rows.length,
        active,
        idle,
        waiting: activity.rows.filter((row) => row.wait_event !== null).length,
      });
      samples.push({
        capturedAt,
        activeCount: active,
        activity: activity.rows,
        locks: { total: granted + waiting, granted, waiting, modes, objects },
        blockingEdges,
      });
    })();
    try {
      await sampling;
    } finally {
      sampling = undefined;
    }
  };
  const count = async (
    table: string,
    column: string,
    value: string,
  ): Promise<number> => {
    const result = await query<{ count: string }>(
      `SELECT count(*)::int AS count FROM ${table} WHERE ${column} = $1`,
      [value],
    );
    return Number(result.rows[0]?.count ?? 0);
  };
  const eventSequence = async (): Promise<bigint> => {
    const result = await query<{ last_event_seq: string }>(
      `SELECT last_event_seq::text AS last_event_seq
       FROM live_session_event_sequence
       WHERE live_session_id = $1`,
      [fixture.liveSessionId],
    );
    if (result.rows.length !== 1)
      throw new Error('Fixture event sequence row is missing.');
    return BigInt(result.rows[0].last_event_seq);
  };
  const participantBefore = await count(
    'participant',
    'live_session_id',
    fixture.liveSessionId,
  );
  const eventBefore = await count(
    'live_session_event',
    'live_session_id',
    fixture.liveSessionId,
  );
  const sequenceBefore = await eventSequence();
  const expectedParticipants =
    fixture.expectedParticipants ?? fixture.participantCount ?? null;
  const requestedIntervalMs = Number(
    process.env.W1_PG_OBSERVER_INTERVAL_MS ?? 250,
  );
  if (!Number.isFinite(requestedIntervalMs) || requestedIntervalMs < 100)
    throw new Error('W1_PG_OBSERVER_INTERVAL_MS must be at least 100ms.');
  const intervalMs = requestedIntervalMs;
  const timer = setInterval(
    () =>
      void sample().catch((error: unknown) => {
        observerErrors.push(
          error instanceof Error ? error.message : 'sampling failed',
        );
      }),
    intervalMs,
  );
  let finishPromise: Promise<void> | undefined;
  const finish = (): Promise<void> => {
    finishPromise ??= (async () => {
      clearInterval(timer);
      await sampling?.catch(() => undefined);
      await queryTail;
      await sample().catch(() => undefined);
      const participantAfter = await count(
        'participant',
        'live_session_id',
        fixture.liveSessionId,
      );
      const eventAfter = await count(
        'live_session_event',
        'live_session_id',
        fixture.liveSessionId,
      );
      const sequenceAfter = await eventSequence();
      const participantDelta = participantAfter - participantBefore;
      const eventDelta = eventAfter - eventBefore;
      const sequenceDelta = sequenceAfter - sequenceBefore;
      const plans = {
        findByCode: {
          label: 'representative find-by-code query',
          plan:
            (
              await query(
                `EXPLAIN (FORMAT JSON) SELECT ls.id, ls.status, ls.session_code, sq.id AS session_question_id, sq.position, sq.status AS question_status, sq.snapshot_type, sq.snapshot_prompt FROM live_session ls LEFT JOIN session_question sq ON sq.live_session_id = ls.id WHERE ls.session_code = $1 ORDER BY sq.position, sq.id`,
                [fixture.sessionCode ?? ''],
              )
            ).rows[0]?.['QUERY PLAN'] ?? null,
        },
        getSnapshot: {
          label: 'representative get-snapshot query',
          plan:
            (
              await query(
                `EXPLAIN (FORMAT JSON) SELECT ls.id, ls.status, ls.session_code, sq.id AS session_question_id, sq.position, sq.status AS question_status, sq.snapshot_type, sq.snapshot_prompt FROM live_session ls LEFT JOIN session_question sq ON sq.live_session_id = ls.id WHERE ls.id = $1 ORDER BY sq.position, sq.id`,
                [fixture.liveSessionId],
              )
            ).rows[0]?.['QUERY PLAN'] ?? null,
        },
      };
      const report = {
        schemaVersion: 4,
        enabled: true,
        target: 'smartlearning_test',
        sampling: {
          startedAt: samplingStartedAt,
          finishedAt: new Date().toISOString(),
          intervalMs,
        },
        samples,
        connectionObservations,
        observerErrors,
        reconciliation: {
          liveSessionId: fixture.liveSessionId,
          sessionQuestionId: fixture.sessionQuestionId,
          before: {
            participants: participantBefore,
            events: eventBefore,
            eventSequence: sequenceBefore.toString(),
          },
          after: {
            participants: participantAfter,
            events: eventAfter,
            eventSequence: sequenceAfter.toString(),
          },
          delta: {
            participants: participantDelta,
            events: eventDelta,
            eventSequence: sequenceDelta.toString(),
          },
          expected: {
            participants: expectedParticipants,
            events: expectedParticipants,
            eventSequence: expectedParticipants,
          },
          persisted: {
            participants: participantDelta,
            events: eventDelta,
            eventSequence: sequenceDelta.toString(),
          },
          exactMatch:
            expectedParticipants === null
              ? null
              : participantDelta === expectedParticipants &&
                eventDelta === expectedParticipants &&
                sequenceDelta === BigInt(expectedParticipants),
        },
        plans,
        safety: {
          readOnly: true,
          writes: false,
          schemaChanges: false,
          indexChanges: false,
          poolChanges: false,
          lockChanges: false,
        },
      };
      await writeFile(
        outputPath,
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8',
      );
      await client.end();
    })();
    return finishPromise;
  };
  const shutdown = () =>
    void finish()
      .catch(async (error: unknown) => {
        await writeFile(
          outputPath,
          `${JSON.stringify(
            {
              schemaVersion: 4,
              enabled: true,
              target: 'smartlearning_test',
              sampling: {
                startedAt: samplingStartedAt,
                finishedAt: new Date().toISOString(),
                intervalMs,
              },
              samples,
              connectionObservations,
              observerErrors: [
                ...observerErrors,
                error instanceof Error
                  ? error.message
                  : 'observer query failed',
              ],
              reconciliation: {
                liveSessionId: fixture.liveSessionId,
                sessionQuestionId: fixture.sessionQuestionId,
                expected: { participants: expectedParticipants },
                persisted: null,
                exactMatch: false,
                error:
                  error instanceof Error
                    ? error.message
                    : 'observer query failed',
              },
              plans: { findByCode: null, getSnapshot: null },
              safety: {
                readOnly: true,
                writes: false,
                schemaChanges: false,
                indexChanges: false,
                poolChanges: false,
                lockChanges: false,
              },
            },
            null,
            2,
          )}\n`,
          'utf8',
        );
      })
      .finally(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await sample();
  await new Promise<void>(() => undefined);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Observer failed.'}\n`,
  );
  process.exitCode = 2;
});
