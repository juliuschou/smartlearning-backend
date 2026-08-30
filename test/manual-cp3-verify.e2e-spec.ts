import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { hashToken } from '../src/common/crypto';
import { CSRF_HEADER } from '../src/common/security';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * BE-8.3 CP3 — manual Checkpoint 3 verification.
 *
 * Run this file explicitly after the automated bundle. Raw credentials remain
 * in process memory only; this spec never prints or writes them to evidence.
 */
describe('BE-8.3 CP3 manual Checkpoint 3 verification', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'cp3-manual-admin',
    displayName: 'CP3 Manual Admin',
    password: 'cp3-manual-admin-password-1234',
  };
  const TEACHER = {
    username: 'cp3-manual-teacher',
    displayName: 'CP3 Manual Teacher',
    tempPassword: 'cp3-manual-temp-password-1234',
    password: 'cp3-manual-final-password-1234',
  };

  type Agent = {
    agent: request.SuperAgentTest;
    csrf: string;
  };

  beforeAll(async () => {
    try {
      setupTestDb();
      migrationsReady = true;
    } catch {
      // requireDatabase() reports the blocked checkpoint below.
    }
    app = await createTestApp();
    await app.init();
    prisma = app.get(PrismaService);
    bootstrap = app.get(BootstrapService);
    if (!migrationsReady) return;
    try {
      await prisma.prisma.$queryRaw`SELECT 1 FROM cli_credential LIMIT 0`;
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

  function cookieValue(setCookie: string[] | undefined, name: string): string {
    const prefix = `${name}=`;
    const value = setCookie
      ?.find((cookie) => cookie.startsWith(prefix))
      ?.split(';', 1)[0]
      .slice(prefix.length);
    if (!value) throw new Error(`Missing ${name} cookie`);
    return value;
  }

  async function login(username: string, password: string): Promise<Agent> {
    const agent = request.agent(app.getHttpServer());
    const response = await agent
      .post('/api/v1/auth/login')
      .send({ username, password });
    expect(response.status).toBe(201);
    return {
      agent: agent as unknown as request.SuperAgentTest,
      csrf: cookieValue(
        response.headers['set-cookie'] as unknown as string[] | undefined,
        '__Host-csrf',
      ),
    };
  }

  async function createTeacher(admin: Agent): Promise<{
    id: string;
    agent: Agent;
  }> {
    const created = await admin.agent
      .post('/api/v1/admin/accounts')
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({
        username: TEACHER.username,
        displayName: TEACHER.displayName,
        role: AccountRole.TEACHER,
        canCreateCourse: true,
        tempPassword: TEACHER.tempPassword,
      });
    expect(created.status).toBe(201);

    const temporary = await login(TEACHER.username, TEACHER.tempPassword);
    const changed = await temporary.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, temporary.csrf)
      .send({
        currentPassword: TEACHER.tempPassword,
        newPassword: TEACHER.password,
      });
    expect(changed.status).toBe(201);
    return {
      id: created.body.data.id as string,
      agent: await login(TEACHER.username, TEACHER.password),
    };
  }

  async function stepUp(admin: Agent): Promise<void> {
    const response = await admin.agent
      .post('/api/v1/auth/step-up')
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ password: ADMIN.password });
    expect(response.status).toBe(201);
  }

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL unavailable for CP3 manual verification.',
      );
    }
  }

  it('audits immediate rotation, token boundaries, and one-successor concurrency', async () => {
    requireDatabase();
    const admin = await login(ADMIN.username, ADMIN.password);
    const teacher = await createTeacher(admin);
    const course = await teacher.agent.agent
      .post('/api/v1/courses')
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, teacher.agent.csrf)
      .send({ name: 'CP3 Manual Course' });
    expect(course.status).toBe(201);
    const courseId = course.body.data.id as string;

    await stepUp(admin);
    const created = await admin.agent
      .post(`/api/v1/admin/accounts/${teacher.id}/cli-credentials`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ name: 'cp3-manual-key' });
    expect(created.status).toBe(201);
    const predecessorId = created.body.data.id as string;
    const predecessorKey = created.body.data.rawKey as string;
    const predecessorHash = hashToken(predecessorKey);
    expect(predecessorKey).toBeTruthy();
    expect(JSON.stringify(created.body)).not.toContain(predecessorHash);

    const questions = [
      {
        clientRef: 'manual-q1',
        type: 'open_text',
        prompt: 'CP3 manual rotation question',
      },
    ];
    const beforeRotation = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', predecessorKey)
      .send({ schemaVersion: 1, courseId, questions });
    expect(beforeRotation.status).toBe(201);
    expect(beforeRotation.body.data.valid).toBe(true);
    const oldToken = beforeRotation.body.data.validationToken as string;
    const oldPayloadHash = beforeRotation.body.data.payloadHash as string;

    const rotated = await admin.agent
      .post(
        `/api/v1/admin/accounts/${teacher.id}/cli-credentials/${predecessorId}/rotate`,
      )
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf);
    expect(rotated.status).toBe(201);
    const successorId = rotated.body.data.id as string;
    const successorKey = rotated.body.data.rawKey as string;
    const successorHash = hashToken(successorKey);
    expect(successorId).not.toBe(predecessorId);
    expect(successorKey).toBeTruthy();
    expect(rotated.body.data.name).toBe('cp3-manual-key');
    expect(rotated.body.data.scope).toBe('all_courses');
    expect(rotated.body.data.rotatedFromId).toBe(predecessorId);
    expect(JSON.stringify(rotated.body)).not.toContain(successorHash);

    const predecessorAfterRotation = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', predecessorKey)
      .send({ schemaVersion: 1, courseId, questions });
    expect(predecessorAfterRotation.status).toBe(401);
    expect(predecessorAfterRotation.body.error.code).toBe(
      'CLI_CREDENTIAL_REVOKED',
    );
    expect(JSON.stringify(predecessorAfterRotation.body)).not.toContain(
      predecessorKey,
    );
    expect(JSON.stringify(predecessorAfterRotation.body)).not.toContain(
      predecessorHash,
    );

    const oldTokenWithSuccessor = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/confirm`)
      .set('X-CLI-Key', successorKey)
      .set('Idempotency-Key', '01900000-0000-7000-8000-000000000011')
      .set('X-Validation-Token', oldToken)
      .send({
        schemaVersion: 1,
        courseId,
        questions,
        payloadHash: oldPayloadHash,
        confirmed: true,
      });
    expect(oldTokenWithSuccessor.status).toBe(409);
    expect(oldTokenWithSuccessor.body.error.code).toBe(
      'VALIDATION_TOKEN_INVALID',
    );

    const oldTokenRow = await prisma.prisma.questionValidationToken.findUnique({
      where: { tokenHash: hashToken(oldToken) },
    });
    expect(oldTokenRow?.cliCredentialId).toBe(predecessorId);
    expect(oldTokenRow?.consumedAt).toBeNull();

    const successorValidation = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', successorKey)
      .send({ schemaVersion: 1, courseId, questions });
    expect(successorValidation.status).toBe(201);
    const successorToken = successorValidation.body.data
      .validationToken as string;
    const successorPayloadHash = successorValidation.body.data
      .payloadHash as string;
    const successorConfirmation = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/confirm`)
      .set('X-CLI-Key', successorKey)
      .set('Idempotency-Key', '01900000-0000-7000-8000-000000000012')
      .set('X-Validation-Token', successorToken)
      .send({
        schemaVersion: 1,
        courseId,
        questions,
        payloadHash: successorPayloadHash,
        confirmed: true,
      });
    expect(successorConfirmation.status).toBe(201);

    const list = await admin.agent.get(
      `/api/v1/admin/accounts/${teacher.id}/cli-credentials`,
    );
    expect(list.status).toBe(200);
    const listJson = JSON.stringify(list.body);
    expect(listJson).not.toContain(predecessorKey);
    expect(listJson).not.toContain(successorKey);
    expect(listJson).not.toContain(predecessorHash);
    expect(listJson).not.toContain(successorHash);
    expect(
      list.body.data.every((item: Record<string, unknown>) => !item.rawKey),
    ).toBe(true);

    const rows = await prisma.prisma.cliCredential.findMany({
      where: { accountId: teacher.id },
      orderBy: { createdAt: 'asc' },
    });
    const predecessorRow = rows.find((row) => row.id === predecessorId);
    const successorRow = rows.find((row) => row.id === successorId);
    expect(predecessorRow).toMatchObject({
      accountId: teacher.id,
      scope: 'all_courses',
      status: 'revoked',
      keyHash: predecessorHash,
    });
    expect(predecessorRow?.name).toBe(
      `cp3-manual-key~rotated~${predecessorId}`,
    );
    expect(successorRow).toMatchObject({
      accountId: teacher.id,
      name: 'cp3-manual-key',
      scope: 'all_courses',
      status: 'active',
      keyHash: successorHash,
      rotatedFromId: predecessorId,
    });

    const columns = await prisma.prisma.$queryRaw<
      Array<{ column_name: string }>
    >`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cli_credential'
    `;
    const columnNames = columns.map(({ column_name }) => column_name);
    expect(columnNames).not.toEqual(
      expect.arrayContaining([
        'expires_at',
        'ttl_seconds',
        'grace_period',
        'pending_verification',
        'version',
      ]),
    );

    await stepUp(admin);
    const raceCreated = await admin.agent
      .post(`/api/v1/admin/accounts/${teacher.id}/cli-credentials`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ name: 'cp3-manual-race-key' });
    expect(raceCreated.status).toBe(201);
    const raceId = raceCreated.body.data.id as string;

    const raceResponses = await Promise.all([
      admin.agent
        .post(
          `/api/v1/admin/accounts/${teacher.id}/cli-credentials/${raceId}/rotate`,
        )
        .set('Origin', ORIGIN)
        .set(CSRF_HEADER, admin.csrf),
      admin.agent
        .post(
          `/api/v1/admin/accounts/${teacher.id}/cli-credentials/${raceId}/rotate`,
        )
        .set('Origin', ORIGIN)
        .set(CSRF_HEADER, admin.csrf),
    ]);
    expect(raceResponses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    const winner = raceResponses.find((response) => response.status === 201);
    const loser = raceResponses.find((response) => response.status === 409);
    expect(winner?.body.data.rawKey).toBeTruthy();
    expect(loser?.body.data?.rawKey).toBeUndefined();
    expect(JSON.stringify(loser?.body)).not.toMatch(/keyHash|rawKey/i);

    const raceSuccessors = await prisma.prisma.cliCredential.findMany({
      where: { rotatedFromId: raceId },
    });
    expect(raceSuccessors).toHaveLength(1);
  });
});
