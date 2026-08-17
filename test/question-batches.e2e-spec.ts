import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

describe('Question batches (validate/confirm) (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'batch-e2e-admin',
    displayName: 'Batch E2E Admin',
    password: 'batch-e2e-admin-password-1234',
  };
  const TEACHER = {
    username: 'batch-e2e-teacher',
    displayName: 'Batch E2E Teacher',
    tempPassword: 'batch-e2e-temp-password-1234',
    password: 'batch-e2e-final-password-1234',
  };

  type AuthenticatedAgent = {
    agent: request.SuperAgentTest;
    csrfToken: string;
  };

  beforeAll(async () => {
    try {
      setupTestDb();
      migrationsReady = true;
    } catch {
      // blocked
    }
    app = await createTestApp();
    await app.init();
    prisma = app.get(PrismaService);
    bootstrap = app.get(BootstrapService);
    if (!migrationsReady) return;
    try {
      await prisma.prisma
        .$queryRaw`SELECT 1 FROM question_batch_idempotency LIMIT 0`;
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
    await bootstrap.createFirstAdmin(ADMIN);
  });

  function cookieHeaders(value: string | string[] | undefined): string[] {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  }

  function cookieValue(setCookie: string[] | undefined, name: string): string {
    const prefix = `${name}=`;
    const value = setCookie
      ?.find((cookie) => cookie.startsWith(prefix))
      ?.split(';', 1)[0]
      .slice(prefix.length);
    if (!value) throw new Error(`Missing ${name} cookie`);
    return value;
  }

  async function loginAs(
    username: string,
    password: string,
  ): Promise<AuthenticatedAgent> {
    const agent = request.agent(app.getHttpServer());
    const response = await agent
      .post('/api/v1/auth/login')
      .send({ username, password });
    const setCookie = cookieHeaders(response.headers['set-cookie']);
    return {
      agent: agent as unknown as request.SuperAgentTest,
      csrfToken: cookieValue(setCookie, '__Host-csrf'),
    };
  }

  async function createTeacher(): Promise<AuthenticatedAgent> {
    const admin = await loginAs(ADMIN.username, ADMIN.password);
    const created = await admin.agent
      .post('/api/v1/admin/accounts')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({
        username: TEACHER.username,
        displayName: TEACHER.displayName,
        role: AccountRole.TEACHER,
        canCreateCourse: true,
        tempPassword: TEACHER.tempPassword,
      });
    expect(created.status).toBe(201);

    const temporary = await loginAs(TEACHER.username, TEACHER.tempPassword);
    const changed = await temporary.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, temporary.csrfToken)
      .send({
        currentPassword: TEACHER.tempPassword,
        newPassword: TEACHER.password,
      });
    expect(changed.status).toBe(201);
    return loginAs(TEACHER.username, TEACHER.password);
  }

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL migration/schema is unavailable for batch e2e tests.',
      );
    }
  }

  async function createCourse(teacher: AuthenticatedAgent): Promise<string> {
    const res = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Batch Course' });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  const BATCH_QUESTIONS = [
    {
      clientRef: 'q1',
      type: 'poll' as const,
      prompt: '批次題 1',
      selectionMode: 'single' as const,
      options: [
        { optionRef: 'a', text: 'A' },
        { optionRef: 'b', text: 'B' },
      ],
    },
    {
      clientRef: 'q2',
      type: 'open_text' as const,
      prompt: '批次題 2',
    },
  ];

  it('validates then confirms a batch, appending questions in preview order', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    const validate = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ schemaVersion: 1, courseId, questions: BATCH_QUESTIONS });
    expect(validate.status).toBe(201);
    expect(validate.body.data.valid).toBe(true);
    expect(validate.body.data.payloadHash).toBeTruthy();
    expect(validate.body.data.validationToken).toBeTruthy();
    expect(validate.body.data.expiresAt).toBeTruthy();
    const payloadHash = validate.body.data.payloadHash as string;
    const validationToken = validate.body.data.validationToken as string;

    const confirm = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/confirm`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .set('Idempotency-Key', '01900000-0000-7000-8000-000000000001')
      .set('X-Validation-Token', validationToken)
      .send({
        schemaVersion: 1,
        courseId,
        questions: BATCH_QUESTIONS,
        payloadHash,
        confirmed: true,
      });
    expect(confirm.status).toBe(201);
    expect(confirm.body.data.payloadHash).toBe(payloadHash);
    expect(confirm.body.data.questions).toHaveLength(2);
    // Appended in preview order: poll at position 1, open_text at position 2.
    expect(confirm.body.data.questions[0].type).toBe('poll');
    expect(confirm.body.data.questions[1].type).toBe('open_text');

    // Questions are persisted.
    const list = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions`,
    );
    expect(list.body.data.data).toHaveLength(2);
    // Raw validation token never echoed.
    expect(JSON.stringify(confirm.body)).not.toContain(validationToken);
  });

  it('replays the same idempotency key + payload without duplicate writes', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    const validate = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ schemaVersion: 1, courseId, questions: BATCH_QUESTIONS });
    const payloadHash = validate.body.data.payloadHash as string;
    const validationToken = validate.body.data.validationToken as string;

    const idempotencyKey = '01900000-0000-7000-8000-000000000002';
    const confirm1 = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/confirm`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .set('Idempotency-Key', idempotencyKey)
      .set('X-Validation-Token', validationToken)
      .send({
        schemaVersion: 1,
        courseId,
        questions: BATCH_QUESTIONS,
        payloadHash,
        confirmed: true,
      });
    expect(confirm1.status).toBe(201);

    // A second validate is needed because the first token was consumed.
    const validate2 = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ schemaVersion: 1, courseId, questions: BATCH_QUESTIONS });
    const token2 = validate2.body.data.validationToken as string;

    // Replay same idempotency key + same payload (different token, same hash).
    const confirm2 = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/confirm`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .set('Idempotency-Key', idempotencyKey)
      .set('X-Validation-Token', token2)
      .send({
        schemaVersion: 1,
        courseId,
        questions: BATCH_QUESTIONS,
        payloadHash,
        confirmed: true,
      });
    expect(confirm2.status).toBe(201);
    // Replayed the original result — no duplicate writes.
    const list = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions`,
    );
    expect(list.body.data.data).toHaveLength(2);
  });

  it('rejects confirm with mismatched idempotency key payload (409)', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    const validate = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ schemaVersion: 1, courseId, questions: BATCH_QUESTIONS });
    const payloadHash = validate.body.data.payloadHash as string;
    const validationToken = validate.body.data.validationToken as string;

    const idempotencyKey = '01900000-0000-7000-8000-000000000003';
    await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/confirm`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .set('Idempotency-Key', idempotencyKey)
      .set('X-Validation-Token', validationToken)
      .send({
        schemaVersion: 1,
        courseId,
        questions: BATCH_QUESTIONS,
        payloadHash,
        confirmed: true,
      });

    // Re-validate for a DIFFERENT payload.
    const otherQuestions = [
      { clientRef: 'x', type: 'open_text', prompt: '其他題' },
    ];
    const validate2 = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ schemaVersion: 1, courseId, questions: otherQuestions });
    const token2 = validate2.body.data.validationToken as string;
    const hash2 = validate2.body.data.payloadHash as string;

    // Reuse the idempotency key with a different hash → 409.
    const conflict = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/confirm`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .set('Idempotency-Key', idempotencyKey)
      .set('X-Validation-Token', token2)
      .send({
        schemaVersion: 1,
        courseId,
        questions: otherQuestions,
        payloadHash: hash2,
        confirmed: true,
      });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('rejects confirm without a validation token (409)', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    const confirm = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/confirm`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .set('Idempotency-Key', '01900000-0000-7000-8000-000000000004')
      .send({
        schemaVersion: 1,
        courseId,
        questions: BATCH_QUESTIONS,
        payloadHash: 'sha256:fake',
        confirmed: true,
      });
    expect(confirm.status).toBe(409);
    expect(confirm.body.error.code).toBe('VALIDATION_TOKEN_INVALID');
  });

  it('rejects confirm with a payloadHash that does not match the questions (409)', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    const validate = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ schemaVersion: 1, courseId, questions: BATCH_QUESTIONS });
    const validationToken = validate.body.data.validationToken as string;

    const confirm = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/confirm`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .set('Idempotency-Key', '01900000-0000-7000-8000-000000000005')
      .set('X-Validation-Token', validationToken)
      .send({
        schemaVersion: 1,
        courseId,
        questions: BATCH_QUESTIONS,
        payloadHash: 'sha256:mismatched',
        confirmed: true,
      });
    expect(confirm.status).toBe(409);
    expect(confirm.body.error.code).toBe('PAYLOAD_HASH_MISMATCH');
  });

  it('all-or-nothing: an invalid question in the batch is not persisted', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    // q2 is an invalid open_text with options (forbidden).
    const invalidBatch = [
      {
        clientRef: 'q1',
        type: 'poll',
        prompt: '有效題',
        selectionMode: 'single',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      },
      {
        clientRef: 'q2',
        type: 'open_text',
        prompt: '無效題',
        options: [
          { optionRef: 'a', text: 'A' },
          { optionRef: 'b', text: 'B' },
        ],
      },
    ];

    const validate = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ schemaVersion: 1, courseId, questions: invalidBatch });
    expect(validate.status).toBe(201);
    expect(validate.body.data.valid).toBe(false);
    expect(validate.body.data.validationToken).toBeNull();
    // No questions persisted by validate.
    const list = await teacher.agent.get(
      `/api/v1/courses/${courseId}/questions`,
    );
    expect(list.body.data.data).toHaveLength(0);
  });

  it('requires CSRF for Web batch validate', async () => {
    requireDatabase();
    const teacher = await createTeacher();
    const courseId = await createCourse(teacher);

    const validate = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .send({ schemaVersion: 1, courseId, questions: BATCH_QUESTIONS });
    expect(validate.status).toBe(403);
    expect(validate.body.error.code).toBe('AUTH_CSRF_INVALID');
  });
});
