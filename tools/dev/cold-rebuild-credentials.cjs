'use strict';
// Passwords exist only in private file, memory and protected child stdin.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const req = require('node:module').createRequire(path.join(root, 'artifacts/local-env/sl-cold-rebuild-20261015-04/build/package.json'));
const { Client } = req('pg');
const cid = process.env.RESTORE_ID;
function docker(args, input) {
  const result = spawnSync('docker', ['--context', 'default', ...args], {
    input, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0);
}
async function main() {
  assert.match(cid, /^[a-f0-9]{64}$/);
  const proof = spawnSync('python3', ['-B', 'tools/dev/cold-rebuild.py', '--check-restore', cid],
    { cwd: root, encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH } });
  assert.equal(proof.status, 0);
  const file = path.join(root, '.env.test');
  assert.ok(!fs.lstatSync(file).isSymbolicLink());
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const approved = req('dotenv').parse(fs.readFileSync(file));
  const role = require('./cold-rebuild-config.cjs').validate(approved);
  const url = require('./cold-rebuild-config.cjs').isolatedURL(approved);
  const password = decodeURIComponent(url.password);
  assert.ok(!password.includes('\0'));
  const literal = "'" + password.replaceAll("'", "''") + "'";
  docker(['exec', '-i', cid, 'psql', '-X', '-w', '-h', '/tmp', '-U', 'full_restore_admin',
    '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'],
    `SET standard_conforming_strings=on; SET password_encryption='scram-sha-256'; ALTER ROLE "${role}" PASSWORD ${literal};`);
  // Existing HBA contains only local trust and exact app/private-peer host rules.
  docker(['exec', cid, 'sed', '-i', '/^host /s/ trust$/ scram-sha-256/', '/var/lib/postgresql/data/pg_hba.conf']);
  docker(['exec', cid, 'psql', '-X', '-w', '-h', '/tmp', '-U', 'full_restore_admin', '-d', 'postgres',
    '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT pg_reload_conf();']);
  await new Promise(resolve => setTimeout(resolve, 500));
  const wrong = new Client({ host: '127.0.0.1', port: 55433, database: 'smartlearning_test',
    user: role, password: password + '-deliberately-invalid', ssl: false,
    connectionTimeoutMillis: 5000 });
  let rejected = false;
  try { await wrong.connect(); } catch (error) { rejected = error.code === '28P01'; }
  finally { await wrong.end().catch(() => {}); }
  assert.ok(rejected);
  // Actual password verified by the read-only SQL verifier before app start.
  console.log('SCRAM_RECOVERY_PASS');
}
main().catch(() => { console.error('CREDENTIAL_RECOVERY_REJECTED'); process.exitCode = 1; });
