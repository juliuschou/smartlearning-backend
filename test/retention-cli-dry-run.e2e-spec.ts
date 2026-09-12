import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { newId } from '../src/common/crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * BE-5.2.4 operator-CLI evidence: `npm run retention dry-run` (the real
 * subprocess the package script targets, `node dist/src/bootstrap/retention.js`)
 * must boot, emit an approving JSON artifact for a due archive, and make zero
 * writes. The in-process `GovernanceService.purgeDue(..., /* dryRun *\/ true)`
 * semantics are already proven by archive-governance; this suite closes the
 * operator-path gap (env loading, gates, AppModule boot, subprocess exit, stdout
 * artifact, write-free guarantee from the CLI's perspective).
 *
 * Preconditions: `smartlearning_test` migrated/reachable (setupTestDb enforces
 * the name guard) and the backend built so `dist/src/bootstrap/retention.js`
 * exists — mirroring how `npm run retention` requires a build. If the CLI entry
 * is missing we build once; if the build fails the suite fails loudly (never a
 * silent skip).
 */
const CLI_ENTRY = 'dist/src/bootstrap/retention.js';

function ensureCliBuilt(): void {
  if (existsSync(CLI_ENTRY)) return;
  execFileSync('npm', ['run', 'build'], {
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'test' },
  });
}

