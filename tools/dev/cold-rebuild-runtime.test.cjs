'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../..');
const run = 'sl-cold-rebuild-20261015-04';
async function exercise(failure) {
  const output = [];
  let launched = false;
  const proc = { env: { RESTORE_ID: 'a'.repeat(64), PATH: '/usr/bin', HOME: '/tmp' },
    once() {}, kill() { throw Object.assign(new Error(), { code: 'ESRCH' }); } };
  const config = { DATABASE_URL: 'postgresql://restricted:offline@localhost:5432/smartlearning_test?schema=public',
    PORT: '3001', COOKIE_SECRET: 'offline', CORS_ORIGIN: 'http://localhost' };
  const mockFs = { statSync: () => ({ mode: 0o100600 }), lstatSync: () => ({ isSymbolicLink: () => false }),
    existsSync: file => !file.endsWith('dist/main.js'), readdirSync: () => [],
    readFileSync: file => file.endsWith('build-receipt.json') ? JSON.stringify({
      snapshot: path.join(root, 'artifacts/local-env', run, 'build'), manifest: {}, snapshotManifest: {},
    }) : file.endsWith('package.json') ? JSON.stringify({ scripts: { 'start:prod': 'node dist/src/main' } }) : '' };
  const deps = { dotenv: { parse: () => config } };
  const mockRequire = name => {
    if (name === 'node:fs') return mockFs;
    if (name === 'node:module') return { createRequire: () => key => deps[key] };
    if (name === 'node:child_process') return {
      spawnSync: (program) => ({ status: failure === 'sql' && program === 'node' ? 1 : 0,
        stderr: '', stdout: JSON.stringify(program === 'python3' ? {
          id: proc.env.RESTORE_ID, state: 'running', cluster: run, restart: 'no',
        } : { identityDigest: 'i', schemaDigest: 's', migrationsDigest: 'm', countsDigest: 'c' }) }),
      spawn: (program, args, options) => {
        launched = true;
        assert.equal(options.env.DATABASE_URL.includes(':55433/'), true);
        assert.equal(new URL(options.env.DATABASE_URL).search, '');
        assert.equal(options.env.NODE_ENV, 'test');
        assert.equal(options.env.REALTIME_REDIS_MODE, 'off');
        assert.equal(options.detached, true);
        const child = new EventEmitter();
        Object.assign(child, { pid: 100, exitCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
        return child;
      },
    };
    if (name === 'node:net') return { connect: () => {
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      queueMicrotask(() => socket.emit('error', { code: 'ECONNREFUSED' }));
      return socket;
    } };
    return require(name);
  };
  const body = { status: 'ok', timestamp: new Date().toISOString(), checks: {
    db: { healthy: true }, redis: { healthy: true, mode: 'off' }, loginRateLimit: { healthy: true, mode: 'memory' },
  } };
  const context = vm.createContext({ require: mockRequire, __dirname, process: proc, URL,
    performance, setTimeout: callback => { callback(); }, AbortSignal,
    console: { log: value => output.push(value), error: value => output.push(value) },
    fetch: async url => ({ status: url.endsWith('/session') ? 401 : failure === 'readiness' && url.endsWith('/ready') ? 503 : 200,
      json: async () => body }),
  });
  const source = fs.readFileSync(path.join(__dirname, 'cold-rebuild-runtime.cjs'), 'utf8')
    .replace('main().catch(() => {', 'globalThis.finished = main().catch(() => {');
  vm.runInContext(source, context);
  await context.finished;
  return { output: output.join('\n'), launched, exitCode: proc.exitCode };
}
test('full runtime accepts identity/SQL/readiness/smoke and closes app', async () => {
  const result = await exercise();
  assert.equal(result.exitCode, undefined);
  assert.match(result.output, /FUNCTION_SMOKE_PASS/);
  assert.match(result.output, /APP_CLEANUP_PASS/);
  assert.match(result.output, /serviceReadyOffsetSeconds/);
});
test('SQL refusal prevents app writers', async () => {
  const result = await exercise('sql');
  assert.equal(result.launched, false);
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.output, /COMPILED_READINESS_PASS/);
});
test('readiness exhaustion fails without success marker', async () => {
  const result = await exercise('readiness');
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.output, /FUNCTION_SMOKE_PASS/);
});
