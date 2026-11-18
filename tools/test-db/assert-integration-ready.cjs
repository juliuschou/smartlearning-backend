#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const { Client } = require('pg');

const root = path.resolve(__dirname, '../..');
const stateRoot = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'),
  'smartlearning/test-db/runs',
);
const databaseName = 'smartlearning_test';
const schemaName = 'app';
const port = 5432;

function fail(message) {
  throw new Error(message);
}

function run(bin, args) {
  const result = spawnSync(bin, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail(`${bin} identity check failed.`);
  return result.stdout.trim();
}

function assertRunRecord(runId, runRecord) {
  if (!/^[a-z0-9][a-z0-9-]{5,40}$/.test(runId || '')) {
    fail('An explicit valid test database run ID is required.');
  }
  if (
    runRecord?.runId !== runId ||
    runRecord.project !== `sltest-${runId}` ||
    runRecord.database !== databaseName ||
    runRecord.schema !== schemaName ||
    runRecord.port !== port ||
    runRecord.state !== 'running-clean'
  ) {
    fail('The selected run is not an exact, verified, clean disposable test database.');
  }
}

function loadTarget(runId) {
  if (!/^[a-z0-9][a-z0-9-]{5,40}$/.test(runId || '')) {
    fail('An explicit valid test database run ID is required.');
  }
  const stateFile = path.join(stateRoot, `${runId}.json`);
  if (!fs.existsSync(stateFile)) fail('No recorded test database run matches this run ID.');
  const runRecord = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assertRunRecord(runId, runRecord);

  const envFile = path.join(root, '.env.test');
  if (!fs.existsSync(envFile)) fail('Missing .env.test; refusing to choose a database target.');
  const config = dotenv.parse(fs.readFileSync(envFile));
  if (
    config.DB_NAME !== databaseName ||
    Number(config.DB_PORT) !== port ||
    !['localhost', '127.0.0.1'].includes(config.DB_HOST) ||
    !config.DB_USERNAME || !config.DB_PASSWORD || !config.DATABASE_URL
  ) {
    fail('The local test database configuration does not match the fixed test target.');
  }
  let url;
  try {
    url = new URL(config.DATABASE_URL);
  } catch {
    fail('DATABASE_URL in .env.test is invalid.');
  }
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    Number(url.port || 5432) !== port ||
    url.pathname.replace(/^\//, '') !== databaseName ||
    decodeURIComponent(url.username) !== config.DB_USERNAME ||
    decodeURIComponent(url.password) !== config.DB_PASSWORD
  ) {
    fail('DATABASE_URL does not match the local disposable test database settings.');
  }
  return { runRecord, config, databaseUrl: config.DATABASE_URL };
}

async function assertTestTarget(runId, { requireEmpty = false } = {}) {
  const { runRecord, config, databaseUrl } = loadTarget(runId);
  if (run('docker', ['context', 'show']) !== 'default') {
    fail('Docker context changed; refusing to target an unverified engine.');
  }
  const idList = run('docker', [
    'ps', '-aq', '--filter', `label=com.docker.compose.project=${runRecord.project}`,
    '--filter', 'label=com.docker.compose.service=test-db',
  ]).split('\n').filter(Boolean);
  if (idList.length !== 1) fail('Expected exactly one test database container for the selected run.');
  const inspect = JSON.parse(run('docker', ['inspect', idList[0]]))[0];
  if (
    inspect.Config.Labels['com.docker.compose.project'] !== runRecord.project ||
    inspect.Config.Labels['com.docker.compose.service'] !== 'test-db' ||
    inspect.Config.Image !== 'postgres:16' ||
    inspect.Image !== runRecord.postgresImageId ||
    inspect.State.Status !== 'running' ||
    inspect.State.Health?.Status !== 'healthy' ||
    inspect.Config.Env.some((entry) => entry.startsWith('POSTGRES_PASSWORD=')) ||
    !inspect.Config.Env.includes('POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password')
  ) {
    fail('The selected test database container is not healthy or has unexpected identity/configuration.');
  }
  const bindings = inspect.HostConfig.PortBindings['5432/tcp'] || [];
  if (bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || bindings[0].HostPort !== String(port)) {
    fail('The selected test database is not bound exclusively to the approved loopback port.');
  }
  const dataMount = inspect.Mounts.find((mount) => mount.Destination === '/var/lib/postgresql/data');
  const secretMount = inspect.Mounts.find((mount) => mount.Destination === '/run/secrets');
  if (
    !dataMount || dataMount.Name !== `${runRecord.project}_test_pgdata` || !dataMount.RW ||
    !secretMount || secretMount.Name !== `${runRecord.project}_test_db_secrets` || secretMount.RW
  ) {
    fail('The selected test database volumes are not owned by the exact run or secrets are not read-only.');
  }

  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  await client.connect();
  try {
    const identity = await client.query('SELECT current_database() AS db, current_user AS db_user');
    if (identity.rows[0].db !== databaseName || identity.rows[0].db_user !== config.DB_USERNAME) {
      fail('Connected database identity does not match the selected isolated test target.');
    }
    const migrations = await client.query(
      "SELECT migration_name, finished_at, rolled_back_at FROM app._prisma_migrations ORDER BY migration_name",
    );
    const expectedMigrations = fs.readdirSync(path.join(root, 'prisma/migrations'))
      .filter((name) => fs.statSync(path.join(root, 'prisma/migrations', name)).isDirectory())
      .sort();
    const successful = migrations.rows.filter((row) => row.finished_at && !row.rolled_back_at)
      .map((row) => row.migration_name).sort();
    if (migrations.rows.some((row) => !row.finished_at || row.rolled_back_at) ||
        JSON.stringify(successful) !== JSON.stringify(expectedMigrations)) {
      fail('The selected test database migration ledger is not complete and successful.');
    }
    if (requireEmpty) {
      const tables = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'app' AND tablename <> '_prisma_migrations' ORDER BY tablename",
      );
      for (const { tablename } of tables.rows) {
        const result = await client.query(`SELECT count(*)::text AS count FROM app."${tablename.replaceAll('"', '""')}"`);
        if (result.rows[0].count !== '0') {
          fail('The selected test database contains application rows; create a fresh test run.');
        }
      }
    }
    return { runId, database: identity.rows[0].db, schema: schemaName, migrationCount: successful.length };
  } finally {
    await client.end();
  }
}

async function assertIntegrationReady(runId) {
  return assertTestTarget(runId, { requireEmpty: true });
}

if (require.main === module) {
  const runId = process.argv[2];
  assertIntegrationReady(runId)
    .then((result) => process.stdout.write(`Integration target PASS. run_id=${result.runId} database=${result.database} schema=${result.schema} migrations=${result.migrationCount}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { assertIntegrationReady, assertTestTarget, assertRunRecord, loadTarget };
