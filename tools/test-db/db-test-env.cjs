#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const { Client } = require('pg');

const root = path.resolve(__dirname, '../..');
const envFile = path.join(root, '.env.test');
const migrationDir = path.join(root, 'prisma/migrations');
const stateRoot = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'),
  'smartlearning/test-db/runs',
);
const port = 5432;
const databaseName = 'smartlearning_test';
const appSchema = 'app';
const secretName = 'postgres_password';
const userConfig = fs.existsSync(envFile)
  ? dotenv.parse(fs.readFileSync(envFile))
  : null;
const secretsForRedaction = userConfig
  ? [userConfig.DB_PASSWORD, userConfig.DATABASE_URL].filter(Boolean)
  : [];

function redact(value) {
  let text = String(value || '');
  for (const secret of secretsForRedaction) {
    text = text.split(secret).join('[REDACTED]');
    try {
      text = text.split(encodeURIComponent(secret)).join('[REDACTED]');
    } catch {
      // Keep the original redaction if an unusual value cannot be encoded.
    }
  }
  return text.replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, 'postgresql://[REDACTED]@');
}

function fail(message) {
  throw new Error(message);
}

function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: root,
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) fail(`${bin} failed to start: ${redact(result.error.message)}`);
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    fail(`${bin} ${args[0] || ''} failed${detail ? `:\n${redact(detail)}` : ''}`);
  }
  return result.stdout.trim();
}

function loadTestConfig() {
  if (!userConfig) fail('Missing .env.test; refusing to choose a database target.');
  const required = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USERNAME', 'DB_PASSWORD', 'DATABASE_URL'];
  for (const key of required) {
    if (!userConfig[key]) fail(`Missing ${key} in .env.test.`);
  }
  if (userConfig.DB_NAME !== databaseName) {
    fail(`Expected DB_NAME=${databaseName}; refusing to continue.`);
  }
  if (Number(userConfig.DB_PORT) !== port) {
    fail(`Expected test DB port ${port}; refusing to use another port.`);
  }
  if (!['localhost', '127.0.0.1'].includes(userConfig.DB_HOST)) {
    fail('DB_HOST must resolve to the local test database; refusing remote targets.');
  }
  let configuredUrl;
  try {
    configuredUrl = new URL(userConfig.DATABASE_URL);
  } catch {
    fail('DATABASE_URL in .env.test is not a valid URL.');
  }
  if (
    !['localhost', '127.0.0.1'].includes(configuredUrl.hostname) ||
    Number(configuredUrl.port || 5432) !== port ||
    configuredUrl.pathname.replace(/^\//, '') !== databaseName ||
    decodeURIComponent(configuredUrl.username) !== userConfig.DB_USERNAME ||
    decodeURIComponent(configuredUrl.password) !== userConfig.DB_PASSWORD
  ) {
    fail('DATABASE_URL does not match the local test database settings in .env.test.');
  }
  return userConfig;
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of [
    'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USERNAME', 'DB_PASSWORD', 'DATABASE_URL',
    'TEST_DB_SECRET_SOURCE',
  ]) delete env[key];
  return env;
}

function projectFor(runId) {
  return `sltest-${runId}`;
}

function validateRunId(runId) {
  if (!/^[a-z0-9][a-z0-9-]{5,40}$/.test(runId)) {
    fail('Run ID must contain 6-41 lowercase letters, numbers, or hyphens.');
  }
}

function compose(project, args, options = {}) {
  const env = { ...cleanEnvironment(), ...(options.env || {}) };
  return command('docker', [
    'compose', '--env-file', '.env.test', '--project-name', project,
    '--file', 'compose.test-db.yml', ...args,
  ], { env });
}

function dockerList(args) {
  return command('docker', args);
}

