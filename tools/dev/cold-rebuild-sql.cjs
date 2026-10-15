#!/usr/bin/env node
'use strict';

// Read-only SQL evidence. Emits aggregate digests only, never credentials/rows.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const req = require('node:module').createRequire(require('node:path').resolve(__dirname, '../../artifacts/local-env/sl-cold-rebuild-20261015-04/build/package.json'));
const { Client } = req('pg');
const dotenv = req('dotenv');
const root = path.resolve(__dirname, '../..');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
let stage = 'configuration';

async function main() {
  const envPath = path.join(root, '.env.test');
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  const env = dotenv.parse(fs.readFileSync(envPath));
  const url = require('./cold-rebuild-config.cjs').isolatedURL(env);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433');
  assert.equal(url.pathname, '/smartlearning_test');
  assert.ok(url.username && url.password);
  // Do not inherit PGHOST/PGUSER/etc. Explicit connection settings only.
  const client = new Client({ host: '127.0.0.1', port: 55433,
    database: 'smartlearning_test', user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password), ssl: false,
    application_name: 'smartlearning-local-db-readonly',
    connectionTimeoutMillis: 5000, statement_timeout: 5000,
    query_timeout: 7000, idle_in_transaction_session_timeout: 10000 });
  try {
    stage = 'authentication';
    await client.connect();
    await client.query('BEGIN READ ONLY');
    stage = 'identity';
    const proof = (await client.query("SELECT current_setting('cluster_name') AS cluster, current_schema() AS schema, pg_is_in_recovery() AS recovery")).rows[0];
    assert.deepEqual(proof, { cluster: 'sl-cold-rebuild-20261015-04', schema: 'public', recovery: false });
    const identity = (await client.query(`SELECT current_database() AS db,
      current_user AS role, inet_server_port() AS port,
      current_setting('transaction_read_only') AS readonly`)).rows[0];
    assert.equal(identity.db, 'smartlearning_test');
    assert.equal(identity.role, decodeURIComponent(url.username));
    assert.equal(identity.port, 5432);
    assert.equal(identity.readonly, 'on');
    const role = (await client.query(`SELECT rolsuper, rolcreatedb, rolcreaterole,
      rolreplication, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname=current_user`)).rows[0];
    assert.ok(role.rolcanlogin);
    for (const key of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls']) {
      assert.equal(role[key], false);
    }
    stage = 'migrations';
    const migrationsPath = path.join(root, 'prisma/migrations');
    const expectedMigrations = fs.readdirSync(migrationsPath).filter(name =>
      fs.existsSync(path.join(migrationsPath, name, 'migration.sql'))).sort().map(name => ({
        migration_name: name,
        checksum: crypto.createHash('sha256').update(
          fs.readFileSync(path.join(migrationsPath, name, 'migration.sql'))).digest('hex'),
      }));
    const migrations = (await client.query(`SELECT migration_name, checksum,
      finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
      FROM public._prisma_migrations ORDER BY migration_name`)).rows;
    assert.ok(migrations.every(item => item.finished && !item.rolled_back));
    assert.deepEqual(migrations.map(({migration_name, checksum}) => ({migration_name, checksum})),
      expectedMigrations);
    stage = 'schema';
    const schema = fs.readFileSync(path.join(root, 'prisma/schema.prisma'), 'utf8');
    const models = [...schema.matchAll(/^model\s+\w+\s*\{([\s\S]*?)^\}/gm)];
    assert.equal(models.length, 21);
    const columns = (await client.query(`SELECT table_name, column_name, data_type,
      udt_name, is_nullable FROM information_schema.columns
      WHERE table_schema='public' ORDER BY table_name, ordinal_position`)).rows;
    const tables = [];
    let scalarColumns = 0;
    for (const [, body] of models) {
      const table = body.match(/@@map\("([a-z_]+)"\)/)[1];
      tables.push(table);
      for (const line of body.split('\n')) {
        const field = line.match(/^\s*(\w+)\s+(String|Boolean|Int|BigInt|Float|Decimal|DateTime|Json|Bytes)(?:\?|\[\])?(?:\s|$)/);
        if (!field) continue;
        const column = (line.match(/@map\("([a-z_]+)"\)/) || [null, field[1]])[1];
        assert.ok(columns.some(item => item.table_name === table && item.column_name === column));
        scalarColumns++;
      }
    }
    const rls = (await client.query(`SELECT relname FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relrowsecurity AND relname=ANY($1)`, [tables])).rows;
    assert.equal(rls.length, 0);
    stage = 'counts';
    const counts = {};
    for (const table of tables.sort()) {
      assert.match(table, /^[a-z_]+$/);
      counts[table] = (await client.query(`SELECT count(*)::text AS n FROM public."${table}"`)).rows[0].n;
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ identityDigest: digest(identity),
      schemaDigest: digest(columns), migrationsDigest: digest(migrations),
      countsDigest: digest(counts), tables: tables.length, scalarColumns,
      migrations: migrations.length, readOnly: true }));
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch(error => {
  const sqlstate = typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)
    ? error.code : 'not-reported';
  console.error(JSON.stringify({ result: 'BLOCKED', stage, sqlstate }));
  process.exitCode = 1;
});
