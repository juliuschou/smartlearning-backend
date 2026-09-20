import { Client } from 'pg';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: '.env.test', override: false });
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (sql, v=[]) => (await c.query(sql, v)).rows;
console.log(JSON.stringify({
  protectedTeacher: await q(`SELECT id,status FROM account WHERE username='local-w1-1789840353701-82cd63fa'`),
  protectedSession: await q(`SELECT id,status FROM live_session WHERE id='01a0bacc-83f9-7417-a52e-481d2fbd3e8c'`),
  protectedSeq: await q(`SELECT live_session_id FROM live_session_event_sequence WHERE live_session_id='01a0bacc-83f9-7417-a52e-481d2fbd3e8c'`),
  totals: await q(`SELECT (SELECT count(*) FROM live_session) ls, (SELECT count(*) FROM account) acct, (SELECT count(*) FROM submission) sub, (SELECT count(*) FROM participant) part, (SELECT count(*) FROM course) course, (SELECT count(*) FROM question_definition) qd`),
  version: (await q('SELECT version()'))[0],
  db: (await q('SELECT current_database() d'))[0],
}, null, 2));
await c.end();
