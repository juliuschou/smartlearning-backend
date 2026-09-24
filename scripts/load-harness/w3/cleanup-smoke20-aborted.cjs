/**
 * One-shot exact cleanup for the failed W3-SMOKE-20 fixture run
 * (runId cf2d4038-3da0-430a-9e60-964c00806e86). Deletes ONLY the run-owned
 * chain by literal, pre-verified IDs. No TRUNCATE, no broad DELETE, no reset.
 * The protected orphan session is asserted absent and never referenced.
 */
const { Client } = require('pg');
const { config } = require('dotenv');
const fs = require('fs');
config({ path: '.env.test', override: false });

const FIXTURE = {
  liveSessionId: '01a0bea9-eb78-718c-831a-10a675c58909',
  sessionQuestionId: '01a0bea9-ebbf-778e-8e57-f06cb6f9696e',
  questionId: '01a0bea9-eb51-75f3-96bd-f287f007a901',
  courseId: '01a0bea9-eb3e-7619-829b-19db63a0a801',
  username: 'local-w1-w3-1789905201178-bbc18a90',
  credentialFile: '/tmp/w3-creds/w3-smoke20-cf2d4038-3da0-430a-9e60-964c00806e86.cred',
};
const PROTECTED_SESSION = '01a0bacc-83f9-7417-a52e-481d2fbd3e8c';

async function main() {
  if (FIXTURE.liveSessionId === PROTECTED_SESSION)
    throw new Error('protected fixture refused');
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const counts = {};
  const del = async (label, sql, params) => {
    const r = await c.query(sql, params);
    counts[label] = r.rowCount ?? 0;
  };
  await c.query('BEGIN');
  await del('submissions', `DELETE FROM submission WHERE live_session_id=$1`, [
    FIXTURE.liveSessionId,
  ]);
  await del(
    'live_session_events',
    `DELETE FROM live_session_event WHERE live_session_id=$1`,
    [FIXTURE.liveSessionId],
  );
  await del(
    'live_session_event_sequence',
    `DELETE FROM live_session_event_sequence WHERE live_session_id=$1`,
    [FIXTURE.liveSessionId],
  );
  await del(
    'session_question_options',
    `DELETE FROM session_question_option WHERE session_question_id IN (SELECT id FROM session_question WHERE live_session_id=$1)`,
    [FIXTURE.liveSessionId],
  );
  await del(
    'session_questions',
    `DELETE FROM session_question WHERE live_session_id=$1`,
    [FIXTURE.liveSessionId],
  );
  await del(
    'live_session_question_selections',
    `DELETE FROM live_session_question_selection WHERE live_session_id=$1`,
    [FIXTURE.liveSessionId],
  );
  await del('participants', `DELETE FROM participant WHERE live_session_id=$1`, [
    FIXTURE.liveSessionId,
  ]);
  await del('live_session', `DELETE FROM live_session WHERE id=$1`, [
    FIXTURE.liveSessionId,
  ]);
  await del(
    'question_options',
    `DELETE FROM question_option WHERE question_definition_id=$1`,
    [FIXTURE.questionId],
  );
  await del(
    'question_definition',
    `DELETE FROM question_definition WHERE id=$1 AND course_id=$2`,
    [FIXTURE.questionId, FIXTURE.courseId],
  );
  await del('course', `DELETE FROM course WHERE id=$1`, [FIXTURE.courseId]);
  await del(
    'web_sessions',
    `DELETE FROM web_session WHERE account_id IN (SELECT id FROM account WHERE username=$1)`,
    [FIXTURE.username],
  );
  await del(
    'account',
    `DELETE FROM account WHERE username=$1 AND created_by=$2`,
    [
      FIXTURE.username,
      process.env.LOCAL_W1_PROVISION_CREATED_BY ??
        '01a0bd6f-f4ed-7486-83de-847c336f6d95',
    ],
  );
  await c.query('COMMIT');
  await c.end();
  try {
    fs.unlinkSync(FIXTURE.credentialFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  console.log(JSON.stringify({ cleanup: 'committed', counts }, null, 1));
}
void main().catch((e) => {
  console.error('cleanup failed:', e.message);
  process.exit(2);
});
