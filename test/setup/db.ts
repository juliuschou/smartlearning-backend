import { execSync } from 'child_process';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test', override: true });

/**
 * Per-suite test DB setup.
 *
 * Ensures the test database (smartlearning_test per .env.test) has migrations
 * applied and is in a clean state. Each integration/e2e suite should call
 * `setupTestDb()` in `beforeAll` and `truncateAll()` between tests when needed.
 *
 * Uses the Prisma CLI (which reads .env.test via prisma.config.ts) rather than
 * embedding connection strings, so no secrets appear in the test process env.
 */

/** Apply migrations to the test database (idempotent). */
export function setupTestDb(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('BLOCKED: .env.test did not provide DATABASE_URL.');
  }
  let databaseName: string;
  try {
    databaseName = new URL(databaseUrl).pathname.slice(1);
  } catch {
    throw new Error('BLOCKED: .env.test DATABASE_URL is invalid.');
  }
  if (databaseName !== 'smartlearning_test') {
    throw new Error(
      'BLOCKED: test setup refuses to mutate a non-test PostgreSQL database.',
    );
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'test' },
  });
}

/**
 * Truncate all non-migration tables. Call between tests for isolation.
 * Imports the generated client lazily inside the function so this module
 * doesn't fail to load when the client isn't generated yet.
 */
export async function truncateAll(prisma: {
  $queryRaw: (sql: TemplateStringsArray) => Promise<unknown>;
}): Promise<void> {
  // Truncate every user table except the Prisma migration shadow tables.
  await prisma.$queryRaw`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public'
                AND tablename NOT LIKE '_prisma%' AND tablename NOT LIKE '%schema_migrations%')
      LOOP
        EXECUTE 'TRUNCATE TABLE "' || r.tablename || '" RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `;
}
