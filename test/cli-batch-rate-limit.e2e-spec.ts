import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashToken } from '../src/common/crypto';
import { CSRF_HEADER } from '../src/common/security';
import { OperationRateLimiterService } from '../src/modules/rate-limit/operation-rate-limiter.service';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * Focused CP4 E2E coverage for per-CLI-credential operation budgets.
 *
 * The suite intentionally overrides the four operation limits before creating
 * the Nest application. It is DB-backed and therefore no-ops when the guarded
 * smartlearning_test database is unavailable, matching the existing E2E
 * fixture convention.
 */

const RATE_ENV = {
  CLI_COURSES_LIST_RATE_LIMIT_MAX: '1',
  CLI_COURSES_LIST_RATE_LIMIT_WINDOW_MS: '1000',
  CLI_COURSES_CREATE_RATE_LIMIT_MAX: '1',
  CLI_COURSES_CREATE_RATE_LIMIT_WINDOW_MS: '1000',
  CLI_BATCH_VALIDATE_RATE_LIMIT_MAX: '1',
  CLI_BATCH_VALIDATE_RATE_LIMIT_WINDOW_MS: '1000',
  CLI_BATCH_CONFIRM_RATE_LIMIT_MAX: '1',
  CLI_BATCH_CONFIRM_RATE_LIMIT_WINDOW_MS: '1000',
};

const TEST_ORIGIN = 'http://localhost:3000';
const ADMIN = {
  username: 'cli-rl-admin',
  displayName: 'CLI Rate Limit Admin',
  password: 'cli-rl-admin-password-1234',
};
const TEACHER = {
  username: 'cli-rl-teacher',
  displayName: 'CLI Rate Limit Teacher',
  tempPassword: 'cli-rl-temp-password-1234',
  password: 'cli-rl-final-password-1234',
};

const BATCH_QUESTIONS = [
  {
    clientRef: 'rate-q1',
    type: 'poll' as const,
    prompt: 'Rate-limit poll',
    selectionMode: 'single' as const,
    options: [
      { optionRef: 'a', text: 'A' },
      { optionRef: 'b', text: 'B' },
    ],
  },
  {
    clientRef: 'rate-q2',
    type: 'open_text' as const,
    prompt: 'Rate-limit open text',
  },
];

const WEB_BATCH_QUESTIONS = [
  {
    clientRef: 'web-rate-q',
    type: 'open_text' as const,
    prompt: 'Web bypass question',
  },
];

type AuthenticatedAgent = {
  agent: request.SuperAgentTest;
  csrfToken: string;
};

type CliCredential = {
  id: string;
  rawKey: string;
};

