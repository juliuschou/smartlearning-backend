import type { INestApplication } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';
import { PrismaService } from '../src/prisma/prisma.service';
import { GovernanceService } from '../src/modules/governance/application/governance.service';
import {
  DeletionManifestExporter,
  LocalImmutableManifestProvider,
} from '../src/modules/governance/application/deletion-manifest.exporter';
import { CourseService } from '../src/modules/courses/application/course.service';
import { LiveSessionService } from '../src/modules/live-sessions/application/live-session.service';
import { ParticipantService } from '../src/modules/participants/application/participant.service';
import { SubmissionService } from '../src/modules/submissions/application/submission.service';
import { newId } from '../src/common/crypto';
import type { DeletionManifest } from '../src/modules/governance/domain/deletion-manifest';

/**
 * BE-5.3.6 backup-restore no-resurrection rehearsal (Checkpoint C).
 *
 * Proves, end to end on the guarded `smartlearning_test` database, that a
 * simulated backup restore of already-purged answer-bearing rows is undone by
 * the committed operator path: outbox -> manifest export into a run-scoped
 * local immutable store -> the real `node dist/src/bootstrap/retention.js
 * reconcile-apply` CLI subprocess (gates + env loading + watermark included,
 * not an in-process shortcut).
 *
 * Scenario = "a backup restore resurrects deleted data":
 *  1. full governance chain: course -> session -> join/submit -> close
 *     (archive) -> teacher request -> admin confirm (early_delete);
 *  2. export the manifest into a run-scoped local immutable store file;
 *  3. SIMULATE BACKUP RESTORE: re-insert the deleted session question,
 *     options, participant, and submission rows (as an operator's pg_restore
 *     into a live DB would);
 *  4. `reconcile-apply` once -> answer-bearing rows are zero again, the
 *     canonical DeletionEvent stays unique (no second tombstone/outbox row),
 *     and the watermark in the store file advanced to the manifest;
 *  5. `reconcile-apply` again -> idempotent (applied 0, counts still zero).
 *
 * Restore completion boundary (documented Checkpoint C decision): a backup
 * restore is "complete" only after manifest reconciliation apply finishes AND
 * the verification queries in step 4 pass. This rehearsal does NOT claim a
 * transparent DB hook; production backup/restore runbook integration remains
 * a separate gate.
 *
 * Requires `smartlearning_test` migrated/reachable and the backend built
 * (`dist/src/bootstrap/retention.js`); the suite builds once if needed and
 * fails loudly rather than silently skipping.
 */

const CLI_ENTRY = 'dist/src/bootstrap/retention.js';

function ensureCliBuilt(): void {
  if (existsSync(CLI_ENTRY)) return;
  execFileSync('npm', ['run', 'build'], {
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'test' },
  });
}

