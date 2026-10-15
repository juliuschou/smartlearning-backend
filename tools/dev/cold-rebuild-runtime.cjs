'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '../..');
const req = createRequire(path.join(root, 'artifacts/local-env/sl-cold-rebuild-20261015-04/build/package.json'));
const dotenv = req('dotenv');
const expectedId = process.env.RESTORE_ID;
assert.match(expectedId, /^[a-f0-9]{64}$/);
const started = performance.now();
const receipt = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/local-env/sl-cold-rebuild-20261015-04/build-receipt.json'), 'utf8'));
let child;
let stage = 'preflight';
let diagnostics = '';
let success = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout: 100000 });
  if (result.status !== 0) {
    try {
      const detail = JSON.parse(result.stderr.trim());
      if (detail.result === 'BLOCKED') console.error(JSON.stringify({ result: detail.result, stage: detail.stage, sqlstate: detail.sqlstate }));
    } catch { /* never print unstructured child errors */ }
  }
  assert.equal(result.status, 0);
  return JSON.parse(result.stdout.trim());
}
function metadata() {
  const info = command('python3', ['-B', 'tools/dev/cold-rebuild.py', '--check-restore', expectedId]);
  assert.equal(info.id, expectedId);
  assert.equal(info.state, 'running');
  assert.equal(info.cluster, 'sl-cold-rebuild-20261015-04');
  assert.equal(info.restart, 'no');
  return info;
}
function sql() { return command('node', ['tools/dev/cold-rebuild-sql.cjs']); }
function groupAlive() {
  if (!child || !child.pid) return false;
  try { process.kill(-child.pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function cleanup() {
  if (!groupAlive()) return;
  process.kill(-child.pid, 'SIGTERM');
  for (let i = 0; i < 100 && groupAlive(); i++) await sleep(100);
  if (groupAlive()) process.kill(-child.pid, 'SIGKILL');
  for (let i = 0; i < 30 && groupAlive(); i++) await sleep(100);
  assert.equal(groupAlive(), false);
}
async function portClosed() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: 3001 });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => { socket.destroy(); resolve(error.code === 'ECONNREFUSED'); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}
async function main() {
  const snapshot = receipt.snapshot;
  assert.ok(snapshot === path.join(root, 'artifacts/local-env/sl-cold-rebuild-20261015-04/build'));
  for (const [name, hash] of Object.entries(receipt.manifest)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'), hash);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(snapshot, name))).digest('hex'), receipt.snapshotManifest[name]);
  }
  assert.ok(fs.existsSync(path.join(snapshot, 'dist/src/main.js')));
  assert.ok(!fs.existsSync(path.join(snapshot, 'dist/main.js')));
  assert.ok(!fs.readdirSync(snapshot).some(name => name.startsWith('.env')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(snapshot, 'package.json'))).scripts['start:prod'], 'node dist/src/main');
  assert.ok(await portClosed());
  stage = 'restore-metadata';
  metadata();
  stage = 'restore-readonly-sql';
  const baseline = sql();
  console.log('PREFLIGHT_PASS source_hashes=' + Object.keys(receipt.manifest).length + ' SQL=true');
  stage = 'configuration';
  const envPath = path.join(root, '.env.test');
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  assert.ok(!fs.lstatSync(envPath).isSymbolicLink());
  const approved = dotenv.parse(fs.readFileSync(envPath));
  require('./cold-rebuild-config.cjs').validate(approved);
  const url = require('./cold-rebuild-config.cjs').isolatedURL(approved);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433');
  assert.equal(url.pathname, '/smartlearning_test');
  assert.equal(approved.PORT, '3001');
  assert.ok(approved.COOKIE_SECRET);
  assert.ok(!approved.NODE_ENV || approved.NODE_ENV === 'test');
  for (const key of ['REDIS_URL', 'LOGIN_RATE_LIMIT_REDIS_URL', 'FE42_RESPONSE_LOSS_TOKEN',
    'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD']) assert.ok(!approved[key]);
  for (const [key, value] of Object.entries(approved)) {
    if ((key.startsWith('RETENTION_') && key.endsWith('_ENABLED')) || key.includes('FAILPOINT')) {
      assert.ok(!value || ['false', '0'].includes(value));
    }
  }
  assert.ok(!approved.REALTIME_REDIS_MODE || approved.REALTIME_REDIS_MODE === 'off');
  assert.ok(!approved.LOGIN_RATE_LIMIT_MODE || approved.LOGIN_RATE_LIMIT_MODE === 'memory');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: '/tmp', DATABASE_URL: approved.DATABASE_URL, COOKIE_SECRET: approved.COOKIE_SECRET,
    CORS_ORIGIN: approved.CORS_ORIGIN, PORT: '3001', DELETION_MANIFEST_PROVIDER: 'local',
    NODE_ENV: 'test', REALTIME_REDIS_MODE: 'off', LOGIN_RATE_LIMIT_MODE: 'memory' };
  url.hostname = '127.0.0.1'; url.port = '55433';
  env.DATABASE_URL = url.toString();
  for (const key of Object.keys(env)) {
    if (/DATABASE.*URL|DIRECT.*URL|SHADOW.*URL/.test(key) && key !== 'DATABASE_URL') delete env[key];
  }
  stage = 'compiled-startup';
  const appStarted = performance.now();
  child = spawn('node', ['dist/src/main.js'], { cwd: snapshot, env,
    detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', () => {});
  const retain = data => { diagnostics = (diagnostics + data.toString()).slice(-65536); };
  child.stdout.on('data', retain);
  child.stderr.on('data', retain);
  let accepted = false;
  for (let i = 0; i < 60; i++) {
    assert.equal(child.exitCode, null);
    try {
      const response = await fetch('http://127.0.0.1:3001/health/ready', { signal: AbortSignal.timeout(1500) });
      if (response.status === 200) {
        const body = await response.json();
        assert.equal(body.status, 'ok');
        assert.equal(body.checks.db.healthy, true);
        assert.equal(body.checks.redis.healthy, true);
        assert.equal(body.checks.redis.mode, 'off');
        assert.equal(body.checks.loginRateLimit.healthy, true);
        assert.equal(body.checks.loginRateLimit.mode, 'memory');
        assert.ok(Number.isFinite(Date.parse(body.timestamp)));
        assert.equal(Object.hasOwn(body, 'httpStatus'), false);
        console.log('READY_RESPONSE ' + JSON.stringify(body));
        accepted = true;
        break;
      }
    } catch { /* bounded startup polling only */ }
    await sleep(500);
  }
  assert.ok(accepted);
  console.log('TIMING ' + JSON.stringify({ appReadinessSeconds: (performance.now() - appStarted) / 1000 }));
  const live = await fetch('http://127.0.0.1:3001/health/live', { signal: AbortSignal.timeout(1500) });
  assert.equal(live.status, 200);
  const denied = await fetch('http://127.0.0.1:3001/api/v1/auth/session', { signal: AbortSignal.timeout(1500) });
  assert.equal(denied.status, 401);
  console.log('FUNCTION_SMOKE_PASS liveness=200 auth=401');
  console.log('TIMING ' + JSON.stringify({ serviceReadyOffsetSeconds: (performance.now() - started) / 1000 }));
  console.log('COMPILED_READINESS_PASS HTTP=200 status=ok db=true redis=off loginRateLimit=memory');
  stage = 'app-cleanup';
  const cleanupStarted = performance.now();
  await cleanup();
  assert.ok(await portClosed());
  console.log('TIMING ' + JSON.stringify({ appCleanupSeconds: (performance.now() - cleanupStarted) / 1000 }));
  stage = 'final-db';
  const final = metadata();
  const after = sql();
  assert.equal(after.identityDigest, baseline.identityDigest);
  assert.equal(after.schemaDigest, baseline.schemaDigest);
  assert.equal(after.migrationsDigest, baseline.migrationsDigest);
  console.log('FINAL_DB ' + JSON.stringify(final));
  console.log('SQL_POSTCHECK_PASS countsUnchanged=' + (after.countsDigest === baseline.countsDigest));
  console.log('APP_CLEANUP_PASS group_stopped=true port_3001_closed=true');
  success = true;
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => {
  try { await cleanup(); process.exit(1); } catch { process.exit(2); }
});
main().catch(() => {
  const category = diagnostics.includes('Cannot find module') ? 'module-resolution' :
    diagnostics.includes('EADDRINUSE') ? 'port-conflict' :
    diagnostics.includes('Environment validation failed') ? 'env-validation' : 'assertion-or-operation';
  console.error('RUNTIME_BLOCKED stage=' + stage + ' category=' + category);
  process.exitCode = 1;
}).finally(async () => {
  try { await cleanup(); } catch { console.error('APP_CLEANUP_UNCONFIRMED'); process.exitCode = 1; }
  diagnostics = '';
});
