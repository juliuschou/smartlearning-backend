import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { Client } from 'pg';
import { createTestApp } from './setup/app-factory';
import {
  identitySql,
  mutationContract,
  verifyIdentity,
} from './setup/mutation-guard';

jest.setTimeout(30000);

test('restricted application role initializes and returns healthy HTTP 200', async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    verifyIdentity(
      mutationContract('truncate'),
      (await client.query(identitySql)).rows,
    );
    const flags = (
      await client.query(
        `SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls AS elevated FROM pg_roles WHERE rolname=current_user`,
      )
    ).rows as { elevated: boolean }[];
    expect(flags).toEqual([{ elevated: false }]);
  } finally {
    await client.end();
  }
  const app = await createTestApp();
  try {
    await app.init();
    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.checks.db.healthy).toBe(true);
    writeFileSync(
      join(process.env.ISOLATED_LIVE_EVIDENCE!, 'readiness.json'),
      JSON.stringify({
        httpStatus: response.status,
        status: response.body.status,
        dbHealthy: response.body.checks.db.healthy,
        roleRestricted: true,
      }) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
  } finally {
    await app.close();
  }
});
