#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const artifactsRoot = path.join(root, 'artifacts');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const allowedModes = new Set(['all', 'checks', 'smoke', 'audit']);
const mode = process.argv[2] || 'all';
if (!allowedModes.has(mode)) {
  process.stderr.write('Usage: node .claude/skills/run-smartlearning-backend/driver.mjs [all|checks|smoke|audit]\n');
  process.exit(2);
}
if (packageJson.name !== 'smartlearning-backend') {
  process.stderr.write('Run this driver from the smartLearning-backend repository root.\n');
  process.exit(2);
}

const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}`;
const artifactDir = path.join(artifactsRoot, `run-backend-${runId}`);
const results = {
  run_id: runId,
  created_at: new Date().toISOString(),
  mode,
  repository: packageJson.name,
  checks: [],
  findings: [],
};

function redact(text) {
  return String(text)
    .replace(/(postgres(?:ql)?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@')
    .replace(/(password|token|secret|api[_-]?key)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
}

function record(name, status, details = '') {
  results.checks.push({ name, status, ...(details ? { details: redact(details).slice(-1200) } : {}) });
}

function run(command, args, name, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    maxBuffer: 12 * 1024 * 1024,
    timeout: options.timeout ?? 180_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.error?.code === 'ETIMEDOUT') {
    record(name, 'FAIL', `Timed out after ${options.timeout ?? 180_000} ms.`);
    return false;
  }
  if (result.error) {
    record(name, 'FAIL', result.error.message);
    return false;
  }
  record(name, result.status === 0 ? 'PASS' : 'FAIL', output);
  return result.status === 0;
}

function hasUnitSpecs(directory = path.join(root, 'src')) {
  if (!existsSync(directory)) return false;
  return readdirSync(directory, { withFileTypes: true }).some((entry) =>
    entry.isDirectory()
      ? hasUnitSpecs(path.join(directory, entry.name))
      : entry.isFile() && entry.name.endsWith('.spec.ts'),
  );
}

async function choosePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function smoke() {
  const port = await choosePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs = [];
  const server = spawn('node', ['dist/src/main.js'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', OPENAPI_ENABLED: 'true', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.setEncoding('utf8').on('data', (chunk) => logs.push(chunk));
  server.stderr.setEncoding('utf8').on('data', (chunk) => logs.push(chunk));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (server.exitCode !== null || server.signalCode !== null) return;
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  };
  const onSignal = () => { void stop().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    let response;
    let lastError;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null || server.signalCode !== null) break;
      try {
        response = await fetch(`${origin}/openapi.json`, { signal: AbortSignal.timeout(1500) });
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!response) {
      record('running backend HTTP smoke', 'FAIL', lastError?.message || 'Server did not become ready within 20 seconds.');
      return false;
    }
    if (!response.ok) {
      record('running backend HTTP smoke', 'FAIL', `GET /openapi.json returned HTTP ${response.status}.`);
      return false;
    }
    const document = await response.json();
    const valid = typeof document.openapi === 'string' && document.openapi.startsWith('3.') &&
      document.info?.title === 'SmartLearning Backend API' && typeof document.paths === 'object';
    if (!valid) {
      record('running backend HTTP smoke', 'FAIL', 'OpenAPI response did not match the expected basic contract.');
      return false;
    }
    record('running backend HTTP smoke', 'PASS', `GET /openapi.json returned OpenAPI ${document.openapi}; ${Object.keys(document.paths).length} API paths.`);
    if (Object.keys(document.paths).length === 0) {
      results.findings.push('No business API paths are currently registered; this smoke check validates the running skeleton only.');
    }
    return true;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await stop();
    if (logs.length && results.checks.at(-1)?.status === 'FAIL') {
      results.checks.at(-1).details = redact(logs.join('').slice(-1200));
    }
  }
}

function auditSources() {
  const migrationPath = path.join(root, 'prisma/migrations/20261105000000_init_app_schema/migration.sql');
  if (!existsSync(migrationPath)) {
    record('ER model / migration source', 'FAIL', 'Expected initial Prisma SQL migration was not found.');
    return;
  }
  const migration = readFileSync(migrationPath, 'utf8');
  const columnComments = (migration.match(/COMMENT\s+ON\s+COLUMN\b/gi) || []).length;
  const migrationsPath = path.join(root, 'prisma/migrations');
  const migrationDirs = existsSync(migrationsPath)
    ? readdirSync(migrationsPath, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  record('ER model / migration source', 'PASS', `${migrationDirs.length} migration directory/directories; initial SQL has ${columnComments} COMMENT ON COLUMN statements.`);
  if (migration.includes('PostgreSQL ER 模型 DDL')) {
    results.findings.push('No separate er_model_postgresql.sql was located; the initial migration identifies itself as the PostgreSQL ER-model DDL source.');
  }
  const hasCIWorkflow = existsSync(path.join(root, '.github/workflows/ci.yml'));
  record('CI source presence', hasCIWorkflow ? 'PASS' : 'FAIL', hasCIWorkflow ? 'CI workflow is present.' : 'CI workflow is missing.');
  const uiClientOwnership = 'Backend does not generate packages/api-client; frontend owns generated API callers per project contract.';
  results.findings.push(uiClientOwnership);
}

async function main() {
  await mkdir(artifactDir, { recursive: true });
  if (mode === 'audit') {
    auditSources();
  } else {
    let checksOk = true;
    if (mode === 'all' || mode === 'checks') {
      checksOk = run('npm', ['run', 'lint:check'], 'lint') && checksOk;
      if (hasUnitSpecs()) checksOk = run('npm', ['test', '--', '--runInBand'], 'unit tests') && checksOk;
      else record('unit tests', 'SKIPPED', 'No tracked src/**/*.spec.ts files are present; mirrors the current CI skip condition.');
      checksOk = run('npm', ['run', 'typecheck'], 'typecheck') && checksOk;
      checksOk = run('npm', ['run', 'build'], 'build') && checksOk;
      checksOk = run('npm', ['run', 'openapi:export'], 'OpenAPI export', { timeout: 240_000 }) && checksOk;
      auditSources();
    }
    if (mode === 'all' || mode === 'smoke') {
      if (mode === 'all' && !checksOk) {
        record('running backend HTTP smoke', 'BLOCKED', 'Build/check phase failed; refusing to run possibly stale dist output.');
      } else if (!existsSync(path.join(root, 'dist/src/main.js'))) {
        record('running backend HTTP smoke', 'BLOCKED', 'Built entrypoint dist/src/main.js is missing; run the build first.');
      } else {
        await smoke();
      }
    }
  }
  results.finished_at = new Date().toISOString();
  results.non_database_result = results.checks.some((check) => check.status === 'FAIL') ? 'FAIL' :
    results.checks.some((check) => check.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
  results.database_migration = 'NOT_RUN: this driver never starts Docker, connects to a database, or applies migrations.';
  const outputPath = path.join(artifactDir, 'results.json');
  await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ non_database_result: results.non_database_result, database_migration: results.database_migration, run_id: runId, results_file: path.relative(root, outputPath), checks: results.checks }, null, 2)}\n`);
  if (results.non_database_result !== 'PASS') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${redact(error?.stack || error)}\n`);
  process.exitCode = 1;
});
