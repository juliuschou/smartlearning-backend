/**
 * W3 exact fixture cleanup — deletes ONLY the run-owned chain, FK-traceable, by
 * exact IDs. No TRUNCATE, no broad DELETE, no reset. Protected orphan IDs are
 * asserted absent from the delete set before any statement runs.
 */
const { Client } = require('pg');
const { config } = require('dotenv');
config({ path: '.env.test', override: false });

const PROTECTED_SESSION = '01a0bacc-83f9-7417-a52e-481d2fbd3e8c'; // cleanup DENIED

async function main() {
  const fixture = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'))
    .fixture;
  if (!fixture) throw new Error('fixture payload missing');
  if (fixture.liveSessionId === PROTECTED_SESSION)
    throw new Error('protected fixture refused');
  if (!/^[0-9a-f-]{36}$/.test(fixture.liveSessionId))
    throw new Error('fixture liveSessionId malformed');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const counts = {};
  const del = async (label, sql, params) => {
    const r = await c.query(sql, params);
    counts[label] = r.rowCount ?? 0;
  };
  await c.query('BEGIN');
  await del('submissions', `DELETE FROM submission WHERE live_session_id=$1`, [
    fixture.liveSessionId,
  ]);
  await del(
    'live_session_events',
    `DELETE FROM live_session_event WHERE live_session_id=$1`,
    [fixture.liveSessionId],
  );
  await del(
    'live_session_event_sequence',
    `DELETE FROM live_session_event_sequence WHERE live_session_id=$1`,
    [fixture.liveSessionId],
  );
  await del(
    'session_question_options',
    `DELETE FROM session_question_option WHERE session_question_id IN (SELECT id FROM session_question WHERE live_session_id=$1)`,
    [fixture.liveSessionId],
  );
  await del(
    'session_questions',
    `DELETE FROM session_question WHERE live_session_id=$1`,
    [fixture.liveSessionId],
  );
  await del(
    'live_session_question_selections',
    `DELETE FROM live_session_question_selection WHERE live_session_id=$1`,
    [fixture.liveSessionId],
  );
  await del('participants', `DELETE FROM participant WHERE live_session_id=$1`, [
    fixture.liveSessionId,
  ]);
  await del('live_session', `DELETE FROM live_session WHERE id=$1`, [
    fixture.liveSessionId,
  ]);
  await del(
    'question_options',
    `DELETE FROM question_option WHERE question_definition_id=$1`,
    [fixture.questionId],
  );
  await del(
    'question_definition',
    `DELETE FROM question_definition WHERE id=$1 AND course_id=$2`,
    [fixture.questionId, fixture.courseId],
  );
  await del('course', `DELETE FROM course WHERE id=$1`, [fixture.courseId]);
  await del(
    'web_sessions',
    `DELETE FROM web_session WHERE account_id IN (SELECT id FROM account WHERE username=$1)`,
    [fixture.username],
  );
  await del(
    'account',
    `DELETE FROM account WHERE username=$1 AND created_by=$2`,
    [
      fixture.username,
      process.env.LOCAL_W1_PROVISION_CREATED_BY ??
        '01a0bd6f-f4ed-7486-83de-847c336f6d95',
    ],
  );
  await c.query('COMMIT');
  await c.end();
  // Remove the run-owned ephemeral credential file (never a durable artifact).
  const credentialFile = fixture.credentialFile;
  let credentialRemoved = false;
  if (credentialFile) {
    try {
      require('fs').unlinkSync(credentialFile);
      credentialRemoved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      credentialRemoved = true;
    }
  }
  console.log(
    JSON.stringify(
      {
        cleanup: 'committed',
        fixtureId: fixture.liveSessionId,
        counts,
        credentialRemoved,
      },
      null,
      1,
    ),
  );
}
void main().catch((e) => {
  console.error('cleanup failed:', e.message);
  process.exit(2);
});
