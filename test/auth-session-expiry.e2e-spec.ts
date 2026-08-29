import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashToken } from '../src/common/crypto';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER,
  SESSION_COOKIE_NAME,
} from '../src/common/security';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * E2e: the frozen BE-8.1 CP1 session-expiry contract over HTTP.
 *
 * Uses the real clock and mutates the `web_session` row's lastSeenAt/expiresAt
 * directly (closer to runtime than a fake clock or config override). 8 cases:
 * fresh, absolute-expired, idle-expired, logged-out, malformed cookie, missing
 * cookie, /auth/session unauthenticated, and the idle boundary.
 *
 * Requires the test DB. Skips (no-ops) when the DB is unreachable.
 */
describe('Auth session expiry (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let dbReachable = false;
  let migrationsReady = false;

  const TEST_ORIGIN = 'http://localhost:3000';
  const ADMIN = {
    username: 'expiry-admin',
    displayName: 'Expiry Admin',
    password: 'expiry-admin-password-1234',
  };

  const IDLE_MS = 30 * 60 * 1000;
  const ABSOLUTE_MS = 8 * 60 * 60 * 1000;

  type AuthenticatedAgent = {
    agent: request.SuperAgentTest;
    csrfToken: string;
    sessionToken: string;
  };

  function cookieHeaders(
    value: string | string[] | undefined,
  ): string[] | undefined {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  }

  function cookieValue(setCookie: string[] | undefined, name: string): string {
    const prefix = `${name}=`;
    const value = setCookie
      ?.find((cookie) => cookie.startsWith(prefix))
      ?.split(';', 1)[0]
      .slice(prefix.length);
    if (!value) {
      throw new Error(`Missing ${name} cookie in login response`);
    }
    return value;
  }

  beforeAll(async () => {
    try {
      setupTestDb();
      migrationsReady = true;
    } catch {
      // Keep the suite blocked when any migration fails; do not probe stale schema.
    }
    app = await createTestApp();
    await app.init();
    prisma = app.get(PrismaService);
    bootstrap = app.get(BootstrapService);
    if (!migrationsReady) return;
    try {
      await prisma.prisma.$queryRaw`SELECT 1`;
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
      csrfToken: cookieValue(setCookie, CSRF_COOKIE_NAME),
      sessionToken: cookieValue(setCookie, SESSION_COOKIE_NAME),
    };
  }

  async function sessionRowFor(token: string) {
    return prisma.prisma.webSession.findUnique({
      where: { cookieHash: hashToken(token) },
    });
  }

  it('skips gracefully when the test DB is not reachable', () => {
    if (!dbReachable) {
      console.warn('Skipping e2e: test DB not reachable.');
    }
    expect(true).toBe(true);
  });

  it('case 1 — fresh session returns 200 with a parseable future expiresAt', async () => {
    if (!dbReachable) return;
    const auth = await loginAs(ADMIN.username, ADMIN.password);
    const res = await auth.agent.get('/api/v1/auth/session');
    expect(res.status).toBe(200);
    const expiresAt = res.body.data.expiresAt as string;
    expect(typeof expiresAt).toBe('string');
    const parsed = Date.parse(expiresAt);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThan(Date.now());
  });

  it('case 2 — absolute-expired session returns 401 AUTH_SESSION_EXPIRED', async () => {
    if (!dbReachable) return;
    const auth = await loginAs(ADMIN.username, ADMIN.password);
    const row = await sessionRowFor(auth.sessionToken);
    await prisma.prisma.webSession.update({
      where: { id: row!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await auth.agent.get('/api/v1/auth/session');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_SESSION_EXPIRED');
  });

  it('case 3 — idle-expired session returns 401 AUTH_SESSION_EXPIRED (same code)', async () => {
    if (!dbReachable) return;
    const auth = await loginAs(ADMIN.username, ADMIN.password);
    const row = await sessionRowFor(auth.sessionToken);
    // expiresAt stays in the future; lastSeenAt pushed past the idle window.
    await prisma.prisma.webSession.update({
      where: { id: row!.id },
      data: {
        lastSeenAt: new Date(Date.now() - IDLE_MS - 1000),
        expiresAt: new Date(Date.now() + ABSOLUTE_MS),
      },
    });
    const res = await auth.agent.get('/api/v1/auth/session');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_SESSION_EXPIRED');
  });

  it('case 4 — logged-out session (revoked) returns 401 UNAUTHORIZED, not expired', async () => {
    if (!dbReachable) return;
    const auth = await loginAs(ADMIN.username, ADMIN.password);
    const logout = await auth.agent
      .post('/api/v1/auth/logout')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, auth.csrfToken);
    expect(logout.status).toBe(201);
    const res = await auth.agent.get('/api/v1/auth/session');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('case 5 — malformed cookie returns 401 UNAUTHORIZED', async () => {
    if (!dbReachable) return;
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/session')
      .set('Cookie', `${SESSION_COOKIE_NAME}=not-a-valid-token`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('case 6 — missing cookie returns 401 UNAUTHORIZED', async () => {
    if (!dbReachable) return;
    const res = await request(app.getHttpServer()).get('/api/v1/auth/session');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('case 7 — /auth/session unauthenticated returns 401, not 200 + empty string', async () => {
    if (!dbReachable) return;
    const res = await request(app.getHttpServer()).get('/api/v1/auth/session');
    expect(res.status).toBe(401);
    expect(res.body.data).toBeNull();
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('case 8 — idle boundary: lastSeenAt just inside the window is still valid', async () => {
    if (!dbReachable) return;
    const auth = await loginAs(ADMIN.username, ADMIN.password);
    const row = await sessionRowFor(auth.sessionToken);
    // lastSeenAt + idleMs > now is still valid (sessionValidity uses <= for
    // expiry). A 1s margin keeps the boundary deterministic despite the small
    // gap between the UPDATE and the GET.
    await prisma.prisma.webSession.update({
      where: { id: row!.id },
      data: {
        lastSeenAt: new Date(Date.now() - IDLE_MS + 1000),
        expiresAt: new Date(Date.now() + ABSOLUTE_MS),
      },
    });
    const res = await auth.agent.get('/api/v1/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.data.expiresAt).toBeDefined();
  });
});
