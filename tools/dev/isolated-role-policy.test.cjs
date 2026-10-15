'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { policy, ROLE, rollback } = require('./isolated-role-policy.cjs');
const obj = [{ schema: 'public', name: 'a"b', kind: 'r' }];
test('executor owns isolated objects without app grants or shared ownership rewrite', () => {
  const sql = policy('app_user', 'a'.repeat(64), obj);
  assert.ok(sql.includes('NOSUPERUSER NOCREATEDB NOCREATEROLE'));
  assert.ok(sql.includes('ALTER TABLE public."a""b" OWNER TO ' + ROLE));
  assert.ok(!sql.includes('TO app_user') && !sql.includes('REASSIGN OWNED'));
});
for (const [name, role, password, objects] of [
  ['role injection', 'a;DROP ROLE x', 'a'.repeat(64), obj],
  ['executor equals app', ROLE, 'a'.repeat(64), obj],
  ['password injection', 'app_user', "'bad", obj],
  [
    'other schema',
    'app_user',
    'a'.repeat(64),
    [{ ...obj[0], schema: 'private' }],
  ],
  [
    'unsupported object',
    'app_user',
    'a'.repeat(64),
    [{ ...obj[0], kind: 'f' }],
  ],
])
  test(name, () => assert.throws(() => policy(role, password, objects)));

test('rollback restores exact owners and removes only dedicated executor', () => {
  const sql = rollback([{ ...obj[0], owner: 'old"owner' }]);
  assert.ok(sql.includes('OWNER TO "old""owner"'));
  assert.ok(sql.includes('DROP ROLE ' + ROLE));
  assert.ok(!sql.includes('DROP TABLE') && !sql.includes('REASSIGN OWNED'));
});
