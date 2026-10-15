import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const identitySql = `SELECT current_database() AS db, current_user AS role,
 current_schema() AS schema, current_setting('cluster_name') AS cluster,
 (SELECT system_identifier::text FROM pg_control_system()) AS system,
 pg_is_in_recovery() AS recovery`;

export function blocked(): never {
  throw new Error(
    'BLOCKED: test mutation identity/authorization check failed.',
  );
}

export function mutationContract(operation: 'migrate' | 'truncate') {
  try {
    if (launchEnvironment !== 'test' || process.env.NODE_ENV !== 'test')
      blocked();
    // Capture authorization independently of dotenv; env files cannot grant it.
    if (!authorization.split(',').includes(operation)) blocked();
    const bytes = readFileSync(contractPath);
    if (createHash('sha256').update(bytes).digest('hex') !== contractHash)
      blocked();
    const contract = JSON.parse(bytes.toString()) as Record<string, unknown>;
    for (const key of [
      'db',
      'role',
      'schema',
      'cluster',
      'system',
      'endpoint',
    ]) {
      if (typeof contract[key] !== 'string' || !contract[key]) blocked();
    }
    if (
      contract.db !== 'smartlearning_test' ||
      contract.schema !== 'public' ||
      !/^\d+$/.test(contract.system as string) ||
      contract.recovery !== false
    )
      blocked();
    if (process.env.DATABASE_URL !== contract.endpoint) blocked();
    const url = new URL(contract.endpoint as string);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      decodeURIComponent(url.pathname.slice(1)) !== contract.db ||
      decodeURIComponent(url.username) !== contract.role ||
      [...url.searchParams.keys()].some((key) => key !== 'schema') ||
      (url.searchParams.has('schema') &&
        url.searchParams.get('schema') !== 'public')
    )
      blocked();
    return contract;
  } catch {
    return blocked();
  }
}

// Loaded before db.ts loads dotenv. Explicit launcher inputs, never .env.test.
const launchEnvironment = process.env.NODE_ENV;
const authorization = process.env.TEST_DB_MUTATIONS ?? '';
const contractPath = process.env.TEST_DB_CONTRACT ?? '';
const contractHash = process.env.TEST_DB_CONTRACT_SHA256 ?? '';

export function verifyIdentity(
  contract: Record<string, unknown>,
  rows: unknown,
) {
  if (!Array.isArray(rows) || rows.length !== 1) blocked();
  const row = rows[0] as Record<string, unknown> | null;
  if (
    !row ||
    ['db', 'role', 'schema', 'cluster', 'system', 'recovery'].some(
      (key) => row[key] !== contract[key],
    )
  )
    blocked();
}
