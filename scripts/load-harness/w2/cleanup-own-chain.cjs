/**
 * W2 ownership-swept exact cleanup: for each remaining run teacher account
 * (username LIKE 'local-w1-w2-%', created by the W2 creator admin), delete
 * its course/question/session/participant/submission/event chain by exact IDs.
 * Refuses protected IDs. No TRUNCATE, no broad DELETE.
 */
const { Client } = require('pg');
const { config } = require('dotenv');
config({ path: '.env.test', override: false });
const PROTECTED = '01a0bacc-83f9-7417-a52e-481d2fbd3e8c';

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const accounts = (await c.query(
    `SELECT id, username FROM account WHERE username LIKE 'local-w1-w2-%'`,
  )).rows;
  const report = [];
  for (const account of accounts) {
    const courses = (await c.query(
      `SELECT id FROM course WHERE owner_account_id=$1`, [account.id],
    )).rows;
    for (const course of courses) {
      const sessions = (await c.query(
        `SELECT id FROM live_session WHERE course_id=$1`, [course.id],
      )).rows;
      for (const session of sessions) {
        if (session.id === PROTECTED)
          throw new Error('protected session refused');
        await c.query('BEGIN');
        const del = async (label, sql) => {
          const r = await c.query(sql, [session.id]);
          report.push(`${label}:${session.id}=${r.rowCount}`);
        };
        await del('submissions', `DELETE FROM submission WHERE live_session_id=$1`);
        await del('events', `DELETE FROM live_session_event WHERE live_session_id=$1`);
        await del('seq', `DELETE FROM live_session_event_sequence WHERE live_session_id=$1`);
        await del('sq_opts', `DELETE FROM session_question_option WHERE session_question_id IN (SELECT id FROM session_question WHERE live_session_id=$1)`);
        await del('sq', `DELETE FROM session_question WHERE live_session_id=$1`);
        await del('sel', `DELETE FROM live_session_question_selection WHERE live_session_id=$1`);
        await del('participants', `DELETE FROM participant WHERE live_session_id=$1`);
        await del('session', `DELETE FROM live_session WHERE id=$1`);
        const questions = (await c.query(
          `SELECT id FROM question_definition WHERE course_id=$1`, [course.id],
        )).rows;
        for (const q of questions) {
          await c.query(`DELETE FROM question_option WHERE question_definition_id=$1`, [q.id]);
          await c.query(`DELETE FROM question_definition WHERE id=$1 AND course_id=$2`, [q.id, course.id]);
          report.push(`question:${q.id}=1`);
        }
        await c.query(`DELETE FROM course WHERE id=$1`, [course.id]);
        report.push(`course:${course.id}=1`);
        await c.query('COMMIT');
      }
    }
    await c.query(`DELETE FROM web_session WHERE account_id=$1`, [account.id]);
    const delAcct = await c.query(
      `DELETE FROM account WHERE id=$1 AND username LIKE 'local-w1-w2-%'`, [account.id],
    );
    report.push(`account:${account.username}=${delAcct.rowCount}`);
  }
  await c.end();
  console.log(JSON.stringify(report, null, 1));
})().catch((e) => { console.error('cleanup failed:', e.message); process.exit(2); });