function assertUniqueProject(project) {
  const containers = dockerList(['ps', '-a', '--format', '{{.Names}} {{.Label "com.docker.compose.project"}}'])
    .split('\n').filter(Boolean);
  const volumes = dockerList(['volume', 'ls', '--format', '{{.Name}}']);
  const networks = dockerList(['network', 'ls', '--format', '{{.Name}} {{.Label "com.docker.compose.project"}}'])
    .split('\n').filter(Boolean);
  const hasTestResources = containers.some((line) => line.includes('sltest-') || line.includes('smartlearning-test-db')) ||
    volumes.split('\n').some((name) => name.startsWith('sltest-') || name.startsWith('smartlearning-test-db_')) ||
    networks.some((line) => line.includes('sltest-') || line.includes('smartlearning-test-db'));
  if (hasTestResources) {
    fail('Existing test database resources were found; inspect and resolve them explicitly before creating another run.');
  }
  const existing = dockerList(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}']);
  const projectVolumes = dockerList(['volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']);
  const projectNetworks = dockerList(['network', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']);
  if (existing || projectVolumes || projectNetworks) {
    fail(`Resources already exist for project ${project}; retained resources will not be reused.`);
  }
}

function preflight(runId) {
  const config = loadTestConfig();
  const context = dockerList(['context', 'show']);
  if (context !== 'default') fail(`Docker context is ${context}, expected default; refusing to target an unverified engine.`);
  const serverVersion = dockerList(['version', '--format', '{{.Server.Version}}']);
  const imageId = dockerList(['image', 'inspect', 'postgres:16', '--format', '{{.Id}}']);
  const portUse = command('ss', ['-H', '-ltn', 'sport', '=', `:${port}`]);
  if (portUse) fail(`Port ${port} is already in use; no resources were created.`);
  const project = projectFor(runId);
  assertUniqueProject(project);
  const composeEnv = {
    ...cleanEnvironment(),
    TEST_DB_SECRET_SOURCE: path.join(os.tmpdir(), `smartlearning-test-secret-${runId}`, secretName),
  };
  command('docker', [
    'compose', '--env-file', '.env.test', '--project-name', project,
    '--file', 'compose.test-db.yml', 'config', '--quiet',
  ], { env: composeEnv });
  return { config, context, serverVersion, imageId, project, runId };
}

function makeRunId() {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${timestamp}-${crypto.randomBytes(4).toString('hex')}`.toLowerCase();
}

function persistRun(record) {
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateRoot, 0o700);
  const file = path.join(stateRoot, `${record.runId}.json`);
  if (fs.existsSync(file)) fail(`Run ID ${record.runId} already has local state; refusing reuse.`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return file;
}

function latestRun() {
  if (!fs.existsSync(stateRoot)) fail('No locally recorded test database runs were found.');
  const files = fs.readdirSync(stateRoot).filter((name) => name.endsWith('.json')).sort().reverse();
  if (!files.length) fail('No locally recorded test database runs were found.');
  return JSON.parse(fs.readFileSync(path.join(stateRoot, files[0]), 'utf8'));
}

function getRun(runId) {
  if (!runId) return latestRun();
  validateRunId(runId);
  const file = path.join(stateRoot, `${runId}.json`);
  if (!fs.existsSync(file)) fail(`No local state found for run ${runId}.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function updateRun(record, patch) {
  const file = path.join(stateRoot, `${record.runId}.json`);
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, { mode: 0o600 });
}

function makeDatabaseUrl(config) {
  const url = new URL('postgresql://127.0.0.1');
  url.username = config.DB_USERNAME;
  url.password = config.DB_PASSWORD;
  url.port = String(port);
  url.pathname = `/${databaseName}`;
  url.searchParams.set('schema', appSchema);
  return url.toString();
}

function expectedMigrationObjects() {
  const migrations = fs.readdirSync(migrationDir)
    .filter((name) => fs.statSync(path.join(migrationDir, name)).isDirectory())
    .sort();
  if (!migrations.length) fail('No Prisma migrations found.');
  const tables = new Set();
  const enums = new Set();
  for (const migration of migrations) {
    const sql = fs.readFileSync(path.join(migrationDir, migration, 'migration.sql'), 'utf8');
    const tableStatements = [...sql.matchAll(/\bCREATE\s+TABLE\b/gi)];
    const tableMatches = [...sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(app)\.)?([A-Za-z_][A-Za-z0-9_]*)(?!\.)/gi)];
    const typeStatements = [...sql.matchAll(/\bCREATE\s+TYPE\b/gi)];
    const enumMatches = [...sql.matchAll(/\bCREATE\s+TYPE\s+(?:(app)\.)?([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+ENUM\b/gi)];
    if (tableStatements.length !== tableMatches.length || typeStatements.length !== enumMatches.length) {
      fail(`Migration ${migration} uses unsupported object syntax; refusing an incomplete inventory.`);
    }
    for (const match of tableMatches) tables.add(match[2]);
    for (const match of enumMatches) enums.add(match[2]);
  }
  if (!tables.size || !enums.size) fail('Could not derive expected tables and enum types from migrations.');
  return { migrations, tables, enums };
}

async function assertFreshDatabase(config) {
  const client = new Client({
    connectionString: makeDatabaseUrl(config),
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  await client.connect();
  try {
    const identity = await client.query('SELECT current_database() AS database_name, current_user AS database_user');
    if (identity.rows[0].database_name !== databaseName || identity.rows[0].database_user !== config.DB_USERNAME) {
      fail('Connected database identity does not match the approved test target.');
    }
    const schemas = await client.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'public') AND left(schema_name, 3) <> 'pg_'",
    );
    const tables = await client.query(
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema <> 'information_schema' AND left(table_schema, 3) <> 'pg_'",
    );
    if (schemas.rowCount !== 0 || tables.rowCount !== 0) {
      fail('New test database was not empty before migrations; refusing to modify it.');
    }
  } finally {
    await client.end();
  }
}

async function validateDatabase(config) {
  const client = new Client({
    connectionString: makeDatabaseUrl(config),
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
  });
  await client.connect();
  try {
    const identity = await client.query('SELECT current_database() AS database_name, current_user AS database_user');
    if (identity.rows[0].database_name !== databaseName || identity.rows[0].database_user !== config.DB_USERNAME) {
      fail('Connected database identity does not match the approved test target.');
    }
    const outsideSchema = await client.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'public', 'app') AND left(schema_name, 3) <> 'pg_'",
    );
    const outsideTables = await client.query(
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'app') AND left(table_schema, 3) <> 'pg_'",
    );
    if (outsideSchema.rowCount !== 0 || outsideTables.rowCount !== 0) {
      fail('Unexpected application schema or table found outside app.');
    }
    const expected = expectedMigrationObjects();
    const expectedNames = [...expected.tables].sort();
    const expectedRelations = [...expectedNames, '_prisma_migrations'].sort();
    const relationResult = await client.query(
      "SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') ORDER BY c.relname",
    );
    const actualRelations = relationResult.rows.map((row) => row.relname).sort();
    if (JSON.stringify(actualRelations) !== JSON.stringify(expectedRelations) ||
        relationResult.rows.some((row) => row.relkind !== 'r')) {
      fail(`Application relation inventory differs from migrations (expected ${expectedNames.length} application tables plus migration metadata).`);
    }
    const typeResult = await client.query(
      "SELECT t.typname, t.typtype, c.relkind AS relation_kind FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace LEFT JOIN pg_class c ON c.oid = t.typrelid WHERE n.nspname = 'app' AND t.typtype <> 'b' ORDER BY t.typname",
    );
    const actualEnums = typeResult.rows.filter((row) => row.typtype === 'e').map((row) => row.typname).sort();
    const expectedEnums = [...expected.enums].sort();
    if (JSON.stringify(actualEnums) !== JSON.stringify(expectedEnums)) {
      fail(`Application enum inventory differs from migrations (expected ${expectedEnums.length} enums).`);
    }
    const allowedRelationTypes = new Set(expectedRelations);
    const hasUnexpectedType = typeResult.rows.some((row) =>
      row.typtype === 'e'
        ? !expected.enums.has(row.typname)
        : row.typtype !== 'c' || !allowedRelationTypes.has(row.typname) || row.relation_kind !== 'r',
    );
    if (hasUnexpectedType) fail('Unexpected custom type found in app.');
    const migrations = await client.query(
      'SELECT migration_name, finished_at, rolled_back_at FROM app._prisma_migrations ORDER BY migration_name',
    );
    const successful = migrations.rows
      .filter((row) => row.finished_at && !row.rolled_back_at)
      .map((row) => row.migration_name)
      .sort();
    const failed = migrations.rows.some((row) => !row.finished_at || row.rolled_back_at);
    if (failed || JSON.stringify(successful) !== JSON.stringify(expected.migrations)) {
      fail('Prisma migration ledger is incomplete, failed, or does not match repository migrations.');
    }
    let totalRows = 0n;
    for (const tableName of expectedNames) {
      const quoted = `"${tableName.replaceAll('"', '""')}"`;
      const result = await client.query(`SELECT count(*)::text AS row_count FROM "app".${quoted}`);
      const rows = BigInt(result.rows[0].row_count);
      totalRows += rows;
      if (rows !== 0n) fail(`Application table ${tableName} contains ${rows} rows; clean baseline check failed.`);
    }
    return {
      database: identity.rows[0].database_name,
      user: identity.rows[0].database_user,
      schema: appSchema,
      applicationTables: expectedNames.length,
      applicationEnums: expectedEnums.length,
      migrationCount: successful.length,
      applicationRows: totalRows.toString(),
    };
  } finally {
    await client.end();
  }
}