describe('BE-5.3.6 backup-restore no-resurrection rehearsal (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dbReachable = false;
  let workDir = '';
  let manifestFile = '';

  beforeAll(async () => {
    try {
      setupTestDb();
      app = await createTestApp();
      await app.init();
      prisma = app.get(PrismaService);
      await prisma.prisma.$queryRaw`SELECT 1 FROM archived_result LIMIT 0`;
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
    ensureCliBuilt();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    await truncateAll(prisma.prisma);
    workDir = mkdtempSync(join(tmpdir(), 'restore-rehearsal-'));
    manifestFile = join(workDir, 'manifests.json');
  });

  function runReconcileApply(): { applied: number; skipped: number } {
    const stdout = execFileSync('node', [CLI_ENTRY, 'reconcile-apply'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        RETENTION_OPERATIONS_ENABLED: '1',
        RETENTION_RECONCILE_APPLY_ENABLED: '1',
        RETENTION_LOCAL_MANIFEST_FILE: manifestFile,
      },
    });
    return JSON.parse(stdout) as { applied: number; skipped: number };
  }

  it('removes restored answer-bearing rows via the operator reconcile-apply path and stays idempotent', async () => {
    if (!dbReachable) throw new Error('BLOCKED: guarded test DB unreachable');

    // -- Step 1: full chain to an early-deleted archive ------------------
    const teacher = await prisma.prisma.account.create({
      data: {
        id: newId(),
        username: `restore-rehearsal-teacher-${newId().slice(0, 8)}`,
        displayName: 'Restore Rehearsal Teacher',
        role: 'teacher',
        canCreateCourse: true,
      },
    });
    const admin = await prisma.prisma.account.create({
      data: {
        id: newId(),
        username: `restore-rehearsal-admin-${newId().slice(0, 8)}`,
        displayName: 'Restore Rehearsal Admin',
        role: 'admin',
      },
    });
    const course = await app.get(CourseService).createCourse({
      ownerAccountId: teacher.id,
      name: 'Restore rehearsal course',
    });
    const question = await prisma.prisma.questionDefinition.create({
      data: {
        id: newId(),
        courseId: course.id,
        type: 'poll',
        prompt: 'Restore rehearsal question',
        selectionMode: 'single',
        position: 1,
        options: {
          create: [
            { id: newId(), optionRef: 'a', text: 'A', position: 1 },
            { id: newId(), optionRef: 'b', text: 'B', position: 2 },
          ],
        },
      },
      include: { options: true },
    });
    const liveSessionService = app.get(LiveSessionService);
    const session = await liveSessionService.createSession(
      { courseId: course.id, questionIds: [question.id] },
      { id: teacher.id, role: teacher.role },
    );
    const started = await liveSessionService.startSession(session.id, {
      id: teacher.id,
      role: teacher.role,
    });
    const sessionQuestionId = started.questions[0].id;
    await liveSessionService.openQuestion(session.id, sessionQuestionId, {
      id: teacher.id,
      role: teacher.role,
    });
    const joined = await app
      .get(ParticipantService)
      .join(started.sessionCode, 'Restore rehearsal participant');
    await app.get(SubmissionService).submit(
      session.id,
      {
        participantId: joined.participant.id,
        liveSessionId: session.id,
      },
      newId(),
      { sessionQuestionId, selectedOptionRefs: ['a'] },
    );
    await liveSessionService.closeSession(session.id, {
      id: teacher.id,
      role: teacher.role,
    });

    const tombstoneBeforeDeletion =
      await prisma.prisma.archivedResult.findUniqueOrThrow({
        where: { liveSessionId: session.id },
      });
    expect(tombstoneBeforeDeletion.status).toBe('active');

    // Capture the rows the purge will delete, exactly as a backup taken
    // before the delete would contain them.
    const backupRows = {
      sessionQuestion: await prisma.prisma.sessionQuestion.findFirstOrThrow({
        where: { liveSessionId: session.id },
        include: { options: true },
      }),
      participant: await prisma.prisma.participant.findFirstOrThrow({
        where: { liveSessionId: session.id },
      }),
    };

    const governance = app.get(GovernanceService);
    const receipt = await governance.request(
      session.id,
      teacher.id,
      teacher.role,
      'privacy',
    );
    expect(receipt.status).toBe('requested');
    const deletion = await governance.delete(
      session.id,
      admin.id,
      receipt.id,
      'privacy',
    );
    expect(deletion.status).toBe('deleted');

    const tombstone = await prisma.prisma.archivedResult.findUniqueOrThrow({
      where: { liveSessionId: session.id },
    });
    expect(tombstone.status).toBe('deleted');
    expect(tombstone.payload).toBeNull();
    const canonicalEvent = await prisma.prisma.deletionEvent.findFirstOrThrow({
      where: { liveSessionId: session.id, trigger: 'early_delete' },
    });
    expect(
      await prisma.prisma.submission.count({
        where: { liveSessionId: session.id },
      }),
    ).toBe(0);

    // -- Step 2: export the manifest into a run-scoped local store ------
    const local = app.get(LocalImmutableManifestProvider);
    const exportResult = await app
      .get(DeletionManifestExporter)
      .exportDueBatch(50);
    expect(exportResult.exported).toBe(1);
    expect(local.manifests.size).toBe(1);
    const manifest: DeletionManifest = [...local.manifests.values()][0];
    expect(manifest.liveSessionId).toBe(session.id);

    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      manifestFile,
      JSON.stringify({ manifests: [...local.manifests.values()] }, null, 2),
      'utf8',
    );
    // No watermark yet: reconcile-apply must create it on first apply.

    // -- Step 3: SIMULATE BACKUP RESTORE of purged answer-bearing rows --
    const restoredQuestion = backupRows.sessionQuestion;
    // The purge deleted session questions/options/participants/submissions;
    // restore them exactly as a backup replay would (same ids).
    await prisma.prisma.sessionQuestion.create({
      data: {
        id: restoredQuestion.id,
        liveSessionId: session.id,
        questionDefinitionId: restoredQuestion.questionDefinitionId,
        position: restoredQuestion.position,
        status: restoredQuestion.status,
        aggregateVersion: restoredQuestion.aggregateVersion,
        snapshotType: restoredQuestion.snapshotType,
        snapshotPrompt: restoredQuestion.snapshotPrompt,
        snapshotSelectionMode: restoredQuestion.snapshotSelectionMode,
        openedAt: restoredQuestion.openedAt,
        closedAt: restoredQuestion.closedAt,
      },
    });
    await prisma.prisma.sessionQuestionOption.createMany({
      data: restoredQuestion.options,
    });
    // The participant row is also restored (same token hash/id as the
    // pre-delete backup held), then the answer-bearing submission on top.
    await prisma.prisma.participant.create({ data: backupRows.participant });
    await prisma.prisma.submission.create({
      data: {
        id: newId(),
        liveSessionId: session.id,
        sessionQuestionId,
        participantId: backupRows.participant.id,
        idempotencyKey: newId(),
        selectedOptionRefs: [restoredQuestion.options[0].id],
        submittedAt: new Date(),
      },
    });
    expect(
      await prisma.prisma.submission.count({
        where: { liveSessionId: session.id },
      }),
    ).toBe(1);

    // -- Step 4: operator reconcile-apply undoes the resurrection ------
    const apply = runReconcileApply();
    expect(apply.applied).toBe(1);
    expect(apply.skipped).toBe(0);

    expect(
      await prisma.prisma.submission.count({
        where: { liveSessionId: session.id },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.sessionQuestion.count({
        where: { liveSessionId: session.id },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.sessionQuestionOption.count({
        where: { sessionQuestionId: restoredQuestion.id },
      }),
    ).toBe(0);
    expect(
      await prisma.prisma.deletionEvent.count({
        where: { id: canonicalEvent.id },
      }),
    ).toBe(1);
    // Exactly one canonical deletion event plus the original teacher request
    // event (trigger teacher_request); no second canonical event was created.
    expect(
      await prisma.prisma.deletionEvent.count({
        where: { liveSessionId: session.id, trigger: 'early_delete' },
      }),
    ).toBe(1);
    expect(
      await prisma.prisma.deletionManifestOutbox.count({
        where: { archivedResultId: tombstone.id },
      }),
    ).toBe(1);
    expect(
      await prisma.prisma.archivedResult.findUniqueOrThrow({
        where: { id: tombstone.id },
      }),
    ).toMatchObject({ status: 'deleted', payload: null });

    // -- Step 5: repeat apply is idempotent ----------------------------
    const repeat = runReconcileApply();
    expect(repeat.applied).toBe(0);
    expect(
      await prisma.prisma.submission.count({
        where: { liveSessionId: session.id },
      }),
    ).toBe(0);
    // Still exactly one canonical deletion event after the repeat apply.
    expect(
      await prisma.prisma.deletionEvent.count({
        where: { liveSessionId: session.id, trigger: 'early_delete' },
      }),
    ).toBe(1);

    // The store file now carries the watermark at the canonical event.
    const store = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
      watermark?: { deletionEventId: string; deletedAt: string };
    };
    expect(store.watermark?.deletionEventId).toBe(manifest.deletionEventId);
  });
});
