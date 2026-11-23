/**
 * One-time deployment bootstrap CLI — creates the first system administrator.
 *
 * Run via `npm run bootstrap:admin`. Credentials come from environment
 * variables `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_NAME` /
 * `BOOTSTRAP_ADMIN_PASSWORD`, never from command-line arguments (keeping
 * secrets out of shell history and container metadata). See
 * docs/智學互動平台/20_系統分析/第一個帳號與角色建立指引.md:
 * the account and its SYSTEM_ADMIN assignment must commit in one database
 * transaction; rerunning on an already-bootstrapped environment is a safe
 * no-op; any failure rolls back and exits non-zero. Credential delivery
 * channel and disabling this entry point after bootstrap are deployment
 * contracts (待核定) outside this script.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma-app/client';
import { bootstrapAdmin } from './bootstrap-admin.core';

async function main(): Promise<void> {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim();
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD;

  const connectionString =
    process.env.DATABASE_URL?.trim() ||
    failConfig('DATABASE_URL is required for bootstrap.');
  const client = new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      connectionTimeoutMillis: 5000,
    }),
  });
  try {
    const result = await bootstrapAdmin(client, {
      email,
      name,
      password,
    });
    if (result.outcome === 'CREATED') {
      console.log(
        `Bootstrapped first system administrator: id=${result.accountId}`,
      );
      console.log(
        'Reminder: disable this bootstrap entry point after initial setup (deployment contract).',
      );
    } else {
      console.log(
        'Already bootstrapped: an active system administrator exists. No changes were made.',
      );
    }
  } finally {
    await client.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(
    `Bootstrap failed: ${error instanceof Error ? error.message : 'unexpected error'}`,
  );
  process.exitCode = 1;
});

function failConfig(message: string): never {
  throw new Error(message);
}
