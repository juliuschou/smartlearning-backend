import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { setupTestDb, truncateAll } from './setup/db';
import {
  identitySql,
  mutationContract,
  verifyIdentity,
} from './setup/mutation-guard';

jest.setTimeout(90000);

test('real shared migration and truncate complete with an empty application database', async () => {
  await setupTestDb();
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  try {
    await prisma.$connect();
    verifyIdentity(
      mutationContract('truncate'),
      await prisma.$queryRawUnsafe(identitySql),
    );
    // CASCADE must not reach a non-public table or a partition outside public.
    const dependencies = await prisma.$queryRawUnsafe<{ count: bigint }[]>(`
      SELECT count(*) FROM (
        SELECT conrelid AS oid FROM pg_constraint WHERE contype='f'
          AND confrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
        UNION SELECT inhrelid FROM pg_inherits
          WHERE inhparent IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
      ) d JOIN pg_class c ON c.oid=d.oid
      WHERE c.relnamespace <> 'public'::regnamespace`);
    expect(Number(dependencies[0].count)).toBe(0);
    // A real inserted sentinel proves truncate did work even on an empty restore.
    await prisma.$executeRawUnsafe(`INSERT INTO public.system_setting
      (id, key, value, "updatedAt")
      VALUES ('00000000-0000-4000-8000-000000000015', 'isolated-runtime-sentinel', 'true'::jsonb, now())`);
    await truncateAll(prisma);
    const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE '_prisma%' AND tablename NOT LIKE '%schema_migrations%'",
    );
    expect(tables.length).toBeGreaterThan(0);
    for (const { tablename } of tables) {
      const quoted = '"' + tablename.replaceAll('"', '""') + '"';
      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*) FROM public.${quoted}`,
      );
      expect(Number(rows[0].count)).toBe(0);
    }
    const ledger = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    expect(Number(ledger[0].count)).toBeGreaterThan(0);
  } finally {
    await prisma.$disconnect();
  }
});
