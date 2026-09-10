import type { INestApplication } from '@nestjs/common';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';
import { PrismaService } from '../src/prisma/prisma.service';
import { DeletionManifestExporter } from '../src/modules/governance/application/deletion-manifest.exporter';
import { newId } from '../src/common/crypto';

/**
 * External S3 sandbox upload rehearsal (BE-8.2 CP2, authorized 2026-09-09).
 * Target: disposable MinIO at 127.0.0.1:19000, bucket sl-rehearsal-manifests,
 * write-only credential (see .env.sandbox-rehearsal, gitignored).
 * Requires DELETION_MANIFEST_PROVIDER=s3 in the loaded env; refuses to run
 * against the local provider so this spec can never silently stand in for
 * external delivery evidence.
 */
describe('External S3 sandbox manifest upload rehearsal', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let exporter: DeletionManifestExporter;
  let dbReachable = false;
  let s3Mode = false;

  const fixture = { eventId: '', archiveId: '', sessionId: '' };

  beforeAll(async () => {
    s3Mode = process.env.DELETION_MANIFEST_PROVIDER === 's3';
    if (!s3Mode) {
      // Blocked, not failed: running with the local provider would produce
      // misleading "external delivery" evidence.
      return;
    }
    try {
      setupTestDb();
      app = await createTestApp();
      await app.init();
      prisma = app.get(PrismaService);
      exporter = app.get(DeletionManifestExporter);
      await prisma.prisma
        .$queryRaw`SELECT 1 FROM deletion_manifest_outbox LIMIT 0`;
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    await truncateAll(prisma.prisma);
    const accountId = newId();
    const courseId = newId();
    fixture.sessionId = newId();
    fixture.archiveId = newId();
    fixture.eventId = newId();
    await prisma.prisma.account.create({
      data: {
        id: accountId,
        username: `s3-rehearsal-${newId()}`,
        displayName: 'S3 Rehearsal',
        role: 'admin',
        passwordHash: 'unused',
      },
    });
    await prisma.prisma.course.create({
      data: { id: courseId, ownerAccountId: accountId, name: 'S3 Rehearsal' },
    });
    await prisma.prisma.liveSession.create({
      data: {
        id: fixture.sessionId,
        courseId,
        sessionCode: 'S3REH234',
        status: 'closed',
      },
    });
    await prisma.prisma.archivedResult.create({
      data: {
        id: fixture.archiveId,
        liveSessionId: fixture.sessionId,
        courseId,
        sessionLabel: 'S3 Rehearsal',
        startedAt: new Date(),
        closedAt: new Date(),
        purgeAt: new Date(),
        payload: {},
      },
    });
    await prisma.prisma.deletionEvent.create({
      data: {
        id: fixture.eventId,
        archivedResultId: fixture.archiveId,
        liveSessionId: fixture.sessionId,
        courseId,
        trigger: 'retention',
        reason: 'retention',
        status: 'success',
        deletedCategories: [
          'archive_payload',
          'submissions',
          'participants',
          'session_questions',
          'realtime_target_routing',
        ],
        completedAt: new Date(),
      },
    });
    await prisma.prisma.deletionManifestOutbox.create({
      data: {
        id: newId(),
        archivedResultId: fixture.archiveId,
        deletionEventId: fixture.eventId,
        contractVersion: 'deletion-manifest.v1',
        manifest: {
          contractVersion: 'deletion-manifest.v1',
          deletionEventId: fixture.eventId,
          archivedResultId: fixture.archiveId,
          liveSessionId: fixture.sessionId,
          trigger: 'retention',
          reason: 'retention',
          deletedAt: new Date().toISOString(),
          categories: [
            'archive_payload',
            'submissions',
            'participants',
            'session_questions',
            'realtime_target_routing',
          ],
        },
        nextAttemptAt: new Date(),
      },
    });
  });

  it('uploads the manifest to the S3 sandbox and marks the outbox exported', async () => {
    if (!s3Mode || !dbReachable) {
      throw new Error(
        'BLOCKED: requires DELETION_MANIFEST_PROVIDER=s3 env and a reachable guarded test DB.',
      );
    }
    const result = await exporter.exportDueBatch(10);
    expect(result.selected).toBe(1);
    expect(result.exported).toBe(1);
    expect(result.failed).toBe(0);

    const row = await prisma.prisma.deletionManifestOutbox.findFirstOrThrow();
    expect(row.status).toBe('exported');
    expect(row.exportedAt).not.toBeNull();
    expect(row.leaseToken).toBeNull();
    expect(row.lastError).toBeNull();

    // Idempotent replay: the same manifest must not conflict.
    const replay = await exporter.exportDueBatch(10);
    expect(replay.selected).toBe(0);

    // Reset the row to force a re-put of the identical manifest; immutable
    // provider contract must accept the exact duplicate.
    await prisma.prisma.deletionManifestOutbox.update({
      where: { id: row.id },
      data: { status: 'retry', exportedAt: null, nextAttemptAt: new Date() },
    });
    const duplicate = await exporter.exportDueBatch(10);
    expect(duplicate.exported).toBe(1);
  });
});
