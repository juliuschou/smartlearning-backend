import { execSync } from 'child_process';

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