describe('retention operator CLI dry-run (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'retention-cli-admin',
    displayName: 'Retention CLI Admin',
    password: 'retention-cli-admin-password-1234',
  };
  const TEACHER = {
    username: 'retention-cli-teacher',
    displayName: 'Retention CLI Teacher',
    tempPassword: 'retention-cli-teacher-temp-1234',
    password: 'retention-cli-teacher-final-1234',
  };

  type AuthenticatedAgent = {
    agent: request.SuperAgentTest;
    csrfToken: string;
  };

  function cookieHeaders(value: string | string[] | undefined): string[] {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  }
  function cookieValue(setCookie: string[] | undefined, name: string): string {
    const prefix = `${name}=`;
    return (
      setCookie
        ?.find((cookie) => cookie.startsWith(prefix))
        ?.split(';', 1)[0]
        .slice(prefix.length) ?? ''
    );
  }

  async function loginAs(
    username: string,
    password: string,
  ): Promise<AuthenticatedAgent> {
    const agent = request.agent(app.getHttpServer());
    const response = await agent
      .post('/api/v1/auth/login')
      .send({ username, password });
    return {
      agent: agent as unknown as request.SuperAgentTest,
      csrfToken: cookieValue(
        cookieHeaders(response.headers['set-cookie']),
        '__Host-csrf',
      ),
    };
  }

  async function provisionTeacher(
    username: string,
    tempPassword: string,
    finalPassword: string,
  ): Promise<AuthenticatedAgent> {
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const created = await admin.agent
      .post('/api/v1/admin/accounts')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        username,
        displayName: TEACHER.displayName,
        role: AccountRole.TEACHER,
        canCreateCourse: true,
        tempPassword,
      });
    expect(created.status).toBe(201);
    const temporary = await loginAs(username, tempPassword);
    const changed = await temporary.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, temporary.csrfToken)
      .send({ currentPassword: tempPassword, newPassword: finalPassword });
    expect(changed.status).toBe(201);
    return loginAs(username, finalPassword);
  }

  /** Full close-to-archive chain: course → poll → session → start → open → submit → close. */
  async function provisionArchivedSession(
    teacher: AuthenticatedAgent,
  ): Promise<{
    courseId: string;
    liveSessionId: string;
    sessionCode: string;
    sessionQuestionId: string;
  }> {
    const course = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Retention CLI Course', description: 'slice' });
    expect(course.status).toBe(201);
    const courseId = course.body.data.id as string;

    const question = await teacher.agent
      .post(`/api/v1/courses/${courseId}/questions`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        type: 'poll',
        prompt: '哪一個概念最想釐清？',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: '選項 A' },
          { optionRef: 'b', text: '選項 B' },
        ],
      });
    expect(question.status).toBe(201);
    const questionId = question.body.data.id as string;

    const waiting = await teacher.agent
      .post('/api/v1/live-sessions')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ courseId, questionIds: [questionId] });
    expect(waiting.status).toBe(201);
    const liveSessionId = waiting.body.data.id as string;
    const sessionCode = waiting.body.data.sessionCode as string;

    const started = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/start`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(started.status).toBe(201);
    const sessionQuestionId = started.body.data.sessionQuestions[0]
      .id as string;

    // One participant submission so the planned table counts are non-trivial.
    const joined = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${sessionCode}/join`)
      .send({ displayName: 'CLI dry-run participant' });
    expect(joined.status).toBe(201);
    const participantToken = joined.body.data.participantToken as string;

    await teacher.agent
      .post(
        `/api/v1/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/open`,
      )
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    const submitted = await request(app.getHttpServer())
      .post(`/api/v1/live-sessions/${liveSessionId}/submissions`)
      .set('X-Participant-Token', participantToken)
      .set('Idempotency-Key', newId())
      .send({ sessionQuestionId, selectedOptionRefs: ['a'] });
    expect(submitted.status).toBe(201);

    const closed = await teacher.agent
      .post(`/api/v1/live-sessions/${liveSessionId}/close`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken);
    expect(closed.status).toBe(201);

    return { courseId, liveSessionId, sessionCode, sessionQuestionId };
  }

  beforeAll(async () => {
    try {
      setupTestDb();
      migrationsReady = true;
    } catch {
      // Keep the suite blocked when migrations cannot apply; never probe stale schema.
    }
    ensureCliBuilt();
    app = await createTestApp();
    await app.init();
    prisma = app.get(PrismaService);
    bootstrap = app.get(BootstrapService);
    if (!migrationsReady) return;
    try {
      await prisma.prisma.$queryRaw`SELECT 1 FROM question_definition LIMIT 0`;
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
    await withQuiescedLiveSessionPublisher(app, () =>
      truncateAll(prisma.prisma),
    );
    await bootstrap.createFirstAdmin(ADMIN);
  });

  function requireDatabase(): void {
    if (!dbReachable)
      throw new Error(
        'smartlearning_test is unreachable; cannot run CLI dry-run E2E',
      );
  }

  it('emits an approving JSON artifact for a due archive through the real CLI subprocess and writes nothing', async () => {
    requireDatabase();
    const teacher = await provisionTeacher(
      `${TEACHER.username}-cli`,
      TEACHER.tempPassword,
      TEACHER.password,
    );
    const session = await provisionArchivedSession(teacher);

    // A just-closed archive's purgeAt is 90d out; backdate it (and the session's
    // close) so the CLI's real clock sees it as due.
    const archive = await prisma.prisma.archivedResult.findUniqueOrThrow({
      where: { liveSessionId: session.liveSessionId },
    });
    const past = new Date(archive.purgeAt.getTime() - 90 * 24 * 60 * 60 * 1000);
    await prisma.prisma.archivedResult.update({
      where: { id: archive.id },
      data: { purgeAt: past },
    });
    await prisma.prisma.liveSession.update({
      where: { id: session.liveSessionId },
      data: { closedAt: past },
    });

    const tables = {
      submissions: () =>
        prisma.prisma.submission.count({
          where: { liveSessionId: session.liveSessionId },
        }),
      events: () =>
        prisma.prisma.liveSessionEvent.count({
          where: { liveSessionId: session.liveSessionId },
        }),
      options: () =>
        prisma.prisma.sessionQuestionOption.count({
          where: { sessionQuestion: { liveSessionId: session.liveSessionId } },
        }),
      questions: () =>
        prisma.prisma.sessionQuestion.count({
          where: { liveSessionId: session.liveSessionId },
        }),
      participants: () =>
        prisma.prisma.participant.count({
          where: { liveSessionId: session.liveSessionId },
        }),
    };
    const snapshot = async () => ({
      submissions: await tables.submissions(),
      events: await tables.events(),
      options: await tables.options(),
      questions: await tables.questions(),
      participants: await tables.participants(),
    });
    const before = await snapshot();

    // Invoke the real operator CLI as a subprocess (the `npm run retention`
    // target). Determinism + write-free guarantees from the CLI's perspective:
    //  - The parent app's own connections are quiesced first so they hold no
    //    `live_session` row locks that the child's `FOR UPDATE ... SKIP LOCKED`
    //    scan would otherwise skip (the same reason destructive suites use
    //    `withQuiescedLiveSessionPublisher`).
    //  - DATABASE_URL is pinned to the guarded `smartlearning_test` value already
    //    loaded from .env.test, so the child cannot resolve a different DB than
    //    the suite (this was the flakiness source: the inherited env diverged
    //    from the standalone shell run-to-run).
    //  - Batch size 1 so `selected`/`planned` are exact (one due archive). The
    //    dry-run dedup fix means a larger batch would still select each distinct
    //    archive exactly once, but 1 keeps the assertion unambiguous.
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || !databaseUrl.includes('smartlearning_test')) {
      throw new Error(
        'BLOCKED: retention CLI dry-run E2E requires DATABASE_URL to name smartlearning_test',
      );
    }
    const out = await withQuiescedLiveSessionPublisher(app, async () =>
      execFileSync('node', [CLI_ENTRY, 'dry-run'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: databaseUrl,
          RETENTION_OPERATIONS_ENABLED: 'true',
          RETENTION_PURGE_BATCH_SIZE: '1',
        },
      }),
    );

    const report = JSON.parse(out) as {
      selected: number;
      deleted: number;
      failed: number;
      planned: Array<{
        archiveId: string;
        category: string;
        tableCounts: Record<string, number>;
      }>;
    };
    // Approving artifact: one due archive planned, nothing deleted.
    expect(report.selected).toBe(1);
    expect(report.deleted).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.planned).toHaveLength(1);
    expect(report.planned[0]).toMatchObject({
      archiveId: archive.id,
      category: 'governed_deletion',
    });
    expect(report.planned[0].tableCounts).toEqual({
      Submission: before.submissions,
      LiveSessionEvent: before.events,
      SessionQuestionOption: before.options,
      SessionQuestion: before.questions,
      Participant: before.participants,
    });

    // Write-free from the CLI's perspective: the same governed rows are intact.
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(
      await prisma.prisma.archivedResult.findUniqueOrThrow({
        where: { id: archive.id },
        select: { status: true },
      }),
    ).toMatchObject({ status: 'active' });
  });
});
