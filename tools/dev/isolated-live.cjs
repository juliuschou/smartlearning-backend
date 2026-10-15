'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');
const { ROLE, policy, rollback } = require('./isolated-role-policy.cjs');
const RUN = 'sl-test-runtime-20261015-02';
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
function readContract(file, digest) {
  assert.ok(path.isAbsolute(file));
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o777, 0o600);
  const bytes = fs.readFileSync(file);
  assert.equal(hash(bytes), digest);
  const c = JSON.parse(bytes);
  const u = new URL(c.endpoint);
  assert.ok(
    ['postgres:', 'postgresql:'].includes(u.protocol) &&
      u.username &&
      u.password,
  );
  assert.equal(u.hostname, '127.0.0.1');
  assert.equal(u.port, '55433');
  assert.equal(u.pathname, '/smartlearning_test');
  assert.equal(decodeURIComponent(u.username), c.role);
  assert.equal(c.db, 'smartlearning_test');
  assert.equal(c.schema, 'public');
  assert.equal(c.cluster, 'sl-daily-runtime-20261015-01');
  assert.match(c.system, /^\d+$/);
  assert.equal(c.recovery, false);
  assert.ok(!u.hash && [...u.searchParams.keys()].every((x) => x === 'schema'));
  assert.ok(
    !u.searchParams.has('schema') || u.searchParams.get('schema') === 'public',
  );
  return c;
}
function psql(container, sql) {
  // container supplied only by lifecycle owner; no TCP admin or source connection.
  const p = cp.spawnSync(
    'docker',
    [
      '--context',
      'default',
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-q',
      '-w',
      '-h',
      '/tmp',
      '-U',
      'full_restore_admin',
      '-d',
      'smartlearning_test',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
    ],
    { input: sql, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(p.status, 0, 'Provisioning failed (output redacted)');
  return p.stdout.trim();
}
function runSuite(phase, contract, file, digest, evidence, authorization) {
  const label =
    phase === 'negative'
      ? authorization === ''
        ? 'negative-authorization'
        : 'negative-identity'
      : phase;
  const report = path.join(evidence, label + '-jest.json');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: contract.endpoint,
    TEST_DB_CONTRACT: file,
    TEST_DB_CONTRACT_SHA256: digest,
    TEST_DB_MUTATIONS:
      authorization ?? (phase === 'executor' ? 'migrate,truncate' : 'truncate'),
    ISOLATED_LIVE_EVIDENCE: evidence,
    REALTIME_REDIS_MODE: 'off',
    LOGIN_RATE_LIMIT_MODE: 'memory',
    BOOTSTRAP_ADMIN_USERNAME: '',
    BOOTSTRAP_ADMIN_PASSWORD: '',
    BOOTSTRAP_ADMIN_DISPLAY_NAME: '',
  };
  const p = cp.spawnSync(
    process.execPath,
    [
      'node_modules/jest/bin/jest.js',
      '--config',
      'test/jest-isolated-' + phase + '.json',
      '--runInBand',
      '--json',
      '--outputFile',
      report,
    ],
    { env, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(p.status, 0, 'Live suite failed (output redacted)');
  const r = JSON.parse(fs.readFileSync(report));
  assert.equal(r.success, true);
  assert.equal(r.numTotalTests, 1);
  assert.equal(r.numPassedTests, 1);
  assert.equal(r.numPendingTests, 0);
  assert.equal(r.numTodoTests, 0);
  // Jest failure details may contain SQL/URLs. Preserve only successful scalar receipt.
  fs.writeFileSync(
    path.join(evidence, label + '-pass.json'),
    JSON.stringify({ passed: 1, skipped: 0 }) + '\n',
    { mode: 0o600 },
  );
}
async function main() {
  assert.equal(process.env.ISOLATED_MUTATION_AUTHORIZATION, RUN);
  const [container, file, digest, evidence] = process.argv.slice(2);
  assert.match(container, /^[a-f0-9]{64}$/);
  const app = readContract(file, digest);
  assert.notEqual(app.role, ROLE);
  const identity = JSON.parse(
    psql(
      container,
      `SELECT row_to_json(x) FROM (SELECT current_database() AS db, current_setting('cluster_name') AS cluster, (SELECT system_identifier::text FROM pg_control_system()) AS system, pg_is_in_recovery() AS recovery) x;`,
    ),
  );
  for (const key of ['db', 'cluster', 'system', 'recovery'])
    assert.equal(identity[key], app[key]);
  // This restore already contains all migrations. Fail on drift/pending migrations:
  // do not accidentally create new objects whose app ACL has not been reviewed.
  const expected = fs
    .readdirSync('prisma/migrations')
    .filter((x) => fs.existsSync('prisma/migrations/' + x + '/migration.sql'))
    .sort();
  const ledger = JSON.parse(
    psql(
      container,
      `SELECT coalesce(json_agg(x ORDER BY migration_name), '[]') FROM (SELECT migration_name, checksum FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) x;`,
    ),
  );
  assert.deepEqual(
    ledger.map((x) => x.migration_name),
    expected,
  );
  for (const row of ledger)
    assert.equal(
      row.checksum,
      hash(
        fs.readFileSync(
          'prisma/migrations/' + row.migration_name + '/migration.sql',
        ),
      ),
    );
  const objects = JSON.parse(
    psql(
      container,
      `SELECT json_agg(x) FROM (SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m') ORDER BY c.oid) x;`,
    ),
  );
  assert.ok(objects.every((x) => x.kind === 'r')); // pinned restore has no sequences/partitions/views
  assert.equal(
    psql(
      container,
      `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p','S','v','m','f') AND n.nspname NOT IN ('public','pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%';`,
    ),
    '0',
  );
  assert.equal(
    psql(
      container,
      `SELECT count(*) FROM pg_depend d JOIN pg_class c ON c.oid=d.objid
    WHERE d.classid='pg_class'::regclass AND d.deptype='e' AND c.relnamespace='public'::regnamespace;`,
    ),
    '0',
  );
  const privateDir = fs.mkdtempSync('/tmp/sl-executor-');
  fs.chmodSync(privateDir, 0o700);
  const password = crypto.randomBytes(32).toString('hex');
  const url = new URL(app.endpoint);
  url.username = ROLE;
  url.password = password;
  const executor = { ...app, role: ROLE, endpoint: url.toString() };
  const execFile = path.join(privateDir, 'contract.json');
  fs.writeFileSync(
    path.join(evidence, 'executor-contract-reference.json'),
    JSON.stringify({ file: execFile }) + '\n',
    { mode: 0o600 },
  );
  const bytes = Buffer.from(JSON.stringify(executor) + '\n');
  fs.writeFileSync(execFile, bytes, { flag: 'wx', mode: 0o600 });
  // App role ACL snapshot for regression comparison; never print raw roles/ACLs.
  assert.match(app.role, /^[a-z_][a-z0-9_]*$/);
  const aclSql = `SELECT coalesce(json_agg(x ORDER BY oid,privilege), '[]') FROM (
    SELECT c.oid,p AS privilege,has_table_privilege('${app.role}',c.oid,p) AS allowed
    FROM pg_class c CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m')
    UNION ALL SELECT 0,p,has_schema_privilege('${app.role}','public',p)
    FROM unnest(ARRAY['USAGE','CREATE']) p) x;`;
  const before = psql(container, aclSql);
  fs.writeFileSync(
    path.join(evidence, 'rollback-roles.sql'),
    rollback(objects),
    { flag: 'wx', mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(evidence, 'app-permissions-before.json'),
    before + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  psql(
    container,
    'BEGIN;\n' + policy(app.role, password, objects) + '\nCOMMIT;',
  );
  assert.equal(psql(container, aclSql), before);
  // TCP executor authentication uses an exact observed peer /32 (lifecycle driver
  // clones only existing app host rules; never source HBA, broad CIDRs or admin).
  const client = new Client({
    connectionString: executor.endpoint,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    await client.query(`INSERT INTO public.system_setting (id,key,value,"updatedAt")
      VALUES ('00000000-0000-4000-8000-000000000016','isolated-negative-sentinel','true'::jsonb,now())`);
  } finally {
    await client.end();
  }
  runSuite('negative', executor, execFile, hash(bytes), evidence, '');
  const wrongFile = path.join(privateDir, 'wrong-identity.json');
  const wrongBytes = Buffer.from(
    JSON.stringify({ ...executor, system: executor.system + '0' }),
  );
  fs.writeFileSync(wrongFile, wrongBytes, { flag: 'wx', mode: 0o600 });
  runSuite(
    'negative',
    executor,
    wrongFile,
    hash(wrongBytes),
    evidence,
    'migrate,truncate',
  );
  runSuite('executor', executor, execFile, hash(bytes), evidence);
  runSuite('app', app, file, digest, evidence);
  assert.equal(psql(container, aclSql), before);
  fs.writeFileSync(
    path.join(evidence, 'app-permissions-after.json'),
    before + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status: 'PASS',
      sharedHelpers: true,
      readiness: true,
      skipped: 0,
    }),
  );
}
module.exports = { readContract, runSuite };
if (require.main === module)
  main().catch(() => {
    console.error(
      'BLOCKED: isolated live acceptance failed; retain private evidence.',
    );
    process.exitCode = 1;
  });
