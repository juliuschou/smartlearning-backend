'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { contractFromEvidence } = require('./prepare-test-contract.cjs');
const base = path.resolve(
  __dirname,
  '../../artifacts/local-env/sl-daily-runtime-20261015-01',
);
const read = (name) => fs.readFileSync(path.join(base, name));
const credential =
  'postgresql://test_role:fake@localhost:5432/smartlearning_test';
test('restored expected system is independently pinned and endpoint is isolated', () => {
  const c = contractFromEvidence(read, credential);
  assert.equal(c.system, '7696842547779285008');
  assert.equal(c.cluster, 'sl-daily-runtime-20261015-01');
  assert.equal(c.role, 'test_role');
  assert.equal(new URL(c.endpoint).port, '55433');
});
for (const name of ['restore.json', 'owned.json', 'result.json']) {
  test('rejects changed historical receipt: ' + name, () => {
    assert.throws(() =>
      contractFromEvidence(
        (n) => (n === name ? Buffer.from('{}') : read(n)),
        credential,
      ),
    );
  });
}
for (const bad of [
  credential.replace('localhost', 'remote.invalid'),
  credential.replace('5432', '55433'),
  credential.replace('smartlearning_test', 'smartlearning_dev'),
  credential + '?options=unsafe',
  credential + '?schema=other',
]) {
  test(
    'rejects unsafe provisioning URL ' + bad.replace('fake', 'redacted'),
    () => {
      assert.throws(() => contractFromEvidence(read, bad));
    },
  );
}
