const fs = require('node:fs');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { config } = require('dotenv');

config({ path: '.env.test', override: false, quiet: true });

const evidenceDir = __dirname;
const fixturePath = require('node:path').resolve(
  evidenceDir,
  '../w3fresh-20260924T152904Z-dd7baaa/fixture.json',
);
const baselinePath = require('node:path').join(
  evidenceDir,
  'protected-baseline-before.json',
);
const approvedManifestPath = require('node:path').join(
  evidenceDir,
  'cleanup-manifest.json',
);
const mode = process.argv[2] ?? 'manifest';

const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).fixture;
const protectedBaseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const protectedAccountIds = [
  ...protectedBaseline.cp3,
  ...protectedBaseline.historical,
].map((row) => row.id);
const creatorId = protectedBaseline.admins[0]?.id;

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sortedIds(rows, key = 'id') {
  return rows.map((row) => String(row[key])).sort();
}

function setEntry(rows, key = 'id') {
  const ids = sortedIds(rows, key);
  return { count: ids.length, ids, hash: hash(ids) };
}

function stableProtected(value) {
  return {
    cp3: value.cp3,
    historical: value.historical,
    sessions: value.sessions,
  };
}

async function queryProtected(client) {
  const query = async (text, values = []) =>
    (await client.query(text, values)).rows;
  const cp3 = await query(
    `SELECT id,username,role,status,can_create_course,must_change_password,
            password_changed_at,disabled_at,created_at,updated_at,created_by
       FROM account WHERE id = ANY($1::uuid[]) ORDER BY created_at,id`,
    [protectedBaseline.cp3.map((row) => row.id)],
  );
  const historical = await query(
    `SELECT id,username,role,status,can_create_course,must_change_password,
            password_changed_at,disabled_at,created_at,updated_at,created_by
       FROM account WHERE id = ANY($1::uuid[]) ORDER BY created_at,id`,
    [protectedBaseline.historical.map((row) => row.id)],
  );
  const sessions = await query(
    `SELECT id,account_id,created_at,last_seen_at,expires_at,revoked_at,step_up_at
       FROM web_session WHERE account_id = ANY($1::uuid[]) ORDER BY account_id,id`,
    [protectedAccountIds],
  );
  return { cp3, historical, sessions };
}

async function assertAuthority(client) {
  const result = await client.query(
    `SELECT current_database() database_name, current_schema() schema_name`,
  );
  const row = result.rows[0];
  if (row.database_name !== 'smartlearning_test' || row.schema_name !== 'public') {
    throw new Error(`wrong database authority: ${JSON.stringify(row)}`);
  }
  return row;
}

