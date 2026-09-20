const { Client } = require('pg');const { config } = require('dotenv');
config({ path: '.env.test', override: false });
(async () => {
  const f = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8')).fixture;
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const q = async (t) => Number((await c.query(t)).rows[0].n);
  const out = {
    liveSession: await q(`SELECT count(*)::int n FROM live_session WHERE id='${f.liveSessionId}'`),
    question: await q(`SELECT count(*)::int n FROM question_definition WHERE id='${f.questionId}'`),
    course: await q(`SELECT count(*)::int n FROM course WHERE id='${f.courseId}'`),
    participants: await q(`SELECT count(*)::int n FROM participant WHERE live_session_id='${f.liveSessionId}'`),
    submissions: await q(`SELECT count(*)::int n FROM submission WHERE live_session_id='${f.liveSessionId}'`),
    events: await q(`SELECT count(*)::int n FROM live_session_event WHERE live_session_id='${f.liveSessionId}'`),
    account: await q(`SELECT count(*)::int n FROM account WHERE username='${f.username}'`),
    protectedSessionStillTracked: await q(`SELECT count(*)::int n FROM live_session_event_sequence WHERE live_session_id='01a0bacc-83f9-7417-a52e-481d2fbd3e8c'`),
  };
  await c.end();
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e.message); process.exit(1); });
