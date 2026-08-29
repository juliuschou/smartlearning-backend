import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { PrismaService } from '../src/prisma/prisma.service';
import { CSRF_HEADER } from '../src/common/security';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * BE-8.2 CP2 — manual Checkpoint 2 verification (plan §7), run as a DB-backed
 * e2e spec so it uses the proven Nest test harness. Exercises all five manual
 * items over HTTP and inspects DB rows directly.
 */
describe('BE-8.2 CP2 manual Checkpoint 2 verification', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;

  const ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'cp2-manual-admin',
    displayName: 'CP2 Manual Admin',
    password: 'cp2-manual-admin-password-1234',
  };
  const TEACHER = {
    username: 'cp2-manual-teacher',
    displayName: 'CP2 Manual Teacher',
    tempPassword: 'cp2-manual-temp-password-1234',
    password: 'cp2-manual-final-password-1234',
  };

  type Agent = { agent: request.SuperAgentTest; csrf: string };

  beforeAll(async () => {
    try {
      setupTestDb();
    } catch {
      // blocked
    }
    app = await createTestApp();
    await app.init();
    prisma = app.get(PrismaService);
    bootstrap = app.get(BootstrapService);
    try {
      await prisma.prisma.$queryRaw`SELECT 1 FROM account LIMIT 0`;
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
    const v = setCookie
      ?.find((c) => c.startsWith(prefix))
      ?.split(';', 1)[0]
      .slice(prefix.length);
    if (!v) throw new Error(`Missing ${name} cookie`);
    return v;
  }

  async function login(u: string, p: string): Promise<Agent> {
    const agent = request.agent(app.getHttpServer());
    const res = await agent.post('/api/v1/auth/login').send({ username: u, password: p });
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    return { agent: agent as unknown as request.SuperAgentTest, csrf: cookieValue(setCookie, '__Host-csrf') };
  }

  async function adminStepUp(admin: Agent): Promise<void> {
    const res = await admin.agent
      .post('/api/v1/auth/step-up')
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ password: ADMIN.password });
    expect(res.status).toBe(201);
  }

  function requireDatabase(): void {
    if (!dbReachable) {
      throw new Error('BLOCKED: PostgreSQL unavailable for CP2 manual verification.');
    }
  }

  it('CP2 manual checkpoint: all five items', async () => {
    requireDatabase();
    const admin = await login(ADMIN.username, ADMIN.password);
    const adminId = (await admin.agent.get('/api/v1/auth/session')).body.data
      .accountId as string;

    // Create a teacher account.
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
    const teacherId = created.body.data.id as string;

    // Teacher sets a real password and logs in.
    const temp = await login(TEACHER.username, TEACHER.tempPassword);
    const changed = await temp.agent
      .post('/api/v1/auth/change-password')
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, temp.csrf)
      .send({ currentPassword: TEACHER.tempPassword, newPassword: TEACHER.password });
    expect(changed.status).toBe(201);
    const teacher = await login(TEACHER.username, TEACHER.password);

    // ---- Item 1: update before/after DB rows vs response DTO ----
    const before = await prisma.prisma.account.findUnique({ where: { id: teacherId } });
    const upd = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacherId}`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ displayName: 'Renamed Teacher', role: AccountRole.STUDENT, canCreateCourse: false });
    expect(upd.status).toBe(200);
    const after = await prisma.prisma.account.findUnique({ where: { id: teacherId } });
    expect(upd.body.data.displayName).toBe('Renamed Teacher');
    expect(upd.body.data.role).toBe('student');
    expect(upd.body.data.canCreateCourse).toBe(false);
    expect(after?.displayName).toBe('Renamed Teacher');
    expect(after?.role).toBe('student');
    expect(after?.canCreateCourse).toBe(false);
    expect(after?.username).toBe(TEACHER.username);
    expect(after?.status).toBe('active');
    expect(after?.passwordHash).toBe(before?.passwordHash);
    expect(after?.createdAt.getTime()).toBe(before?.createdAt.getTime());

    // ---- Item 2: disabled update rejected, restore then update OK ----
    await adminStepUp(admin);
    const disable = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/disable`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf);
    expect(disable.status).toBe(201);
    const blocked = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacherId}`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ displayName: 'Blocked' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('FORBIDDEN');
    await adminStepUp(admin);
    const restore = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/restore`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf);
    expect(restore.status).toBe(201);
    const afterRestore = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacherId}`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ displayName: 'Restored Name' });
    expect(afterRestore.status).toBe(200);
    expect(afterRestore.body.data.displayName).toBe('Restored Name');

    // Disable revoked the teacher's session; re-login after restore.
    const teacher2 = await login(TEACHER.username, TEACHER.password);

    // ---- Item 3: promotion step-up 403 → step-up → 200 ----
    // Item 2's step-up is still within its 10-minute window, so simulate an
    // expired step-up by clearing stepUpAt on the admin's active session.
    await prisma.prisma.webSession.updateMany({
      where: { accountId: adminId, revokedAt: null },
      data: { stepUpAt: null },
    });
    const noStepUp = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacherId}`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ role: AccountRole.ADMIN });
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body.error.code).toBe('AUTH_STEP_UP_REQUIRED');
    await adminStepUp(admin);
    const promoted = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacherId}`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ role: AccountRole.ADMIN });
    expect(promoted.status).toBe(200);
    expect(promoted.body.data.role).toBe('admin');

    // ---- Item 4: canCreateCourse=false keeps CLI active; disable revokes ----
    // Re-login the teacher now that they are admin (their prior session was
    // created while still a student, so it cannot create courses). Item 1 also
    // set canCreateCourse=false, so re-enable it to allow course creation.
    const teacher3 = await login(TEACHER.username, TEACHER.password);
    await adminStepUp(admin);
    const reenable = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacherId}`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ canCreateCourse: true });
    expect(reenable.status).toBe(200);
    const cli = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/cli-credentials`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ name: 'cp2-manual-key' });
    expect(cli.status).toBe(201);
    const rawKey = cli.body.data.rawKey as string;

    const course = await teacher3.agent
      .post('/api/v1/courses')
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, teacher3.csrf)
      .send({ name: 'CP2 Manual Course' });
    expect(course.status).toBe(201);
    const courseId = course.body.data.id as string;

    const cliBefore = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', rawKey)
      .send({ schemaVersion: 1, courseId, questions: [] });
    expect(cliBefore.status).toBe(201);

    const permOff = await admin.agent
      .patch(`/api/v1/admin/accounts/${teacherId}`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ canCreateCourse: false });
    expect(permOff.status).toBe(200);
    const cliAfterPerm = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', rawKey)
      .send({ schemaVersion: 1, courseId, questions: [] });
    expect(cliAfterPerm.status).toBe(201); // M2 紅卡 #8: permission update does not revoke CLI

    await adminStepUp(admin);
    const disable2 = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/disable`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf);
    expect(disable2.status).toBe(201);
    const cliAfterDisable = await request(app.getHttpServer())
      .post(`/api/v1/courses/${courseId}/question-batches/validate`)
      .set('X-CLI-Key', rawKey)
      .send({ schemaVersion: 1, courseId, questions: [] });
    expect(cliAfterDisable.status).toBe(401);
    expect(cliAfterDisable.body.error.code).toBe('CLI_CREDENTIAL_REVOKED');

    // ---- Item 5: decision points ----
    const selfRole = await admin.agent
      .patch(`/api/v1/admin/accounts/${adminId}`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ role: AccountRole.TEACHER });
    expect(selfRole.status).toBe(403);
    expect(selfRole.body.error.code).toBe('FORBIDDEN');
    const selfName = await admin.agent
      .patch(`/api/v1/admin/accounts/${adminId}`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ displayName: 'Self Renamed Admin' });
    expect(selfName.status).toBe(200);
    // Item 4 disabled the teacher; restore before setting the gate.
    await adminStepUp(admin);
    const restore2 = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/restore`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf);
    expect(restore2.status).toBe(201);
    await adminStepUp(admin);
    const gate = await admin.agent
      .post(`/api/v1/admin/accounts/${teacherId}/require-password-change`)
      .set('Origin', ORIGIN)
      .set(CSRF_HEADER, admin.csrf)
      .send({ mustChangePassword: true });
    expect(gate.status).toBe(201);
    expect(gate.body.data.mustChangePassword).toBe(true);
  });
});
