import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AuthModule } from '../common/auth';
import { validateEnv } from '../config/env.validation';
import { IdentityModule } from '../modules/identity/identity.module';
import { AccountService } from '../modules/identity/application/account.service';
import { BootstrapService } from '../modules/identity/application/bootstrap.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.test', '.env'],
      validate: validateEnv,
    }),
    PrismaModule,
    AuthModule,
    IdentityModule,
  ],
})
class LocalProvisioningModule {}

function requireLocalTarget(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'test')
    throw new Error('Local W1 provisioning requires NODE_ENV=test.');
  if (env.LOCAL_W1_PROVISIONING_ENABLED !== '1')
    throw new Error('LOCAL_W1_PROVISIONING_ENABLED=1 is required.');
  if (env.LOCAL_PROVISION_TARGET !== 'disposable')
    throw new Error('LOCAL_PROVISION_TARGET=disposable is required.');
  if (!env.DATABASE_URL?.includes('smartlearning_test'))
    throw new Error('DATABASE_URL must target smartlearning_test.');
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  requireLocalTarget();
  const command = process.argv[2];
  if (command !== 'provision' && command !== 'cleanup')
    throw new Error('Use provision or cleanup.');

  const username = required('LOCAL_W1_TEACHER_USERNAME');
  const createdBy = required('LOCAL_W1_PROVISION_CREATED_BY');
  if (!username.startsWith('local-w1-'))
    throw new Error('LOCAL_W1_TEACHER_USERNAME must start with local-w1-.');

  const app = await NestFactory.createApplicationContext(
    LocalProvisioningModule,
    {
      logger: ['error', 'warn'],
    },
  );
  try {
    const accounts = app.get(AccountService);
    if (command === 'provision') {
      const account = await accounts.createLocalW1Teacher({
        username,
        displayName:
          process.env.LOCAL_W1_TEACHER_DISPLAY_NAME ?? 'Local W1 Load Teacher',
        password: required('LOCAL_W1_TEACHER_PASSWORD'),
        createdBy,
      });
      process.stdout.write(
        `Provisioned local W1 teacher: username=${account.username} accountId=${account.id}\n`,
      );
    } else {
      const account = await accounts.disableLocalW1Teacher(username, createdBy);
      process.stdout.write(
        account
          ? `Disabled local W1 teacher: username=${account.username} accountId=${account.id}\n`
          : 'Local W1 teacher already absent.\n',
      );
    }
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Provisioning failed.'}\n`,
  );
  process.exitCode = 2;
});