async function discover(client) {
  const query = async (text, values = []) =>
    (await client.query(text, values)).rows;
  const account = await query(
    `SELECT id,username,role,status,created_by FROM account WHERE username=$1`,
    [fixture.username],
  );
  if (
    account.length !== 1 ||
    account[0].role !== 'teacher' ||
    account[0].created_by !== creatorId
  ) {
    throw new Error('fixture account ownership mismatch');
  }
  const accountId = account[0].id;
  if (protectedAccountIds.includes(accountId)) {
    throw new Error('fixture account is protected');
  }

  const cliCredentials = await query(
    `SELECT id,account_id,rotated_from_id FROM cli_credential WHERE account_id=$1 ORDER BY id`,
    [accountId],
  );
  const cliIds = cliCredentials.map((row) => row.id);
  const archivedResults = await query(
    `SELECT id,live_session_id,course_id FROM archived_result
      WHERE live_session_id=$1 OR course_id=$2 ORDER BY id`,
    [fixture.liveSessionId, fixture.courseId],
  );
  const archiveIds = archivedResults.map((row) => row.id);
  const deletionEvents = await query(
    `SELECT id,archived_result_id,live_session_id,course_id,resolved_by_event_id
       FROM deletion_event
      WHERE live_session_id=$1 OR course_id=$2 OR archived_result_id=ANY($3::uuid[])
      ORDER BY id`,
    [fixture.liveSessionId, fixture.courseId, archiveIds],
  );
  const deletionEventIds = deletionEvents.map((row) => row.id);

  const rows = {
    account,
    web_sessions: await query(
      `SELECT id,account_id FROM web_session WHERE account_id=$1 ORDER BY id`,
      [accountId],
    ),
    child_accounts: await query(
      `SELECT id,created_by FROM account WHERE created_by=$1 ORDER BY id`,
      [accountId],
    ),
    courses: await query(
      `SELECT id,owner_account_id FROM course WHERE owner_account_id=$1 ORDER BY id`,
      [accountId],
    ),
    course: await query(
      `SELECT id,owner_account_id FROM course WHERE id=$1 ORDER BY id`,
      [fixture.courseId],
    ),
    course_enrollments: await query(
      `SELECT id,course_id,student_account_id FROM course_enrollment
        WHERE course_id=$1 OR student_account_id=$2 ORDER BY id`,
      [fixture.courseId, accountId],
    ),
    questions_in_course: await query(
      `SELECT id,course_id FROM question_definition WHERE course_id=$1 ORDER BY id`,
      [fixture.courseId],
    ),
    question: await query(
      `SELECT id,course_id FROM question_definition WHERE id=$1 ORDER BY id`,
      [fixture.questionId],
    ),
    question_options: await query(
      `SELECT id,question_definition_id FROM question_option
        WHERE question_definition_id=$1 ORDER BY id`,
      [fixture.questionId],
    ),
    sessions_in_course: await query(
      `SELECT id,course_id FROM live_session WHERE course_id=$1 ORDER BY id`,
      [fixture.courseId],
    ),
    live_session: await query(
      `SELECT id,course_id FROM live_session WHERE id=$1 ORDER BY id`,
      [fixture.liveSessionId],
    ),
    selections: await query(
      `SELECT id,live_session_id,question_definition_id,course_id
         FROM live_session_question_selection WHERE live_session_id=$1 ORDER BY id`,
      [fixture.liveSessionId],
    ),
    session_questions: await query(
      `SELECT id,live_session_id,question_definition_id
         FROM session_question WHERE live_session_id=$1 ORDER BY id`,
      [fixture.liveSessionId],
    ),
    session_question_options: await query(
      `SELECT o.id,o.session_question_id FROM session_question_option o
         JOIN session_question q ON q.id=o.session_question_id
        WHERE q.live_session_id=$1 ORDER BY o.id`,
      [fixture.liveSessionId],
    ),
    participants: await query(
      `SELECT id,live_session_id,account_id FROM participant
        WHERE live_session_id=$1 ORDER BY id`,
      [fixture.liveSessionId],
    ),
    external_account_participants: await query(
      `SELECT id,live_session_id,account_id FROM participant
        WHERE account_id=$1 AND live_session_id<>$2 ORDER BY id`,
      [accountId, fixture.liveSessionId],
    ),
    submissions: await query(
      `SELECT id,live_session_id,participant_id,session_question_id
         FROM submission WHERE live_session_id=$1 ORDER BY id`,
      [fixture.liveSessionId],
    ),
    live_session_events: await query(
      `SELECT id,live_session_id,session_question_id,event_seq
         FROM live_session_event WHERE live_session_id=$1 ORDER BY id`,
      [fixture.liveSessionId],
    ),
    event_sequence: await query(
      `SELECT live_session_id,last_event_seq FROM live_session_event_sequence
        WHERE live_session_id=$1 ORDER BY live_session_id`,
      [fixture.liveSessionId],
    ),
    archived_results: archivedResults,
    deletion_events: deletionEvents,
    deletion_manifest_outbox:
      archiveIds.length || deletionEventIds.length
        ? await query(
            `SELECT id,archived_result_id,deletion_event_id
               FROM deletion_manifest_outbox
              WHERE archived_result_id=ANY($1::uuid[])
                 OR deletion_event_id=ANY($2::uuid[])
              ORDER BY id`,
            [archiveIds, deletionEventIds],
          )
        : [],
    cli_credentials: cliCredentials,
    validation_tokens: await query(
      `SELECT id,account_id,cli_credential_id,course_id
         FROM question_validation_token
        WHERE account_id=$1 OR course_id=$2 OR cli_credential_id=ANY($3::uuid[])
        ORDER BY id`,
      [accountId, fixture.courseId, cliIds],
    ),
    batch_idempotency: await query(
      `SELECT id,actor_scope FROM question_batch_idempotency
        WHERE actor_scope=$1 OR actor_scope=ANY($2::text[]) ORDER BY id`,
      [`web:${accountId}`, cliIds.map((id) => `cli:${id}`)],
    ),
    account_governance_refs: await query(
      `SELECT id,requester_id,executor_id FROM deletion_event
        WHERE requester_id=$1 OR executor_id=$1 ORDER BY id`,
      [accountId],
    ),
  };

  const oneExact = (name, expectedId) => {
    if (rows[name].length !== 1 || rows[name][0].id !== expectedId) {
      throw new Error(`${name} exact identity mismatch`);
    }
  };
  oneExact('course', fixture.courseId);
  oneExact('question', fixture.questionId);
  oneExact('live_session', fixture.liveSessionId);
  if (
    rows.session_questions.length !== 1 ||
    rows.session_questions[0].id !== fixture.sessionQuestionId
  ) {
    throw new Error('session question exact identity mismatch');
  }
  if (
    rows.courses.length !== 1 ||
    rows.questions_in_course.length !== 1 ||
    rows.sessions_in_course.length !== 1
  ) {
    throw new Error('fixture account/course contains extra owned roots');
  }
  for (const blocker of [
    'child_accounts',
    'external_account_participants',
    'archived_results',
    'deletion_events',
    'deletion_manifest_outbox',
    'cli_credentials',
    'validation_tokens',
    'batch_idempotency',
    'account_governance_refs',
    'course_enrollments',
  ]) {
    if (rows[blocker].length !== 0) {
      throw new Error(`cleanup ownership ambiguous: ${blocker} is nonempty`);
    }
  }

  const sets = {};
  for (const [name, value] of Object.entries(rows)) {
    sets[name] = setEntry(
      value,
      name === 'event_sequence' ? 'live_session_id' : 'id',
    );
  }
  return {
    runId: fixture.runId,
    roots: {
      username: fixture.username,
      accountId,
      creatorId,
      courseId: fixture.courseId,
      questionId: fixture.questionId,
      liveSessionId: fixture.liveSessionId,
      sessionQuestionId: fixture.sessionQuestionId,
    },
    rows,
    sets,
  };
}

