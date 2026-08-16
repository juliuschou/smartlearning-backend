/**
 * One-time deployment bootstrap CLI — creates the first system admin.
 *
 * Run via `npm run bootstrap:admin` (tsx). Credentials are read from env vars
 * `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` /
 * `BOOTSTRAP_ADMIN_DISPLAY_NAME` — never from command-line args or shell
 * history (CLI BDD R-C1-2 posture applied to the bootstrap secret).
 * Interactive stdin / Docker secret is the production target (deferred).
 *
 * Behavior: refuses if already bootstrapped; otherwise creates the first
 * admin and sets `bootstrap_completed = true`. Exits non-zero on failure.
 */
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AppModule } from '../app.module';
import { BootstrapService } from '../modules/identity/application/bootstrap.service';

async function main(): Promise<void> {
  // Load env the same way the app does (envFilePath by NODE_ENV) so the
  // bootstrap CLI shares the validated configuration source.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  // Ensure ConfigModule is initialized even if AppModule is used standalone.
  void ConfigModule;

  const bootstrap = app.get(BootstrapService);
  const permitted = await bootstrap.isPermitted();
  if (!permitted) {
    console.error(
      'Bootstrap not permitted: an admin account already exists or bootstrap_completed is set.',
    );
    process.exitCode = 1;
    await app.close();
    return;
  }

  const admin = await bootstrap.bootstrapFromEnv();
  console.log(
    `Bootstrapped first admin: id=${admin.id} username=${admin.username} role=${admin.role}`,
  );
  await app.close();
}

void main().catch((err) => {
  console.error('Bootstrap failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