async function create() {
  const runId = makeRunId();
  const details = preflight(runId);
  const record = {
    runId,
    project: details.project,
    database: databaseName,
    schema: appSchema,
    port,
    dockerContext: details.context,
    postgresImageId: details.imageId,
    createdAt: new Date().toISOString(),
    state: 'creating',
  };
  persistRun(record);
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), `smartlearning-test-secret-${runId}-`));
  const secretFile = path.join(secretDir, secretName);
  const composeEnv = { ...cleanEnvironment(), TEST_DB_SECRET_SOURCE: secretFile };
  try {
    fs.chmodSync(secretDir, 0o700);
    fs.writeFileSync(secretFile, `${details.config.DB_PASSWORD}\n`, { mode: 0o400, flag: 'wx' });
    compose(details.project, ['run', '--rm', '--no-deps', 'test-db-secret-init'], { env: composeEnv });
  } finally {
    fs.rmSync(secretDir, { recursive: true, force: true });
  }
  compose(details.project, ['up', '-d', '--no-deps', 'test-db'], { env: composeEnv });
  const id = compose(details.project, ['ps', '-q', 'test-db'], { env: composeEnv });
  if (!id) fail('Test DB container was not created; resources were left for inspection.');
  let health = '';
  for (let attempt = 0; attempt < 90; attempt += 1) {
    health = dockerList(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', id]);
    if (health === 'healthy') break;
    if (health === 'exited' || health === 'dead') fail(`Test DB container entered ${health}; resources were left for inspection.`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  if (health !== 'healthy') fail('Test DB did not become healthy within 90 seconds; resources were left for inspection.');
  await finishRun(record, details.config, id);
}

async function resume(runId) {
  const record = getRun(runId);
  validateRunId(record.runId);
  if (record.state !== 'creating' || record.project !== projectFor(record.runId) ||
      record.database !== databaseName || record.schema !== appSchema || record.port !== port) {
    fail('Only an exact, incomplete clean-baseline run can be resumed.');
  }
  const config = loadTestConfig();
  const context = dockerList(['context', 'show']);
  if (context !== record.dockerContext || context !== 'default') {
    fail('Docker context changed since this run; refusing to resume it.');
  }
  const serverVersion = dockerList(['version', '--format', '{{.Server.Version}}']);
  if (!serverVersion) fail('Docker Engine is not available.');
  const id = compose(record.project, ['ps', '-q', 'test-db']);
  if (!id) fail('No running test DB container exists for this incomplete run.');
  const health = dockerList(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', id]);
  if (health !== 'healthy') fail(`Test DB is ${health}; refusing to restart or reuse it.`);
  await finishRun(record, config, id);
}

async function finishRun(record, config, id) {
  verifyContainer(id, record.project, record.postgresImageId);
  await assertFreshDatabase(config);
  const migrationEnv = {
    ...cleanEnvironment(),
    DATABASE_URL: makeDatabaseUrl(config),
  };
  const prismaBin = path.join(root, 'node_modules/.bin/prisma');
  const migrationOutput = command(prismaBin, ['migrate', 'deploy', '--config', 'prisma.ci.config.ts'], { env: migrationEnv });
  if (migrationOutput) process.stdout.write(`${redact(migrationOutput)}\n`);
  const statusOutput = command(prismaBin, ['migrate', 'status', '--config', 'prisma.ci.config.ts'], { env: migrationEnv });
  if (statusOutput) process.stdout.write(`${redact(statusOutput)}\n`);
  const summary = await validateDatabase(config);
  updateRun(record, { state: 'running-clean', verifiedAt: new Date().toISOString(), summary });
  process.stdout.write(`Clean test database verified. run_id=${record.runId} project=${record.project} ` +
    `database=${summary.database} schema=${summary.schema} tables=${summary.applicationTables} ` +
    `enums=${summary.applicationEnums} migrations=${summary.migrationCount} rows=${summary.applicationRows}\n`);
  process.stdout.write('The isolated test environment is retained and running.\n');
}

function verifyContainer(id, project, expectedImageId) {
  const raw = dockerList(['inspect', id]);
  const container = JSON.parse(raw)[0];
  if (!container || container.Config.Image !== 'postgres:16' || container.Image !== expectedImageId) {
    fail('Test DB image identity differs from the image verified during preflight.');
  }
  if (container.Config.Labels['com.docker.compose.project'] !== project ||
      container.Config.Labels['com.docker.compose.service'] !== 'test-db') {
    fail('Test DB container project or service identity does not match this run.');
  }
  if (container.Config.Env.some((entry) => entry.startsWith('POSTGRES_PASSWORD='))) {
    fail('Unsafe password environment variable found in test DB container metadata.');
  }
  if (!container.Config.Env.includes('POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password')) {
    fail('Test DB container is not configured to read its password from a secret file.');
  }
  const dataMount = container.Mounts.find((mount) => mount.Destination === '/var/lib/postgresql/data');
  const secretMount = container.Mounts.find((mount) => mount.Destination === '/run/secrets');
  if (!dataMount || dataMount.Name !== `${project}_test_pgdata` || !dataMount.RW ||
      !secretMount || secretMount.Name !== `${project}_test_db_secrets` || secretMount.RW) {
    fail('Test DB data or read-only secret volume identity is unexpected.');
  }
  const bindings = container.HostConfig.PortBindings['5432/tcp'] || [];
  if (bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || bindings[0].HostPort !== String(port)) {
    fail('Test DB port binding is not restricted to the approved loopback port.');
  }
  const secretAccess = dockerList([
    'exec', '--user', 'postgres', id, 'sh', '-ec',
    `test -r /run/secrets/${secretName} && stat -c '%a:%U:%G' /run/secrets/${secretName}`,
  ]);
  if (secretAccess !== '440:root:postgres') fail('Postgres user cannot safely read the mounted password file.');
}

function runOperation(action, record) {
  validateRunId(record.runId);
  if (record.project !== projectFor(record.runId)) fail('Recorded Compose project name does not match the run ID.');
  const args = action === 'stop' ? ['down'] : action === 'status' ? ['ps', '-a'] : ['logs', '--no-color', '--tail=100', 'test-db'];
  const output = compose(record.project, args);
  if (output) process.stdout.write(`${redact(output)}\n`);
  if (action === 'stop') {
    updateRun(record, { state: 'stopped', stoppedAt: new Date().toISOString() });
    process.stdout.write('Container and network stopped; Docker volumes were retained.\n');
  }
}

async function main() {
  const [action = 'create', runIdArg] = process.argv.slice(2);
  if (action === '--help' || action === 'help') {
    process.stdout.write('Usage: node tools/test-db/db-test-env.cjs <preflight|create|resume|status|logs|stop> [run-id]\n');
    return;
  }
  if (action === 'preflight') {
    const runId = runIdArg || makeRunId();
    validateRunId(runId);
    const result = preflight(runId);
    process.stdout.write(`Preflight PASS. context=${result.context} server=${result.serverVersion} ` +
      `image=${result.imageId} port=${port} project=${result.project}\n`);
    return;
  }
  if (action === 'create') return create();
  if (action === 'resume') {
    if (!runIdArg) fail('A run ID is required to resume an incomplete test database setup.');
    return resume(runIdArg);
  }
  if (!['status', 'logs', 'stop'].includes(action)) fail(`Unknown action: ${action}`);
  runOperation(action, getRun(runIdArg));
}

main().catch((error) => {
  process.stderr.write(`${redact(error.stack || error.message)}\n`);
  process.exitCode = 1;
});
