import { execFileSync } from 'node:child_process';
import { createClient, type RedisClientType } from 'redis';

const backendA = required('CP5_BACKEND_A_URL');
const backendB = required('CP5_BACKEND_B_URL');
const redisUrl = required('CP5_REDIS_URL');
const composeFile = required('CP5_COMPOSE_FILE');
const composeProject = required('CP5_COMPOSE_PROJECT');
const username = required('CP5_ADMIN_USERNAME');
const password = required('CP5_ADMIN_PASSWORD');

const sourceLimit = 5;
const accountLimit = 3;
const rateLimitWindowMs = 15_000;

jest.setTimeout(45_000);

describe('BE-8.5 CP5 manual two-instance verifier', () => {
  let redis: RedisClientType | undefined;

  beforeAll(async () => {
    if (backendA === backendB)
      throw new Error('CP5 backends must be distinct URLs');
    redis = createClient({ url: redisUrl });
    redis.on('error', () => undefined);
    await redis.connect();
    await expectHealth(backendA, 200, 'ok');
    await expectHealth(backendB, 200, 'ok');
  });

  afterAll(async () => {
    if (redis?.isOpen) await redis.close();
  });

  it('shares account and source buckets across backend processes', async () => {
    for (let i = 0; i < accountLimit; i++) {
      expect(
        (
          await login(
            i % 2 === 0 ? backendA : backendB,
            username,
            'wrong-password',
          )
        ).status,
      ).toBe(401);
    }
    expect((await login(backendB, username, 'wrong-password')).status).toBe(
      429,
    );

    await waitForExpiry();
    for (let i = 0; i < sourceLimit; i++) {
      const response = await login(
        i % 2 === 0 ? backendA : backendB,
        `cp5-source-${i}-${Date.now()}`,
        'wrong-password',
      );
      expect(response.status).toBe(401);
    }
    const sourceLimited = await login(
      backendA,
      `cp5-source-final-${Date.now()}`,
      'wrong-password',
    );
    expect(sourceLimited.status).toBe(429);
  });

  it('keeps the anti-enumeration and normalization contracts', async () => {
    await waitForExpiry();
    const variants = [`  ${username.toUpperCase()}  `, username];
    for (let i = 0; i < accountLimit; i++) {
      expect(
        (
          await login(
            i % 2 === 0 ? backendA : backendB,
            variants[i % 2],
            'wrong-password',
          )
        ).status,
      ).toBe(401);
    }
    const existing = await login(backendA, username, 'wrong-password');
    const missingUsername = `cp5-missing-${Date.now()}`;
    const missing = await login(backendB, missingUsername, 'wrong-password');
    const missingAgain = await login(
      backendA,
      missingUsername,
      'wrong-password',
    );
    const missingLimited = await login(
      backendB,
      missingUsername,
      'wrong-password',
    );
    expect(existing.status).toBe(429);
    expect(missing.status).toBe(401);
    expect(missingAgain.status).toBe(401);
    expect(missingLimited.status).toBe(429);
    expect(safeError(existing)).toEqual(safeError(missingLimited));
  });

  it('clears account state on successful login while source history remains', async () => {
    await waitForExpiry();
    for (let i = 0; i < accountLimit - 1; i++) {
      await login(
        i % 2 === 0 ? backendA : backendB,
        username,
        'wrong-password',
      );
    }
    expect((await login(backendB, username, password)).status).toBe(201);
    expect((await login(backendA, username, 'wrong-password')).status).toBe(
      401,
    );
  });

  it('fails closed during Redis outage and recovers without clearing buckets', async () => {
    await waitForExpiry();
    for (let i = 0; i < accountLimit; i++) {
      await login(
        i % 2 === 0 ? backendA : backendB,
        username,
        'wrong-password',
      );
    }
    stopRedis();
    try {
      await expectHealth(backendA, 503, 'degraded');
      await expectHealth(backendB, 503, 'degraded');
      await expectHealth(backendA, 200, 'ok', '/health/live');
      await expectHealth(backendB, 200, 'ok', '/health/live');
      const outage = await login(backendA, username, password);
      expect(outage.status).toBe(503);
      expect(outage.body.data).toBeNull();
      expect(outage.body.error).toMatchObject({
        code: 'AUTH_RATE_LIMIT_UNAVAILABLE',
        blocking: true,
        retryAfterSeconds: null,
      });
      expect(JSON.stringify(outage.body)).not.toMatch(
        /redis|stack|127\.0\.0\.1/i,
      );
    } finally {
      startRedis();
    }

    await waitForReady(backendA);
    await waitForReady(backendB);
    expect((await login(backendB, username, 'wrong-password')).status).toBe(
      429,
    );
    const keys = await scanLoginKeys(redis!);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toMatch(username);
      expect(await redis!.pTTL(key)).toBeGreaterThan(0);
    }
  });
});

async function login(
  baseUrl: string,
  loginUsername: string,
  loginPassword: string,
) {
  const response = await fetch(new URL('/api/v1/auth/login', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: loginUsername, password: loginPassword }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function expectHealth(
  baseUrl: string,
  status: number,
  bodyStatus: string,
  path = '/health/ready',
): Promise<void> {
  const response = await fetch(new URL(path, baseUrl));
  expect(response.status).toBe(status);
  const body = (await response.json()) as { status?: string };
  expect(body.status).toBe(bodyStatus);
}

async function waitForReady(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/health/ready', baseUrl));
      if (response.status === 200) return;
    } catch {
      // Continue polling until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('CP5 backend readiness did not recover within 30 seconds');
}

async function waitForExpiry(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, rateLimitWindowMs + 500));
}

function safeError(response: { body: Record<string, unknown> }): unknown {
  const error = response.body.error as Record<string, unknown> | undefined;
  if (!error) return undefined;
  return {
    code: error.code,
    blocking: error.blocking,
    hasRetryHint: typeof error.retryAfterSeconds === 'number',
  };
}

async function scanLoginKeys(client: RedisClientType): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const result = await client.scan(cursor, {
      MATCH: 'smartlearning:login-rate-limit:v1:{login}:*',
      COUNT: 100,
    });
    cursor = result.cursor;
    keys.push(...result.keys);
  } while (cursor !== '0');
  return keys;
}

function stopRedis(): void {
  execFileSync(
    'docker',
    ['compose', '-f', composeFile, '-p', composeProject, 'stop', 'redis'],
    {
      stdio: 'ignore',
    },
  );
}

function startRedis(): void {
  execFileSync(
    'docker',
    ['compose', '-f', composeFile, '-p', composeProject, 'start', 'redis'],
    {
      stdio: 'ignore',
    },
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`CP5 verifier requires ${name}`);
  return value;
}