describe('CLI and question-batch operation rate limits (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let operationLimiter: OperationRateLimiterService;
  let dbReachable = false;
  let migrationsReady = false;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [key, value] of Object.entries(RATE_ENV)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }

    try {
      setupTestDb();
      migrationsReady = true;
    } catch {
      // Keep the suite blocked when PostgreSQL or migrations are unavailable.
    }

    app = await createTestApp();
    await app.init();
    prisma = app.get(PrismaService);
    bootstrap = app.get(BootstrapService);
    operationLimiter = app.get(OperationRateLimiterService);

    if (!migrationsReady) return;
    try {
      await prisma.prisma.$queryRaw`SELECT 1 FROM cli_credential LIMIT 0`;
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    await withQuiescedLiveSessionPublisher(app, () =>
      truncateAll(prisma.prisma),
    );
    operationLimiter.reset();
    await bootstrap.createFirstAdmin(ADMIN);
  });

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error(
        'BLOCKED: PostgreSQL migration/schema is unavailable for CLI rate-limit e2e tests.',
      );
    }
  }

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
    expect(response.status).toBe(201);
    return {
      agent: agent as unknown as request.SuperAgentTest,
      csrfToken: cookieValue(
        cookieHeaders(response.headers['set-cookie']),
        '__Host-csrf',
      ),
    };
  }

  async function createTeacher(): Promise<{
    admin: AuthenticatedAgent;
    teacher: AuthenticatedAgent;
    teacherId: string;
  }> {
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

    return {
      admin,
      teacher: await loginAs(TEACHER.username, TEACHER.password),
      teacherId: created.body.data.id as string,
    };
  }

  async function adminStepUp(admin: AuthenticatedAgent): Promise<void> {
    const response = await admin.agent
      .post('/api/v1/auth/step-up')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ password: ADMIN.password });
    expect(response.status).toBe(201);
  }

  async function createCliCredential(
    admin: AuthenticatedAgent,
    teacherId: string,
    name: string,
  ): Promise<CliCredential> {
    await adminStepUp(admin);
    const response = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/cli-credentials`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, admin.csrfToken)
      .send({ name });
    expect(response.status).toBe(201);
    return {
      id: response.body.data.id as string,
      rawKey: response.body.data.rawKey as string,
    };
  }

  async function createCourse(teacher: AuthenticatedAgent): Promise<string> {
    const response = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Rate-limit course' });
    expect(response.status).toBe(201);
    return response.body.data.id as string;
  }

  function cliRequest(method: 'get' | 'post', path: string, key: string) {
    return request(app.getHttpServer())[method](path).set('X-CLI-Key', key);
  }

  function expectRateLimited(response: request.Response): void {
    expect(response.status).toBe(429);
    expect(response.body.data).toBeNull();
    expect(response.body.error.code).toBe('RATE_LIMITED');
    expect(response.body.error.retryAfterSeconds).toEqual(expect.any(Number));
    expect(response.body.error.retryAfterSeconds).toBeGreaterThan(0);
  }

  it('isolates credentials and policies, while Web collection actors bypass CLI budgets', async () => {
    requireDatabase();
    const { admin, teacher, teacherId } = await createTeacher();
    const credentialA = await createCliCredential(admin, teacherId, 'rate-a');
    const credentialB = await createCliCredential(admin, teacherId, 'rate-b');
    const courseId = await createCourse(teacher);

    const listA = await cliRequest(
      'get',
      '/api/v1/courses',
      credentialA.rawKey,
    );
    expect(listA.status).toBe(200);
    expect(listA.body.data.data).toEqual([
      expect.objectContaining({ status: 'draft' }),
    ]);

    const limitedListA = await cliRequest(
      'get',
      '/api/v1/courses',
      credentialA.rawKey,
    );
    expectRateLimited(limitedListA);

    // A second credential has its own bucket for the same operation policy.
    const listB = await cliRequest(
      'get',
      '/api/v1/courses',
      credentialB.rawKey,
    );
    expect(listB.status).toBe(200);

    // The create policy is independent from the exhausted list policy.
    const createA = await cliRequest(
      'post',
      '/api/v1/courses',
      credentialA.rawKey,
    ).send({ name: 'CLI-created course' });
    expect(createA.status).toBe(201);
    expect(createA.body.data).toEqual({
      id: expect.any(String),
      name: 'CLI-created course',
      status: 'draft',
    });

    const limitedCreateA = await cliRequest(
      'post',
      '/api/v1/courses',
      credentialA.rawKey,
    ).send({ name: 'rejected CLI course' });
    expectRateLimited(limitedCreateA);

    // Web requests do not consume or observe CLI credential buckets.
    const webList = await teacher.agent.get('/api/v1/courses');
    expect(webList.status).toBe(200);
    const webCreate = await teacher.agent
      .post('/api/v1/courses')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({ name: 'Web-bypass course' });
    expect(webCreate.status).toBe(201);

    const courses = await prisma.prisma.course.findMany({
      where: { ownerAccountId: teacherId },
      orderBy: { name: 'asc' },
      select: { name: true },
    });
    expect(courses.map(({ name }) => name)).toEqual([
      'CLI-created course',
      'Rate-limit course',
      'Web-bypass course',
    ]);
    expect(courseId).toEqual(expect.any(String));
  });

  it('rejects rate-limited create, validate, and confirm without DB side effects', async () => {
    requireDatabase();
    const { admin, teacher, teacherId } = await createTeacher();
    const credentialA = await createCliCredential(
      admin,
      teacherId,
      'side-effect-a',
    );
    const credentialB = await createCliCredential(
      admin,
      teacherId,
      'side-effect-b',
    );
    const courseId = await createCourse(teacher);

    const created = await cliRequest(
      'post',
      '/api/v1/courses',
      credentialA.rawKey,
    ).send({ name: 'first CLI course' });
    expect(created.status).toBe(201);
    const courseCountBeforeLimitedCreate = await prisma.prisma.course.count({
      where: { ownerAccountId: teacherId },
    });
    const limitedCreate = await cliRequest(
      'post',
      '/api/v1/courses',
      credentialA.rawKey,
    ).send({ name: 'must not persist' });
    expectRateLimited(limitedCreate);
    expect(
      await prisma.prisma.course.count({
        where: { ownerAccountId: teacherId },
      }),
    ).toBe(courseCountBeforeLimitedCreate);

    const firstValidate = await cliRequest(
      'post',
      `/api/v1/courses/${courseId}/question-batches/validate`,
      credentialA.rawKey,
    ).send({ schemaVersion: 1, courseId, questions: BATCH_QUESTIONS });
    expect(firstValidate.status).toBe(201);
    const validationTokenA = firstValidate.body.data.validationToken as string;
    const payloadHashA = firstValidate.body.data.payloadHash as string;
    const tokenCountBeforeLimitedValidate =
      await prisma.prisma.questionValidationToken.count({
        where: { cliCredentialId: credentialA.id },
      });

    const limitedValidate = await cliRequest(
      'post',
      `/api/v1/courses/${courseId}/question-batches/validate`,
      credentialA.rawKey,
    ).send({ schemaVersion: 1, courseId, questions: BATCH_QUESTIONS });
    expectRateLimited(limitedValidate);
    expect(
      await prisma.prisma.questionValidationToken.count({
        where: { cliCredentialId: credentialA.id },
      }),
    ).toBe(tokenCountBeforeLimitedValidate);

    // The second credential has an independent validation budget and token.
    const validateB = await cliRequest(
      'post',
      `/api/v1/courses/${courseId}/question-batches/validate`,
      credentialB.rawKey,
    ).send({ schemaVersion: 1, courseId, questions: BATCH_QUESTIONS });
    expect(validateB.status).toBe(201);
    const tokenB = validateB.body.data.validationToken as string;
    const hashB = validateB.body.data.payloadHash as string;

    // Consume only the confirm bucket with a service-level rejected request.
    const consumeConfirmBudget = await cliRequest(
      'post',
      `/api/v1/courses/${courseId}/question-batches/confirm`,
      credentialA.rawKey,
    )
      .set('Idempotency-Key', '01900000-0000-7000-8000-000000000101')
      .send({
        schemaVersion: 1,
        courseId,
        questions: BATCH_QUESTIONS,
        payloadHash: payloadHashA,
        confirmed: true,
      });
    expect(consumeConfirmBudget.status).toBe(409);
    expect(consumeConfirmBudget.body.error.code).toBe(
      'VALIDATION_TOKEN_INVALID',
    );

    const questionCountBeforeLimitedConfirm =
      await prisma.prisma.questionDefinition.count({ where: { courseId } });
    const idempotencyCountBeforeLimitedConfirm =
      await prisma.prisma.questionBatchIdempotency.count({
        where: { actorScope: `cli:${credentialA.id}` },
      });
    const reservedIdempotencyKey = '01900000-0000-7000-8000-000000000102';
    const limitedConfirm = await cliRequest(
      'post',
      `/api/v1/courses/${courseId}/question-batches/confirm`,
      credentialA.rawKey,
    )
      .set('Idempotency-Key', reservedIdempotencyKey)
      .set('X-Validation-Token', validationTokenA)
      .send({
        schemaVersion: 1,
        courseId,
        questions: BATCH_QUESTIONS,
        payloadHash: payloadHashA,
        confirmed: true,
      });
    expectRateLimited(limitedConfirm);
    expect(
      await prisma.prisma.questionDefinition.count({ where: { courseId } }),
    ).toBe(questionCountBeforeLimitedConfirm);
    expect(
      await prisma.prisma.questionBatchIdempotency.count({
        where: { actorScope: `cli:${credentialA.id}` },
      }),
    ).toBe(idempotencyCountBeforeLimitedConfirm);
    const tokenAAfterLimitedConfirm =
      await prisma.prisma.questionValidationToken.findUnique({
        where: { tokenHash: hashToken(validationTokenA) },
      });
    expect(tokenAAfterLimitedConfirm?.consumedAt).toBeNull();

    // Confirm has an independent per-credential bucket: credential B succeeds.
    const confirmB = await cliRequest(
      'post',
      `/api/v1/courses/${courseId}/question-batches/confirm`,
      credentialB.rawKey,
    )
      .set('Idempotency-Key', '01900000-0000-7000-8000-000000000103')
      .set('X-Validation-Token', tokenB)
      .send({
        schemaVersion: 1,
        courseId,
        questions: BATCH_QUESTIONS,
        payloadHash: hashB,
        confirmed: true,
      });
    expect(confirmB.status).toBe(201);

    // Web batch actors bypass both exhausted CLI batch policies.
    const webValidate = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .send({
        schemaVersion: 1,
        courseId,
        questions: WEB_BATCH_QUESTIONS,
      });
    expect(webValidate.status).toBe(201);
    const webToken = webValidate.body.data.validationToken as string;
    const webHash = webValidate.body.data.payloadHash as string;
    const webConfirm = await teacher.agent
      .post(`/api/v1/courses/${courseId}/question-batches/confirm`)
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, teacher.csrfToken)
      .set('Idempotency-Key', '01900000-0000-7000-8000-000000000104')
      .set('X-Validation-Token', webToken)
      .send({
        schemaVersion: 1,
        courseId,
        questions: WEB_BATCH_QUESTIONS,
        payloadHash: webHash,
        confirmed: true,
      });
    expect(webConfirm.status).toBe(201);
  });

  it('recovers after a real-clock window using a reserved token and idempotency key', async () => {
    requireDatabase();
    const { admin, teacher, teacherId } = await createTeacher();
    const credential = await createCliCredential(admin, teacherId, 'expiry');
    const courseId = await createCourse(teacher);

    const validate = await cliRequest(
      'post',
      `/api/v1/courses/${courseId}/question-batches/validate`,
      credential.rawKey,
    ).send({ schemaVersion: 1, courseId, questions: BATCH_QUESTIONS });
    expect(validate.status).toBe(201);
    const validationToken = validate.body.data.validationToken as string;
    const payloadHash = validate.body.data.payloadHash as string;
    const reservedIdempotencyKey = '01900000-0000-7000-8000-000000000105';

    // This rejected request consumes the confirm bucket but reserves neither
    // the validation token nor the idempotency record.
    const rejected = await cliRequest(
      'post',
      `/api/v1/courses/${courseId}/question-batches/confirm`,
      credential.rawKey,
    )
      .set('Idempotency-Key', reservedIdempotencyKey)
      .send({
        schemaVersion: 1,
        courseId,
        questions: BATCH_QUESTIONS,
        payloadHash,
        confirmed: true,
      });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe('VALIDATION_TOKEN_INVALID');

    const limited = await cliRequest(
      'post',
      `/api/v1/courses/${courseId}/question-batches/confirm`,
      credential.rawKey,
    )
      .set('Idempotency-Key', reservedIdempotencyKey)
      .set('X-Validation-Token', validationToken)
      .send({
        schemaVersion: 1,
        courseId,
        questions: BATCH_QUESTIONS,
        payloadHash,
        confirmed: true,
      });
    expectRateLimited(limited);
    expect(
      await prisma.prisma.questionBatchIdempotency.count({
        where: {
          actorScope: `cli:${credential.id}`,
          idempotencyKey: reservedIdempotencyKey,
        },
      }),
    ).toBe(0);
    expect(
      (
        await prisma.prisma.questionValidationToken.findUnique({
          where: { tokenHash: hashToken(validationToken) },
        })
      )?.consumedAt,
    ).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const recovered = await cliRequest(
      'post',
      `/api/v1/courses/${courseId}/question-batches/confirm`,
      credential.rawKey,
    )
      .set('Idempotency-Key', reservedIdempotencyKey)
      .set('X-Validation-Token', validationToken)
      .send({
        schemaVersion: 1,
        courseId,
        questions: BATCH_QUESTIONS,
        payloadHash,
        confirmed: true,
      });
    expect(recovered.status).toBe(201);
    expect(recovered.body.data.questions).toHaveLength(2);
    expect(
      await prisma.prisma.questionBatchIdempotency.count({
        where: {
          actorScope: `cli:${credential.id}`,
          idempotencyKey: reservedIdempotencyKey,
        },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.prisma.questionValidationToken.findUnique({
          where: { tokenHash: hashToken(validationToken) },
        })
      )?.consumedAt,
    ).toBeInstanceOf(Date);
  });
});
