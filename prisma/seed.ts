/**
 * Prisma seed — run via `npm run prisma:seed` (tsx).
 * Minimal: ensure a `bootstrap_completed=false` system setting exists so the
 * bootstrap CLI can detect a fresh install.
 *
 * Idempotent: upserts on key. Safe to run repeatedly.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { v7 as uuidv7 } from 'uuid';

const connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
  throw new Error('DATABASE_URL is not set; cannot seed.');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main(): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: 'bootstrap_completed' },
    update: {},
    create: {
      // App-layer UUID v7 (M2 關鍵技術決策 §1); seed runs outside Nest DI so
      // generate directly via the uuid lib used by common/crypto/uuid.ts.
      id: uuidv7(),
      key: 'bootstrap_completed',
      value: { completed: false },
    },
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });