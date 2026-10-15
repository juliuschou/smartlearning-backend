'use strict';
// SQL builder only. Caller must verify identity on its provisioning connection.
const assert = require('node:assert/strict');
const ROLE = 'sl_isolated_test_executor';
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
function policy(appRole, password, objects) {
  assert.match(appRole, /^[a-z_][a-z0-9_]*$/);
  assert.notEqual(appRole, ROLE);
  assert.match(password, /^[a-f0-9]{64}$/);
  assert.ok(objects.length > 0);
  assert.ok(
    objects.every(
      (x) =>
        ['r', 'p', 'S', 'v', 'm'].includes(x.kind) && x.schema === 'public',
    ),
  );
  const statements = [
    "SET LOCAL password_encryption = 'scram-sha-256'",
    `CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${password}'`,
    `GRANT CONNECT ON DATABASE smartlearning_test TO ${ROLE}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${ROLE}`,
    `GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${ROLE}`,
  ];
  // ALTER/DROP/RESTART IDENTITY require ownership, not just DML/TRUNCATE grants.
  // Never REASSIGN OWNED: it could transfer shared or other-database objects.
  for (const x of objects) {
    const type = {
      r: 'TABLE',
      p: 'TABLE',
      S: 'SEQUENCE',
      v: 'VIEW',
      m: 'MATERIALIZED VIEW',
    }[x.kind];
    statements.push(`ALTER ${type} public.${quote(x.name)} OWNER TO ${ROLE}`);
  }
  // Existing ACLs survive ownership transfer. Only newly created tables need
  // app grants; never broaden privileges on the restored application objects.
  // Current acceptance requires no pending migrations (see launcher preflight).
  return statements.join(';\n') + ';';
}
function rollback(objects) {
  assert.ok(objects.length > 0);
  return (
    'BEGIN;\n' +
    objects
      .map((x) => {
        assert.equal(x.schema, 'public');
        assert.ok(typeof x.owner === 'string' && x.owner);
        const type = {
          r: 'TABLE',
          p: 'TABLE',
          S: 'SEQUENCE',
          v: 'VIEW',
          m: 'MATERIALIZED VIEW',
        }[x.kind];
        assert.ok(type);
        return `ALTER ${type} public.${quote(x.name)} OWNER TO ${quote(x.owner)};`;
      })
      .join('\n') +
    `\nREVOKE USAGE, CREATE ON SCHEMA public FROM ${ROLE};
REVOKE CONNECT ON DATABASE smartlearning_test FROM ${ROLE};
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system() FROM ${ROLE};
DROP ROLE ${ROLE};
COMMIT;\n`
  );
}
module.exports = { ROLE, policy, rollback };
