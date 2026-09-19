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
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  backend_type: string | null;
  query_start: Date | null;
  state_change: Date | null;
};

type LockRow = QueryResultRow & {
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
  }> = [];
  let sampling: Promise<void> | undefined;
  const sample = async (): Promise<void> => {
    if (sampling) return sampling;
    sampling = (async () => {
      const activity = await query<ActivityRow>(
        `SELECT pid, state, wait_event_type, wait_event, backend_type, query_start, state_change
         FROM pg_stat_activity WHERE datname = current_database() ORDER BY pid`,
      );
      const locks = await query<LockRow>(
        `SELECT locktype, mode, granted, relation::regclass::text AS relation,
                CASE WHEN locktype IN ('advisory', 'object', 'userlock') THEN objid::text ELSE NULL END AS object
         FROM pg_locks WHERE pid <> pg_backend_pid()
         ORDER BY locktype, mode, granted DESC, relation, object`,
      );
      const modes: Record<string, number> = {};
      const objects: Record<string, number> = {};
      let granted = 0;
      let waiting = 0;
      for (const row of locks.rows) {
        modes[row.mode] = (modes[row.mode] ?? 0) + 1;
        const classification = row.relation
          ? 'relation'
          : row.object
            ? 'object'
            : row.locktype;
        objects[classification] = (objects[classification] ?? 0) + 1;
        if (row.granted) granted += 1;
        else waiting += 1;
      }
      samples.push({
        capturedAt: new Date().toISOString(),
        activeCount: activity.rows.filter((row) => row.state === 'active')
          .length,
        activity: activity.rows,
        locks: { total: granted + waiting, granted, waiting, modes, objects },
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
  const expectedParticipants =
    fixture.expectedParticipants ?? fixture.participantCount ?? null;
  const intervalMs = Math.max(
    500,
    Number(process.env.W1_PG_OBSERVER_INTERVAL_MS ?? 1000),
  );
  const timer = setInterval(
    () => void sample().catch(() => undefined),
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
        schemaVersion: 2,
        enabled: true,
        target: 'smartlearning_test',
        samples,
        reconciliation: {
          liveSessionId: fixture.liveSessionId,
          sessionQuestionId: fixture.sessionQuestionId,
          before: { participants: participantBefore, events: eventBefore },
          after: { participants: participantAfter, events: eventAfter },
          delta: {
            participants: participantAfter - participantBefore,
            events: eventAfter - eventBefore,
          },
          expected: { participants: expectedParticipants },
          persisted: { participants: participantAfter - participantBefore },
          exactMatch:
            expectedParticipants === null
              ? null
              : participantAfter - participantBefore === expectedParticipants,
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
              schemaVersion: 2,
              enabled: true,
              target: 'smartlearning_test',
              samples,
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
