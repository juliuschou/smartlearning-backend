import type { INestApplication } from '@nestjs/common';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  DeletionManifestExporter,
  LocalImmutableManifestProvider,
} from '../src/modules/governance/application/deletion-manifest.exporter';
import type { DeletionManifest } from '../src/modules/governance/domain/deletion-manifest';
import { newId } from '../src/common/crypto';

describe('Deletion manifest exporter (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let dbReachable = false;
  let fixture: { outboxId: string; eventId: string; courseId: string };

  const manifest = (
    eventId: string,
    archiveId: string,
    sessionId: string,
  ): DeletionManifest => ({
    contractVersion: 'deletion-manifest.v1',
    deletionEventId: eventId,
    archivedResultId: archiveId,
    liveSessionId: sessionId,
    trigger: 'retention',
    reason: 'retention',
    deletedAt: '2026-09-09T00:00:00.000Z',
    categories: ['participants'],
  });

  beforeAll(async () => {
    try {
      setupTestDb();
      app = await createTestApp();
      await app.init();
      prisma = app.get(PrismaService);
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
    await withQuiescedLiveSessionPublisher(app, async () => {
      await truncateAll(prisma.prisma);
      const accountId = newId();
      const courseId = newId();
      const sessionId = newId();
      const archiveId = newId();
      const eventId = newId();
      await prisma.prisma.account.create({
        data: {
          id: accountId,
          username: `exporter-${newId()}`,
          displayName: 'Exporter',
          role: 'admin',
          passwordHash: 'unused',
        },
      });
      await prisma.prisma.course.create({
        data: {
          id: courseId,
          ownerAccountId: accountId,
          name: 'Exporter',
          description: null,
        },
      });
      await prisma.prisma.liveSession.create({
        data: {
          id: sessionId,
          courseId,
          sessionCode: 'ABCD2345',
          status: 'closed',
        },
      });
      await prisma.prisma.archivedResult.create({
        data: {
          id: archiveId,
          liveSessionId: sessionId,
          courseId,
          sessionLabel: 'Exporter',
          startedAt: new Date(),
          closedAt: new Date(),
          purgeAt: new Date(),
          payload: {},
        },
      });
      await prisma.prisma.deletionEvent.create({
        data: {
          id: eventId,
          archivedResultId: archiveId,
          liveSessionId: sessionId,
          courseId,
          trigger: 'retention',
          reason: 'retention',
          status: 'success',
          deletedCategories: ['participants'],
          completedAt: new Date(),
        },
      });
      await prisma.prisma.deletionManifestOutbox.create({
        data: {
          id: newId(),
          archivedResultId: archiveId,
          deletionEventId: eventId,
          contractVersion: 'deletion-manifest.v1',
          manifest: {
            ...manifest(eventId, archiveId, sessionId),
            archivedResultId: archiveId,
            liveSessionId: sessionId,
          },
          nextAttemptAt: new Date(),
        },
      });
      fixture = { outboxId: archiveId, eventId, courseId };
      app.get(LocalImmutableManifestProvider).manifests.clear();
    });
  });

  const skip = () => !dbReachable;

  it('continues a partial batch and retries only its transient failure', async () => {
    if (skip()) return;
    const rows = [fixture.outboxId];
    for (let index = 0; index < 2; index++) {
      const sessionId = newId();
      const archiveId = newId();
      const eventId = newId();
      await prisma.prisma.liveSession.create({
        data: {
          id: sessionId,
          courseId: fixture.courseId,
          sessionCode: `ABCD${index + 6}345`,
          status: 'closed',
        },
      });
      await prisma.prisma.archivedResult.create({
        data: {
          id: archiveId,
          liveSessionId: sessionId,
          courseId: fixture.courseId,
          sessionLabel: 'Exporter',
          startedAt: new Date(),
          closedAt: new Date(),
          purgeAt: new Date(),
          payload: {},
        },
      });
      await prisma.prisma.deletionEvent.create({
        data: {
          id: eventId,
          archivedResultId: archiveId,
          liveSessionId: sessionId,
          courseId: fixture.courseId,
          trigger: 'retention',
          reason: 'retention',
          status: 'success',
          deletedCategories: ['participants'],
          completedAt: new Date(),
        },
      });
      await prisma.prisma.deletionManifestOutbox.create({
        data: {
          id: newId(),
          archivedResultId: archiveId,
          deletionEventId: eventId,
          contractVersion: 'deletion-manifest.v1',
          manifest: manifest(eventId, archiveId, sessionId),
          nextAttemptAt: new Date(),
        },
      });
      rows.push(archiveId);
    }

    let calls = 0;
    const provider = {
      put: async (value: DeletionManifest) => {
        calls++;
        if (calls === 2) throw new Error('transient provider failure');
        void value;
      },
    };
    const exporter = new DeletionManifestExporter(prisma, provider);
    const first = await exporter.exportDueBatch(
      3,
      new Date('2099-09-09T01:00:00Z'),
    );
    expect(first).toMatchObject({ selected: 3, exported: 2, failed: 1 });
    const states = await prisma.prisma.deletionManifestOutbox.findMany({
      where: { archivedResultId: { in: rows } },
      select: { archivedResultId: true, status: true },
    });
    expect(states.filter((row) => row.status === 'exported')).toHaveLength(2);
    expect(states.filter((row) => row.status === 'retry')).toHaveLength(1);
    const second = await exporter.exportDueBatch(
      3,
      new Date('2099-09-09T01:00:02Z'),
    );
    expect(second).toMatchObject({ selected: 1, exported: 1, failed: 0 });
    expect(
      await prisma.prisma.deletionManifestOutbox.count({
        where: { archivedResultId: { in: rows }, status: 'exported' },
      }),
    ).toBe(3);
  });

  it('recovers expired processing leases while leaving active leases alone', async () => {
    if (skip()) return;
    const provider = app.get(LocalImmutableManifestProvider);
    const exporter = app.get(DeletionManifestExporter);
    const now = new Date('2099-09-09T02:00:00Z');
    await prisma.prisma.deletionManifestOutbox.update({
      where: { archivedResultId: fixture.outboxId },
      data: {
        status: 'processing',
        leaseToken: newId(),
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        attempts: 1,
      },
    });
    expect(await exporter.exportDueBatch(1, now)).toMatchObject({
      selected: 0,
    });
    await prisma.prisma.deletionManifestOutbox.update({
      where: { archivedResultId: fixture.outboxId },
      data: { leaseExpiresAt: new Date(now.getTime() - 1) },
    });
    expect(await exporter.exportDueBatch(1, now)).toMatchObject({
      selected: 1,
      exported: 1,
    });
    expect(provider.manifests.size).toBe(1);
  });

  it('dead-letters malformed manifests and exhausted transient attempts', async () => {
    if (skip()) return;
    const exporter = app.get(DeletionManifestExporter);
    await prisma.prisma.deletionManifestOutbox.update({
      where: { archivedResultId: fixture.outboxId },
      data: { manifest: { nope: true } },
    });
    expect(await exporter.exportDueBatch(1)).toMatchObject({ failed: 1 });
    expect(
      (
        await prisma.prisma.deletionManifestOutbox.findUniqueOrThrow({
          where: { archivedResultId: fixture.outboxId },
        })
      ).status,
    ).toBe('failed');
    await prisma.prisma.deletionManifestOutbox.update({
      where: { archivedResultId: fixture.outboxId },
      data: {
        status: 'retry',
        attempts: 7,
        nextAttemptAt: new Date(0),
        manifest: {
          ...manifest(fixture.eventId, fixture.outboxId, newId()),
          archivedResultId: fixture.outboxId,
        },
      },
    });
    const provider = app.get(LocalImmutableManifestProvider);
    provider.failNext = true;
    expect(
      await exporter.exportDueBatch(1, new Date('2026-09-09T04:00:00Z')),
    ).toMatchObject({ failed: 1 });
    expect(
      (
        await prisma.prisma.deletionManifestOutbox.findUniqueOrThrow({
          where: { archivedResultId: fixture.outboxId },
        })
      ).status,
    ).toBe('failed');
  });

  it('retries idempotently when provider succeeds before DB acknowledgement', async () => {
    if (skip()) return;
    let firstCall = true;
    const provider = {
      put: async (value: DeletionManifest) => {
        if (firstCall) {
          firstCall = false;
          await prisma.prisma.deletionManifestOutbox.update({
            where: { archivedResultId: fixture.outboxId },
            data: { leaseToken: newId(), leaseExpiresAt: new Date(0) },
          });
        }
        void value;
      },
    };
    const exporter = new DeletionManifestExporter(prisma, provider);
    expect(
      await exporter.exportDueBatch(1, new Date('2099-09-09T03:00:00Z')),
    ).toMatchObject({ selected: 1, exported: 0, failed: 0 });
    expect(
      await exporter.exportDueBatch(1, new Date('2099-09-09T03:01:01Z')),
    ).toMatchObject({ selected: 1, exported: 1, failed: 0 });
  });
});
