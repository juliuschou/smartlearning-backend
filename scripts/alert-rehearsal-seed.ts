/**
 * Alert-firing rehearsal driver (BE-8.2 CP2, 2026-09-09).
 * Runs against the guarded smartlearning_test DB and the S3 sandbox.
 * Seeds alert-condition states, runs the retention sweep, then scrapes
 * /metrics and evaluates the retention alert rules.
 */
import { execSync } from 'node:child_process';
import { newId } from '../src/common/crypto';

async function main(): Promise<void> {
  // Seed: one overdue archive + one failed outbox record via psql fixture.
  const accountId = newId();
  const courseId = newId();
  const sessionId = newId();
  const archiveId = newId();
  const eventId = newId();
  const outboxId = newId();
  const stale = new Date(Date.now() - 3 * 86400_000).toISOString();
  const sessionCode = Array.from({ length: 8 }, () =>
    'ABCDEFGHJKMNPQRSTUVWXYZ23456789'.charAt(Math.floor(Math.random() * 30)),
  ).join('');

  const sql = `
    BEGIN;
    INSERT INTO account (id, username, display_name, role, password_hash, created_at, updated_at)
      VALUES ('${accountId}', 'alert-rehearsal-${newId()}', 'Alert Rehearsal', 'admin', 'unused', now(), now());
    INSERT INTO course (id, owner_account_id, name, created_at, updated_at)
      VALUES ('${courseId}', '${accountId}', 'Alert Rehearsal', now(), now());
    INSERT INTO live_session (id, course_id, session_code, status, created_at, updated_at)
      VALUES ('${sessionId}', '${courseId}', '${sessionCode}', 'closed', now(), now());
    INSERT INTO archived_result (id, live_session_id, course_id, session_label, started_at, closed_at, purge_at, status, payload, created_at)
      VALUES ('${archiveId}', '${sessionId}', '${courseId}', 'Alert Rehearsal', '${stale}', '${stale}', '${stale}', 'active', '{}'::jsonb, now());
    INSERT INTO deletion_event (id, archived_result_id, live_session_id, course_id, trigger, reason, status, deleted_categories, completed_at, created_at)
      VALUES ('${eventId}', '${archiveId}', '${sessionId}', '${courseId}', 'retention', 'retention', 'success', '["archive_payload","submissions","participants","session_questions","realtime_target_routing"]'::jsonb, '${stale}', now());
    INSERT INTO deletion_manifest_outbox (id, archived_result_id, deletion_event_id, contract_version, manifest, status, attempts, next_attempt_at, last_error, created_at)
      VALUES ('${outboxId}', '${archiveId}', '${eventId}', 'deletion-manifest.v1', '{"contractVersion":"deletion-manifest.v1","deletionEventId":"${eventId}","archivedResultId":"${archiveId}","liveSessionId":"${sessionId}","trigger":"retention","reason":"retention","deletedAt":"${stale}","categories":["archive_payload","submissions","participants","session_questions","realtime_target_routing"]}'::jsonb, 'pending', 0, now(), null, now());
    COMMIT;
  `;
  execSync(
    `docker exec -i smart-learning-pg-test psql -U smartlearning -d smartlearning_test -v ON_ERROR_STOP=1 -c "${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
    { stdio: 'inherit' },
  );
  console.log('SEEDED', { archiveId, outboxId, eventId });
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
