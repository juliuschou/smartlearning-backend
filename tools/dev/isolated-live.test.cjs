'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { readContract, runSuite } = require('./isolated-live.cjs');
const dir = fs.mkdtempSync('/tmp/sl-live-offline-');
const c = {
  db: 'smartlearning_test',
  role: 'app_user',
  schema: 'public',
  cluster: 'sl-daily-runtime-20261015-01',
  system: '12345',
  recovery: false,
  endpoint: 'postgresql://app_user:fake@127.0.0.1:55433/smartlearning_test',
};
const file = path.join(dir, 'contract.json');
function write(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
test('private pinned contract accepts only isolated endpoint and digest', () => {
  const digest = write(c);
  assert.deepEqual(readContract(file, digest), c);
  assert.throws(() => readContract(file, 'bad'));
  for (const patch of [
    { endpoint: c.endpoint.replace('55433', '5432') },
    { role: 'wrong' },
    { recovery: true },
    { cluster: 'source' },
  ]) {
    const digest = write({ ...c, ...patch });
    assert.throws(() => readContract(file, digest));
  }
  const good = write(c);
  fs.chmodSync(file, 0o644);
  assert.throws(() => readContract(file, good));
  fs.chmodSync(file, 0o600);
});
test('launcher supplies distinct pre-import environments and rejects skip/failure', () => {
  const original = cp.spawnSync;
  let report = {
    success: true,
    numTotalTests: 1,
    numPassedTests: 1,
    numPendingTests: 0,
    numTodoTests: 0,
  };
  let env;
  cp.spawnSync = (_bin, args, options) => {
    env = options.env;
    fs.writeFileSync(args[args.length - 1], JSON.stringify(report));
    return { status: 0 };
  };
  try {
    runSuite('executor', c, file, 'digest', dir);
    assert.equal(env.DATABASE_URL, c.endpoint);
    assert.equal(env.TEST_DB_MUTATIONS, 'migrate,truncate');
    runSuite('app', c, file, 'digest', dir);
    assert.equal(env.TEST_DB_MUTATIONS, 'truncate');
    assert.equal(env.BOOTSTRAP_ADMIN_PASSWORD, '');
    for (const patch of [
      { numPendingTests: 1 },
      { numTotalTests: 0 },
      { numPassedTests: 0 },
      { success: false },
    ]) {
      const saved = report;
      report = { ...report, ...patch };
      assert.throws(() => runSuite('executor', c, file, 'digest', dir));
      report = saved;
    }
    cp.spawnSync = () => ({ status: null });
    assert.throws(() => runSuite('executor', c, file, 'digest', dir));
  } finally {
    cp.spawnSync = original;
  }
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
