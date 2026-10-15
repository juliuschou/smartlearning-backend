'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate, isolatedURL, readConfiguration } = require('./cold-rebuild-config.cjs');
const good = () => ({ DATABASE_URL: 'postgresql://restricted:offline@127.0.0.1:5432/smartlearning_test',
  PORT: '3001', NODE_ENV: 'test', COOKIE_SECRET: 'offline-only', CORS_ORIGIN: 'http://localhost:3000' });
test('accepts isolated restricted configuration', () => assert.equal(validate(good()), 'restricted'));
for (const [name, change] of Object.entries({
  'query host override': { DATABASE_URL: 'postgresql://restricted:x@localhost:5432/smartlearning_test?host=source&port=5432' },
  'URL fragment': { DATABASE_URL: 'postgresql://restricted:x@localhost:5432/smartlearning_test#extra' },
  'unsupported scheme': { DATABASE_URL: 'https://restricted:x@localhost:5432/smartlearning_test' },
  'source override': { DATABASE_URL: 'postgresql://restricted:x@remote:5432/smartlearning_test' },
  'restore endpoint in source contract': { DATABASE_URL: 'postgresql://restricted:x@localhost:55433/smartlearning_test' },
  'missing password': { DATABASE_URL: 'postgresql://restricted@localhost:5432/smartlearning_test' },
  'wrong database': { DATABASE_URL: 'postgresql://restricted:x@localhost:5432/production' },
  'development': { NODE_ENV: 'development' },
  'missing cookie secret': { COOKIE_SECRET: '' },
  'missing CORS': { CORS_ORIGIN: '' },
  'runtime injection': { NODE_OPTIONS: '--require arbitrary' },
  'bootstrap writer': { BOOTSTRAP_ADMIN_PASSWORD: 'offline' },
  'redis endpoint': { LOGIN_RATE_LIMIT_REDIS_URL: 'redis://localhost' },
  'alternate DB': { DIRECT_DATABASE_URL: 'postgres://elsewhere' },
  'external storage': { S3_SECRET_ACCESS_KEY: 'offline' },
  'retention writer': { RETENTION_PURGE_ENABLED: 'true' },
  'failpoint': { SOME_FAILPOINT: '1' },
  's3 manifest': { DELETION_MANIFEST_PROVIDER: 's3' },
})) test(`rejects ${name}`, () => assert.throws(() => validate({ ...good(), ...change })));

for (const query of ['', '?schema=public', '?%73chema=public']) {
  test(`canonicalizes permitted query ${query}`, () => {
    const approved = good(); approved.DATABASE_URL += query;
    const url = isolatedURL(approved);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55433');
    assert.equal(url.search, ''); assert.equal(url.pathname, '/smartlearning_test');
    assert.equal(url.username, 'restricted'); assert.equal(url.password, 'offline');
  });
}
for (const query of ['schema=private', 'schema=public&schema=public', 'schema=public&host=source',
  'port=5432', 'unknown=x', 'schema=public&%73chema=public', '%68ost=source', 'schema=']) {
  test(`rejects query ${query}`, () => assert.throws(() => isolatedURL({ ...good(), DATABASE_URL: good().DATABASE_URL + '?' + query })));
}
test('real-file boundary rejects unsafe file types and modes before parsing', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-config-test-'));
  const file = path.join(dir, 'config'); fs.writeFileSync(file, 'fixture', {mode: 0o600});
  let calls = 0; const parse = () => { calls++; return good(); };
  assert.equal(readConfiguration(file, parse).PORT, '3001');
  fs.chmodSync(file, 0o644); assert.throws(() => readConfiguration(file, parse));
  fs.symlinkSync(file, path.join(dir, 'link')); assert.throws(() => readConfiguration(path.join(dir, 'link'), parse));
  assert.throws(() => readConfiguration(dir, parse)); assert.equal(calls, 1);
});

test('actual escrow preflight passes with network and process APIs denied', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-no-connect-'));
  const hook = path.join(dir, 'deny.cjs');
  fs.writeFileSync(hook, `const deny=()=>{throw Error('FORBIDDEN_API')};
require('node:net').Socket.prototype.connect=deny;
for(const name of ['node:tls','node:http','node:https','node:dgram','node:child_process']) {
 const mod=require(name); for(const key of ['connect','request','get','createSocket','spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) if(typeof mod[key]==='function')mod[key]=deny;
}`);
  const result = spawnSync(process.execPath, ['--require', hook, path.join(__dirname, 'cold-rebuild-config.cjs'), '--preflight'], {
    env: {PATH: process.env.PATH}, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {status: 'PASS', noConnection: true, isolatedTarget: true});
});