const deleteSteps = [
  ['submissions', `DELETE FROM submission WHERE live_session_id=$1 RETURNING id`, [() => fixture.liveSessionId]],
  ['live_session_events', `DELETE FROM live_session_event WHERE live_session_id=$1 RETURNING id`, [() => fixture.liveSessionId]],
  ['event_sequence', `DELETE FROM live_session_event_sequence WHERE live_session_id=$1 RETURNING live_session_id`, [() => fixture.liveSessionId], 'live_session_id'],
  ['session_question_options', `DELETE FROM session_question_option WHERE session_question_id IN (SELECT id FROM session_question WHERE live_session_id=$1) RETURNING id`, [() => fixture.liveSessionId]],
  ['session_questions', `DELETE FROM session_question WHERE live_session_id=$1 RETURNING id`, [() => fixture.liveSessionId]],
  ['selections', `DELETE FROM live_session_question_selection WHERE live_session_id=$1 RETURNING id`, [() => fixture.liveSessionId]],
  ['participants', `DELETE FROM participant WHERE live_session_id=$1 RETURNING id`, [() => fixture.liveSessionId]],
  ['live_session', `DELETE FROM live_session WHERE id=$1 AND course_id=$2 RETURNING id`, [() => fixture.liveSessionId, () => fixture.courseId]],
  ['question_options', `DELETE FROM question_option WHERE question_definition_id=$1 RETURNING id`, [() => fixture.questionId]],
  ['question', `DELETE FROM question_definition WHERE id=$1 AND course_id=$2 RETURNING id`, [() => fixture.questionId, () => fixture.courseId]],
  ['course', `DELETE FROM course WHERE id=$1 AND owner_account_id=$2 RETURNING id`, [() => fixture.courseId, (manifest) => manifest.roots.accountId]],
  ['web_sessions', `DELETE FROM web_session WHERE account_id=$1 RETURNING id`, [(manifest) => manifest.roots.accountId]],
  ['account', `DELETE FROM account WHERE id=$1 AND username=$2 AND created_by=$3 RETURNING id`, [(manifest) => manifest.roots.accountId, () => fixture.username, () => creatorId]],
];

