// Seeds overdue retention fixtures into smartlearning_test (step-4 alert rehearsal).
import pg from 'pg';
import { randomUUID } from 'node:crypto';
const client = new pg.Client({ connectionString: 'postgresql://smartlearning:smartlearning123@localhost:5432/smartlearning_test' });
await client.connect();
const overdue = new Date(Date.now() - 3 * 86400_000); // 3 days overdue → oldest_due_age fires
const now = new Date();
const acc = randomUUID(), course = randomUUID(), ls = randomUUID(), ar = randomUUID(), ev = randomUUID(), out = randomUUID();
await client.query(
  `INSERT INTO account (id, username, display_name, role, password_hash, created_at, updated_at)
   VALUES ($1,$2,$3,'admin','unused',now(),now())`,
  [acc, 'rehearsal-' + acc.slice(0, 8), 'Rehearsal'],
);
await client.query(
  `INSERT INTO course (id, owner_account_id, name, created_at, updated_at)
   VALUES ($1,$2,$3,now(),now())`,
  [course, acc, 'Rehearsal'],
);
await client.query(
  `INSERT INTO live_session (id, course_id, session_code, status, started_at, closed_at, created_at, updated_at)
   VALUES ($1,$2,$3,'closed',$4,$4,now(),now())`,
  [ls, course, 'REH4S2AB', overdue],
);
await client.query(
  `INSERT INTO archived_result
     (id, live_session_id, course_id, session_label, started_at, closed_at, purge_at, status, purge_state,
      next_purge_attempt_at, payload, created_at)
   VALUES ($1,$2,$3,$4,$5,$5,$5,'active','pending',$5,'{}',now())`,
  [ar, ls, course, 'Rehearsal', overdue],
);
await client.query(
  `INSERT INTO deletion_event
     (id, archived_result_id, live_session_id, course_id, trigger, reason, status, deleted_categories, completed_at, created_at)
   VALUES ($1,$2,$3,$4,'retention','retention','success',$5,$6,now())`,
  [ev, ar, ls, course,
   JSON.stringify(['archive_payload', 'submissions', 'participants', 'session_questions', 'realtime_target_routing']),
   now],
);
// Outbox row with a long-overdue next attempt (S3 endpoint unreachable → export fails → lag + dead record)
await client.query(
  `INSERT INTO deletion_manifest_outbox
     (id, archived_result_id, deletion_event_id, contract_version, manifest, status, attempts, next_attempt_at, created_at)
   VALUES ($1,$2,$3,'deletion-manifest.v1',$4,'retry',5,$5,now())`,
  [out, ar, ev,
   JSON.stringify({
     contractVersion: 'deletion-manifest.v1', deletionEventId: ev, archivedResultId: ar, liveSessionId: ls,
     trigger: 'retention', reason: 'retention', deletedAt: now.toISOString(),
     categories: ['archive_payload', 'submissions', 'participants', 'session_questions', 'realtime_target_routing'],
   }),
   new Date(Date.now() - 7200_000)], // next attempt 2h ago → lag > 3600
);
console.log('seeded: archivedResult', ar, 'outbox', out);
await client.end();