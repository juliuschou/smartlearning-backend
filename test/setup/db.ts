import {
  blocked,
  identitySql,
  mutationContract,
  verifyIdentity,
} from './mutation-guard';
import { Client } from 'pg';
import { execSync } from 'child_process';
import dotenv from 'dotenv';

// The reviewed launcher URL must survive env-file loading.
dotenv.config({ path: '.env.test', override: false });

/** Apply migrations only after an independently pinned identity check. */
export async function setupTestDb(): Promise<void> {
  const contract = mutationContract('migrate');
  const client = new Client({
    connectionString: contract.endpoint as string,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 5000,
  });
  try {
    await client.connect();
    verifyIdentity(contract, (await client.query(identitySql)).rows);
    // Recheck authorization/config immediately before the separate CLI connection.
    mutationContract('migrate');
    execSync('npx prisma migrate deploy', {
      stdio: 'pipe',
      timeout: 60000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: contract.endpoint as string,
      },
    });
  } catch {
    blocked();
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Truncate all non-migration tables. Call between tests for isolation.
 * Imports the generated client lazily inside the function so this module
 * doesn't fail to load when the client isn't generated yet.
 */
export async function truncateAll(prisma: {
  $transaction: (
    work: (tx: {
      $queryRawUnsafe: (sql: string) => Promise<unknown>;
      $queryRaw: (sql: TemplateStringsArray) => Promise<unknown>;
    }) => Promise<void>,
    options: { timeout: number; maxWait: number },
  ) => Promise<void>;
}): Promise<void> {
  const contract = mutationContract('truncate');
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe("SET LOCAL statement_timeout = '5s'");
        verifyIdentity(contract, await tx.$queryRawUnsafe(identitySql));
        mutationContract('truncate');
        await tx.$queryRaw`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public'
                AND tablename NOT LIKE '_prisma%' AND tablename NOT LIKE '%schema_migrations%')
      LOOP
        EXECUTE format('TRUNCATE TABLE public.%I RESTART IDENTITY CASCADE', r.tablename);
      END LOOP;
    END $$;
      `;
      },
      { timeout: 10000, maxWait: 5000 },
    );
  } catch {
    blocked();
  }
}
