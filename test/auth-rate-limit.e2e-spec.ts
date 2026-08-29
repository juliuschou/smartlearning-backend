import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountStatus } from '../src/modules/identity/domain/account-status';
import { PrismaService } from '../src/prisma/prisma.service';
import { RateLimiterService } from '../src/modules/rate-limit/rate-limiter.service';
import {
  createTestApp,
  withQuiescedLiveSessionPublisher,
} from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * E2e: login rate limit (US-F7 / R-F7-7).
 *
 * Verifies:
 *  - repeated wrong passwords on one account → eventually 429 RATE_LIMITED
 *    with retryAfterSeconds.
 *  - the RATE_LIMITED error does not leak account existence (same shape for a
 *    missing account under the same source budget).
 *  - limit is not permanent: after the window elapses, login works again.
 *  - a successful login clears the account-scope counter.
 *
 * Requires the migrated smartlearning_test DB; no-ops when unreachable.
 *
 * NOTE on source scope in tests: supertest requests all share the loopback IP,
 * so the source scope is shared across this whole suite. The source window is
 * kept short and the max is above the account max for account-focused cases;
 * a dedicated case below proves distinct usernames share the source budget.
 */

const RATE_ENV = {
  LOGIN_RATE_LIMIT_ACCOUNT_MAX: '3',
  LOGIN_RATE_LIMIT_ACCOUNT_WINDOW_MS: '1000',
  LOGIN_RATE_LIMIT_SOURCE_MAX: '5',
  LOGIN_RATE_LIMIT_SOURCE_WINDOW_MS: '1000',
};

describe('Auth rate limit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let rateLimiter: RateLimiterService;
  let dbReachable = false;
  let migrationsReady = false;
  const savedEnv: Record<string, string | undefined> = {};

  const ADMIN = {
    username: 'rl-admin',
    displayName: 'RL Admin',
    password: 'rl-admin-password-1234',
  };

  beforeAll(async () => {
    // Apply a small rate-limit config for this suite only.
    for (const [k, v] of Object.entries(RATE_ENV)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      setupTestDb();
      migrationsReady = true;
    } catch {
      // keep suite blocked
    }
    app = await createTestApp();
    await app.init();
    prisma = app.get(PrismaService);
    bootstrap = app.get(BootstrapService);
    rateLimiter = app.get(RateLimiterService);
    if (!migrationsReady) return;
    try {
      await prisma.prisma.$queryRaw`SELECT 1`;
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (app) await app.close();
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    await withQuiescedLiveSessionPublisher(app, () =>
      truncateAll(prisma.prisma),
    );
    rateLimiter.reset();
    await bootstrap.createFirstAdmin(ADMIN);
  });

  function login(username: string, password: string) {
    return request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ username, password });
  }

  it('returns 401 AUTH_INVALID_CREDENTIALS on a wrong password (not yet limited)', async () => {
    if (!dbReachable) return;
    const res = await login(ADMIN.username, 'wrong-password-xxxx');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('limits after the account-scope max failed attempts (429 RATE_LIMITED)', async () => {
    if (!dbReachable) return;
    // accountMax=3 → 3 failures then the 4th attempt is limited.
    for (let i = 0; i < 3; i++) {
      const res = await login(ADMIN.username, 'wrong-password-xxxx');
      expect(res.status).toBe(401);
    }
    const res = await login(ADMIN.username, 'wrong-password-xxxx');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(typeof res.body.error.retryAfterSeconds).toBe('number');
    expect(res.body.error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('does not permanently lock out — login works after the window elapses', async () => {
    if (!dbReachable) return;
    for (let i = 0; i < 3; i++) {
      await login(ADMIN.username, 'wrong-password-xxxx');
    }
    const limited = await login(ADMIN.username, 'wrong-password-xxxx');
    expect(limited.status).toBe(429);
    // Window is 1000ms; wait for it to decay.
    await new Promise((r) => setTimeout(r, 1100));
    // Correct password after decay → success (no permanent lockout).
    const ok = await login(ADMIN.username, ADMIN.password);
    expect(ok.status).toBe(201);
    expect(ok.body.data.username).toBe(ADMIN.username);
  });

  it('a successful login clears the account-scope counter', async () => {
    if (!dbReachable) return;
    // Two failures (under the 3 max), then a successful login clears the
    // account counter so a subsequent burst can start fresh.
    await login(ADMIN.username, 'wrong-password-xxxx');
    await login(ADMIN.username, 'wrong-password-xxxx');
    const ok = await login(ADMIN.username, ADMIN.password);
    expect(ok.status).toBe(201);
    // Two more failures should still be under the limit (counter was cleared).
    await login(ADMIN.username, 'wrong-password-xxxx');
    await login(ADMIN.username, 'wrong-password-xxxx');
    const notLimited = await login(ADMIN.username, 'wrong-password-xxxx');
    expect(notLimited.status).toBe(401); // 3rd failure → 401, not 429
  });

  it('RATE_LIMITED does not reveal whether the account exists', async () => {
    if (!dbReachable) return;
    // Exhaust the account budget on a NON-existent account and confirm the
    // same RATE_LIMITED shape (the account key is independent of existence).
    const ghost = 'nonexistent-user-xyz';
    for (let i = 0; i < 3; i++) {
      await login(ghost, 'wrong-password-xxxx');
    }
    const res = await login(ghost, 'wrong-password-xxxx');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    // The envelope must not include any account-existence hint.
    expect(res.body.data).toBeNull();
  });

  it('shares the source budget across distinct account identifiers', async () => {
    if (!dbReachable) return;
    // Each account remains below accountMax; the shared loopback source reaches
    // sourceMax=5 and the next distinct username is rate-limited.
    for (let i = 0; i < 5; i++) {
      const res = await login(`source-ghost-${i}`, 'wrong-password-xxxx');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    }
    const res = await login('source-ghost-final', 'wrong-password-xxxx');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.data).toBeNull();
  });

  it('still rate-limits a disabled account (no existence leak via rate)', async () => {
    if (!dbReachable) return;
    await prisma.prisma.account.update({
      where: { username: ADMIN.username },
      data: { status: AccountStatus.DISABLED, disabledAt: new Date() },
    });

    // Disabled account login returns the same generic 401 as other failures;
    // both scopes must still consume the failure budget before the 429 gate.
    for (let i = 0; i < 3; i++) {
      const res = await login(ADMIN.username, 'wrong-password-xxxx');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    }
    const res = await login(ADMIN.username, 'wrong-password-xxxx');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });
});
