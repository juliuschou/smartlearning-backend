'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertRunRecord } = require('./assert-integration-ready.cjs');
const {
  accountNameFor,
  normalizeEmail,
  validateName,
  validatePassword,
  provisionAccount,
  revokeAccount,
} = require('./ui-test-account.cjs');

test('requires an exact, clean test run record before allowing a target', () => {
  const runId = '20261115-abcd1234';
  const record = {
    runId,
    project: `sltest-${runId}`,
    database: 'smartlearning_test',
    schema: 'app',
    port: 5432,
    state: 'running-clean',
  };
  assert.doesNotThrow(() => assertRunRecord(runId, record));
  assert.throws(() => assertRunRecord(runId, { ...record, project: 'other-project' }), /exact/);
  assert.throws(() => assertRunRecord(runId, { ...record, state: 'stopped' }), /exact/);
  assert.throws(() => assertRunRecord('invalid', record), /exact/);
});

function fakeClient(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql: String(sql), values });
      return handler(String(sql), values, calls.length - 1);
    },
  };
}

test('validates login inputs using the auth password bounds', () => {
  assert.equal(normalizeEmail(' teacher@example.test '), 'teacher@example.test');
  assert.throws(() => normalizeEmail('not-an-email'), /Email/);
  assert.equal(validateName('老師 測試'), '老師 測試');
  assert.throws(() => validateName('   '), /姓名/);
  assert.equal(validatePassword('密碼123456'), '密碼123456');
  assert.throws(() => validatePassword('short'), /密碼/);
  assert.throws(() => validatePassword('a'.repeat(1025)), /密碼/);
});

test('derives a deterministic, non-secret account name scoped to run and email', () => {
  const name = accountNameFor('20261115-abcd1234', 'teacher@example.test');
  assert.match(name, /^uitest-[a-f0-9]{20}$/);
  assert.equal(name, accountNameFor('20261115-abcd1234', 'TEACHER@example.test'));
  assert.notEqual(name, accountNameFor('another-run-123', 'teacher@example.test'));
});

test('creates only an active verified TEACHER account with a password hash', async () => {
  const client = fakeClient((sql, values) => {
    if (sql.includes('INSERT INTO app.role')) {
      return { rowCount: 1, rows: [{ id: 'role-id', name: '老師', is_system_reserved: true, status: 'ENABLED' }] };
    }
    if (sql.includes('INSERT INTO app.user_account')) {
      assert.equal(values[0], 'teacher@example.test');
      assert.equal(values[1], 'argon2-hash');
      assert.equal(values[2], '測試老師');
      assert.equal(values[3], accountNameFor('run-123456', 'teacher@example.test'));
      return { rowCount: 1, rows: [{ id: 'account-id', email: values[0], account_name: values[3] }] };
    }
    return { rowCount: 1, rows: [] };
  });
  const result = await provisionAccount({
    runId: 'run-123456', email: 'teacher@example.test', name: '測試老師', password: 'secret-pass', client,
    hashPassword: async (password) => {
      assert.equal(password, 'secret-pass');
      return 'argon2-hash';
    },
  });
  assert.equal(result.roleCode, 'TEACHER');
  const insert = client.calls.find((call) => call.sql.includes('INSERT INTO app.user_account'));
  assert.match(insert.sql, /TRUE/);
  assert.match(insert.sql, /'ACTIVE'/);
  assert.ok(!JSON.stringify(client.calls).includes('secret-pass'));
  assert.deepEqual(client.calls.slice(-1)[0].sql, 'COMMIT');
  assert.ok(client.calls.some((call) => call.sql.includes("VALUES ('TEACHER'")));
  assert.ok(!client.calls.some((call) => call.sql.includes('SYSTEM_ADMIN')));
});

test('rejects a pre-existing disabled or non-canonical TEACHER role transactionally', async () => {
  const client = fakeClient((sql) => {
    if (sql.includes('INSERT INTO app.role')) return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT id, name')) {
      return { rowCount: 1, rows: [{ id: 'role-id', name: 'Unexpected', is_system_reserved: true, status: 'ENABLED' }] };
    }
    return { rowCount: 1, rows: [] };
  });
  await assert.rejects(
    provisionAccount({ runId: 'run-123456', email: 'teacher@example.test', name: '老師', password: 'secret-pass', client, hashPassword: async () => 'hash-value' }),
    /固定角色目錄/,
  );
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
  assert.ok(!client.calls.some((call) => call.sql.includes('INSERT INTO app.user_account')));
});

test('duplicate account identity rolls back without disclosing the password', async () => {
  const client = fakeClient((sql) => {
    if (sql.includes('INSERT INTO app.role')) return { rowCount: 1, rows: [{ id: 'role-id', name: '老師', is_system_reserved: true, status: 'ENABLED' }] };
    if (sql.includes('INSERT INTO app.user_account')) throw Object.assign(new Error('unique'), { code: '23505' });
    return { rowCount: 1, rows: [] };
  });
  await assert.rejects(
    provisionAccount({ runId: 'run-123456', email: 'teacher@example.test', name: '老師', password: 'secret-pass', client, hashPassword: async () => 'hash-value' }),
    /已存在/,
  );
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
});

test('revoke scopes session invalidation and account disable to the run-derived identity', async () => {
  const client = fakeClient((sql, values) => {
    if (sql.includes('SELECT account.id')) return { rowCount: 1, rows: [{ id: 'account-id' }] };
    return { rowCount: 1, rows: [] };
  });
  const result = await revokeAccount({ runId: 'run-123456', email: 'teacher@example.test', client });
  assert.equal(result.disabled, true);
  assert.ok(client.calls.some((call) => call.sql.includes("SET status = 'REVOKED'") && call.values[0] === 'account-id'));
  assert.ok(client.calls.some((call) => call.sql.includes("SET status = 'DISABLED'") && call.values[1] === accountNameFor('run-123456', 'teacher@example.test')));
  assert.equal(client.calls.at(-1).sql, 'COMMIT');
});

test('revoke refuses an account not created for this exact run', async () => {
  const client = fakeClient((sql) => sql.includes('SELECT account.id') ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [] });
  await assert.rejects(revokeAccount({ runId: 'run-123456', email: 'someone@example.test', client }), /找不到/);
  assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(client.calls.some((call) => call.sql.includes('UPDATE app.user_account')), false);
});
