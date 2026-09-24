/**
 * W3-DIAG-20 cleanup MANIFEST discovery — READ-ONLY.
 *
 * Resolves the exact run-owned identifier chain for the current W3-DIAG run from
 * its own fixture artifact only. No LIKE / wildcard / prefix matching is used to
 * *select* rows for deletion; the single username-keyed lookup below is an
 * equality lookup on the exact username recorded in this run's fixture, and it
 * exists solely to obtain the exact account id (which the fixture does not
 * record). Every dependent row is resolved by exact parent id / exact FK.
 *
 * Prints a manifest of literal exact IDs. Deletes nothing.
 */
const { Client } = require('pg');
const { config } = require('dotenv');
const fs = require('fs');
config({ path: '.env.test', override: false });

const PROTECTED_SESSION = '01a0bacc-83f9-7417-a52e-481d2fbd3e8c'; // cleanup DENIED

async function main() {
  const argPath = process.argv[2] ?? 'artifacts/w3-diag/fixture.json';
  const fixture = JSON.parse(fs.readFileSync(argPath, 'utf8')).fixture;
  if (!fixture) throw new Error('fixture payload missing');
  if (!/^[0-9a-f-]{36}$/.test(fixture.liveSessionId))
    throw new Error('fixture liveSessionId malformed');
  if (fixture.liveSessionId === PROTECTED_SESSION)
    throw new Error('protected fixture refused');

  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const one = async (sql, params) => (await c.query(sql, params)).rows;
  const n = async (sql, params) =>
    Number((await c.query(sql, params)).rows[0].n);

  const manifest = { runId: fixture.runId, fixture, ownership: {} };

  // --- exact username -> exact account id (equality, not prefix) ---
  const accounts = await one(
    `SELECT id, username, role, status, created_by FROM account WHERE username=$1`,
    [fixture.username],
  );
  manifest.ownership.accounts = accounts;

  const accountIds = accounts.map((a) => a.id);
  manifest.ownership.web_sessions = accountIds.length
    ? await one(
        `SELECT id, account_id, revoked_at FROM web_session WHERE account_id = ANY($1::uuid[])`,
        [accountIds],
      )
    : [];

  // --- chain rooted at the run's exact ids ---
  const ls = fixture.liveSessionId;
  const qid = fixture.questionId;
  const cid = fixture.courseId;

  manifest.ownership.course = await one(
    `SELECT id, owner_account_id FROM course WHERE id=$1`,
    [cid],
  );
  manifest.ownership.question = await one(
    `SELECT id, course_id FROM question_definition WHERE id=$1`,
    [qid],
  );
  manifest.ownership.question_options = await one(
    `SELECT id FROM question_option WHERE question_definition_id=$1`,
    [qid],
  );
  manifest.ownership.live_session = await one(
    `SELECT id, course_id, status FROM live_session WHERE id=$1`,
    [ls],
  );
  manifest.ownership.session_questions = await one(
    `SELECT id, question_definition_id FROM session_question WHERE live_session_id=$1`,
    [ls],
  );
  manifest.ownership.session_question_options = await one(
    `SELECT o.id FROM session_question_option o
       JOIN session_question q ON q.id=o.session_question_id
      WHERE q.live_session_id=$1`,
    [ls],
  );
  manifest.ownership.selections = await one(
    `SELECT id FROM live_session_question_selection WHERE live_session_id=$1`,
    [ls],
  );
  manifest.ownership.participants = await one(
    `SELECT id, account_id FROM participant WHERE live_session_id=$1`,
    [ls],
  );
  manifest.ownership.submissions = await one(
    `SELECT id FROM submission WHERE live_session_id=$1`,
    [ls],
  );
  manifest.ownership.events = await n(
    `SELECT count(*)::int n FROM live_session_event WHERE live_session_id=$1`,
    [ls],
  );
  manifest.ownership.event_sequence = await one(
    `SELECT live_session_id, last_event_seq FROM live_session_event_sequence WHERE live_session_id=$1`,
    [ls],
  );

  // --- cross-ownership guard: does this run's account own anything OUTSIDE the chain? ---
  if (accountIds.length) {
    manifest.ownership.cross_check = {
      courses_owned: await one(
        `SELECT id FROM course WHERE owner_account_id = ANY($1::uuid[])`,
        [accountIds],
      ),
      sessions_in_those_courses: await one(
        `SELECT ls.id FROM live_session ls JOIN course c ON c.id=ls.course_id
          WHERE c.owner_account_id = ANY($1::uuid[])`,
        [accountIds],
      ),
      live_sessions_owner_account: await one(
        `SELECT id FROM live_session WHERE id <> $1 AND course_id = ANY(
           SELECT id FROM course WHERE owner_account_id = ANY($2::uuid[]))`,
        [ls, accountIds],
      ),
    };
  }

  // --- global baselines (must stay unchanged except for this run's chain) ---
  manifest.baseline_now = {
    account_total: await n(`SELECT count(*)::int n FROM account`),
    account_local_w1_w3_exact_eq: await n(
      `SELECT count(*)::int n FROM account WHERE username=$1`,
      [fixture.username],
    ),
    web_session_total: await n(`SELECT count(*)::int n FROM web_session`),
    course_total: await n(`SELECT count(*)::int n FROM course`),
    question_total: await n(`SELECT count(*)::int n FROM question_definition`),
    live_session_total: await n(`SELECT count(*)::int n FROM live_session`),
    submission_total: await n(`SELECT count(*)::int n FROM submission`),
    participant_total: await n(`SELECT count(*)::int n FROM participant`),
    event_total: await n(`SELECT count(*)::int n FROM live_session_event`),
    sequence_total: await n(`SELECT count(*)::int n FROM live_session_event_sequence`),
  };

  await c.end();
  console.log(JSON.stringify(manifest, null, 1));
}

void main().catch((e) => {
  console.error('discovery failed:', e.message);
  process.exit(2);
});