async function executeDelete(client, manifest, rollback) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await client.query(`SET LOCAL lock_timeout='5s'`);
    await client.query(`SET LOCAL statement_timeout='60s'`);
    await assertAuthority(client);
    const protectedBefore = await queryProtected(client);
    if (hash(stableProtected(protectedBefore)) !== hash(stableProtected(protectedBaseline))) {
      throw new Error('protected baseline drift before delete');
    }
    const current = await discover(client);
    for (const [name, expected] of Object.entries(manifest.sets)) {
      if (current.sets[name].hash !== expected.hash) {
        throw new Error(`delete set drift: ${name}`);
      }
    }

    const deleted = {};
    for (const [name, sql, valueFactories, key = 'id'] of deleteSteps) {
      const values = valueFactories.map((factory) => factory(manifest));
      const result = await client.query(sql, values);
      deleted[name] = setEntry(result.rows, key);
      const expected = manifest.sets[name];
      if (
        deleted[name].count !== expected.count ||
        deleted[name].hash !== expected.hash
      ) {
        throw new Error(`delete mismatch: ${name}`);
      }
    }

    const after = await discoverAbsence(client, manifest);
    const protectedAfter = await queryProtected(client);
    if (hash(stableProtected(protectedAfter)) !== hash(stableProtected(protectedBaseline))) {
      throw new Error('protected baseline drift after delete');
    }
    if (rollback) await client.query('ROLLBACK');
    else await client.query('COMMIT');
    return {
      transaction: rollback ? 'rolled_back' : 'committed',
      deleted,
      after,
      protectedHash: hash(stableProtected(protectedAfter)),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function discoverAbsence(client, manifest) {
  const checks = {
    account: [`SELECT id FROM account WHERE id=$1`, manifest.roots.accountId],
    course: [`SELECT id FROM course WHERE id=$1`, fixture.courseId],
    question: [`SELECT id FROM question_definition WHERE id=$1`, fixture.questionId],
    live_session: [`SELECT id FROM live_session WHERE id=$1`, fixture.liveSessionId],
    participants: [`SELECT id FROM participant WHERE live_session_id=$1`, fixture.liveSessionId],
    submissions: [`SELECT id FROM submission WHERE live_session_id=$1`, fixture.liveSessionId],
    events: [`SELECT id FROM live_session_event WHERE live_session_id=$1`, fixture.liveSessionId],
    event_sequence: [`SELECT live_session_id FROM live_session_event_sequence WHERE live_session_id=$1`, fixture.liveSessionId],
  };
  const counts = {};
  for (const [name, [sql, value]] of Object.entries(checks)) {
    counts[name] = (await client.query(sql, [value])).rowCount;
  }
  if (Object.values(counts).some((count) => count !== 0)) {
    throw new Error(`post-delete rows remain: ${JSON.stringify(counts)}`);
  }
  return counts;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const authority = await assertAuthority(client);
    if (mode === 'manifest') {
      const manifest = await discover(client);
      const output = {
        authority,
        ...manifest,
        manifestHash: hash(manifest.sets),
        protectedHash: hash(stableProtected(protectedBaseline)),
      };
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return;
    }
    const approved = JSON.parse(fs.readFileSync(approvedManifestPath, 'utf8'));
    if (mode === 'dry-run') {
      const result = await executeDelete(client, approved, true);
      const restored = await discover(client);
      if (hash(restored.sets) !== approved.manifestHash) {
        throw new Error('rollback did not restore approved delete set');
      }
      process.stdout.write(
        `${JSON.stringify({ authority, approvedManifestHash: approved.manifestHash, ...result, rollbackRestored: true }, null, 2)}\n`,
      );
      return;
    }
    if (mode === 'commit') {
      const result = await executeDelete(client, approved, false);
      process.stdout.write(
        `${JSON.stringify({ authority, approvedManifestHash: approved.manifestHash, ...result }, null, 2)}\n`,
      );
      return;
    }
    if (mode === 'verify') {
      const after = await discoverAbsence(client, JSON.parse(fs.readFileSync(approvedManifestPath, 'utf8')));
      const protectedAfter = await queryProtected(client);
      const protectedHash = hash(stableProtected(protectedAfter));
      if (protectedHash !== hash(stableProtected(protectedBaseline))) {
        throw new Error('protected baseline changed');
      }
      process.stdout.write(`${JSON.stringify({ authority, after, protectedHash }, null, 2)}\n`);
      return;
    }
    throw new Error(`unknown mode: ${mode}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(2);
});
