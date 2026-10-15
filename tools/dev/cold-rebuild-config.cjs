'use strict';
const assert = require('node:assert/strict');
function validate(approved) {
  const url = new URL(approved.DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  const query = [...url.searchParams];
  assert.ok(query.length === 0 || (query.length === 1 && query[0][0] === 'schema' && query[0][1] === 'public'));
  assert.equal(url.hash, '');
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '5432');
  assert.equal(url.pathname, '/smartlearning_test');
  assert.ok(url.username && url.password);
  assert.match(decodeURIComponent(url.username), /^[a-z_][a-z0-9_]*$/);
  assert.equal(approved.PORT, '3001');
  assert.ok(approved.COOKIE_SECRET && approved.CORS_ORIGIN);
  assert.ok(!approved.NODE_ENV || approved.NODE_ENV === 'test');
  for (const [key, value] of Object.entries(approved)) {
    if (key !== 'DATABASE_URL' && (/DATABASE.*URL|DIRECT.*URL|SHADOW.*URL/.test(key) ||
      /REDIS.*URL|FAILPOINT|BOOTSTRAP_|^S3_|NODE_OPTIONS|NODE_PATH|LD_PRELOAD|FE42_RESPONSE_LOSS_TOKEN/.test(key))) assert.ok(!value);
    if (key.startsWith('RETENTION_') && key.endsWith('_ENABLED')) assert.ok(!value || ['false', '0'].includes(value));
  }
  assert.ok(!approved.REALTIME_REDIS_MODE || approved.REALTIME_REDIS_MODE === 'off');
  assert.ok(!approved.LOGIN_RATE_LIMIT_MODE || approved.LOGIN_RATE_LIMIT_MODE === 'memory');
  assert.ok(!approved.DELETION_MANIFEST_PROVIDER || approved.DELETION_MANIFEST_PROVIDER === 'local');
  return decodeURIComponent(url.username);
}
function isolatedURL(approved) {
  validate(approved);
  const url = new URL(approved.DATABASE_URL);
  url.search = '';
  url.hostname = '127.0.0.1';
  url.port = '55433';
  return url;
}
function readConfiguration(file, parse) {
  const fs = require('node:fs');
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o600);
  const approved = parse(fs.readFileSync(file));
  isolatedURL(approved);
  return approved;
}
module.exports = { validate, isolatedURL, readConfiguration };
if (require.main === module) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.resolve(__dirname, '../..');
    const file = path.join(root, '.env.test');
    const preparation = process.argv[2] === '--preflight';
    assert.ok(preparation || process.argv.length === 2);
    const dotenv = require(preparation ? path.join(root, 'node_modules/dotenv') :
      path.join(root, 'artifacts/local-env/sl-cold-rebuild-20261015-04/build/node_modules/dotenv'));
    const approved = readConfiguration(file, dotenv.parse);
    fs.writeSync(1, JSON.stringify(preparation ? {status: 'PASS', noConnection: true, isolatedTarget: true} : validate(approved)) + '\n');
  } catch { console.error('CONFIGURATION_REJECTED'); process.exitCode = 1; }
}
