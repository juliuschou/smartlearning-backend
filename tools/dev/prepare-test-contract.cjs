'use strict';
// Offline only. No SQL, lifecycle commands or mutation authorization.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const dotenv = require('dotenv');
const root = path.resolve(__dirname, '../..');
const run = 'sl-daily-runtime-20261015-01';
const pins = {
  'restore.json':
    'ab84cb71f1ddd0a3cc055985dd286aee71324680d7d160109a876ffcbec396af',
  'owned.json':
    '4e15eee7ef7587bb22a911f04cba6736bdfe0f7ba40a84b397eabdf6b3717f19',
  'result.json':
    '3f700fb7e27cd96d38be03a67b82950cd3abebbcd8d680aad650e1e4a271c5ba',
};
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function contractFromEvidence(read, credential) {
  const evidence = {};
  for (const [name, digest] of Object.entries(pins)) {
    const bytes = read(name);
    assert.equal(hash(bytes), digest);
    evidence[name] = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  }
  const restore = evidence['restore.json'];
  const owned = evidence['owned.json'];
  const result = evidence['result.json'];
  assert.equal(result.status, 'PASS');
  assert.equal(result.ownedContainer, owned.id);
  assert.equal(owned.volume, run + '-data');
  assert.equal(owned.network, run + '-net');
  const expected = restore.restoreIdentity;
  assert.equal(expected.cluster, run);
  assert.equal(expected.database, 'smartlearning_test');
  assert.equal(expected.schema, 'public');
  assert.equal(expected.recovery, false);
  assert.match(expected.system, /^\d+$/);
  assert.notEqual(expected.system, restore.sourceIdentity.system);
  const url = new URL(credential);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.port, '5432');
  assert.equal(url.pathname, '/smartlearning_test');
  assert.ok(url.username && url.password && !url.hash);
  assert.ok([...url.searchParams.keys()].every((k) => k === 'schema'));
  assert.ok(
    !url.searchParams.has('schema') ||
      url.searchParams.get('schema') === 'public',
  );
  // Role comes from the separately provisioned credential file, never candidate SQL.
  // Its current effective permissions still require the authorized live audit.
  const role = decodeURIComponent(url.username);
  assert.match(role, /^[a-z_][a-z0-9_]*$/);
  url.hostname = '127.0.0.1';
  url.port = '55433';
  return {
    db: expected.database,
    role,
    schema: expected.schema,
    cluster: expected.cluster,
    system: expected.system,
    recovery: false,
    endpoint: url.toString(),
  };
}
function main() {
  const envFile = path.join(root, '.env.test');
  const stat = fs.lstatSync(envFile);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o600);
  const credential = dotenv.parse(fs.readFileSync(envFile)).DATABASE_URL;
  const contract = contractFromEvidence(
    (name) =>
      fs.readFileSync(path.join(root, 'artifacts/local-env', run, name)),
    credential,
  );
  const directory = fs.mkdtempSync('/tmp/sl-test-contract-');
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'contract.json');
  const bytes = Buffer.from(JSON.stringify(contract) + '\n');
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({
      status: 'PREPARED_NOT_AUTHORIZED',
      file,
      sha256: hash(bytes),
      evidencePins: pins,
      roleSource:
        'private provisioning credential; live permissions NOT verified',
      endpoint: '127.0.0.1:55433/smartlearning_test',
    }),
  );
}
module.exports = { contractFromEvidence };
if (require.main === module) {
  try {
    main();
  } catch {
    console.error('BLOCKED: offline contract preparation failed.');
    process.exitCode = 1;
  }
}
