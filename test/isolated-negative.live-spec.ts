import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { setupTestDb, truncateAll } from './setup/db';

jest.setTimeout(30000);
test('unauthorized or mismatched contract fails both real shared helpers', async () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  try {
    await prisma.$connect();
    const before = await prisma.$queryRawUnsafe(
      'SELECT count(*)::text AS count FROM public.system_setting',
    );
    expect(JSON.stringify(before)).not.toBe('[{"count":"0"}]');
    await expect(setupTestDb()).rejects.toThrow('BLOCKED:');
    await expect(truncateAll(prisma)).rejects.toThrow('BLOCKED:');
    expect(
      await prisma.$queryRawUnsafe(
        'SELECT count(*)::text AS count FROM public.system_setting',
      ),
    ).toEqual(before);
  } finally {
    await prisma.$disconnect();
  }
});
