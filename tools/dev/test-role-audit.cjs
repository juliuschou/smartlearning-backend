'use strict';
// Read-only capability audit after a separately authorized isolated lifecycle start.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Client } = require('pg');
async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  const bytes = fs.readFileSync(process.env.TEST_DB_CONTRACT);
  assert.equal(
    crypto.createHash('sha256').update(bytes).digest('hex'),
    process.env.TEST_DB_CONTRACT_SHA256,
  );
  const c = JSON.parse(bytes);
  const u = new URL(c.endpoint);
  assert.equal(u.hostname, '127.0.0.1');
  assert.equal(u.port, '55433');
  assert.equal(u.pathname, '/smartlearning_test');
  assert.equal(c.db, 'smartlearning_test');
  assert.equal(c.cluster, 'sl-daily-runtime-20261015-01');
  assert.equal(c.system, '7696842547779285008');
  assert.equal(c.schema, 'public');
  assert.equal(c.recovery, false);
  const client = new Client({
    connectionString: c.endpoint,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 7000,
    idle_in_transaction_session_timeout: 10000,
  });
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const row = (
      await client.query(`SELECT current_database() AS db, current_user AS role,
      current_schema() AS schema, current_setting('cluster_name') AS cluster,
      pg_is_in_recovery() AS recovery`)
    ).rows[0];
    for (const k of ['db', 'role', 'schema', 'cluster', 'recovery'])
      assert.equal(row[k], c[k]);
    const caps = (
      await client.query(`SELECT
      NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS restricted,
      rolcanlogin AS login,
      has_function_privilege(current_user,'pg_catalog.pg_control_system()','EXECUTE') AS system_read,
      has_schema_privilege(current_user,'public','CREATE') AS schema_create,
      COALESCE((SELECT bool_and(has_table_privilege(current_user,c.oid,'TRUNCATE'))
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p')
        AND c.relname NOT LIKE '_prisma%' AND c.relname NOT LIKE '%schema_migrations%'),false) AS truncate,
      (SELECT bool_and(has_table_privilege(current_user,'public._prisma_migrations',privilege)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege)) AS migration_ledger
      FROM pg_roles WHERE rolname=current_user`)
    ).rows[0];
    assert.equal(caps.restricted, true);
    assert.equal(caps.login, true);
    if (caps.system_read) {
      const proof = (
        await client.query(
          'SELECT system_identifier::text AS system FROM pg_catalog.pg_control_system()',
        )
      ).rows[0];
      assert.equal(proof.system, c.system);
    }
    await client.query('ROLLBACK');
    const ready =
      caps.system_read &&
      caps.schema_create &&
      caps.truncate &&
      caps.migration_ledger;
    console.log(
      JSON.stringify({
        status: ready ? 'CAPABILITIES_PASS' : 'BLOCKED_CAPABILITIES',
        readOnly: true,
        identitySystemVerified: caps.system_read,
        capabilities: caps,
      }),
    );
    if (!ready) process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
  }
}
main().catch(() => {
  console.error('BLOCKED: isolated role audit failed.');
  process.exitCode = 1;
});
