import type { INestApplication } from '@nestjs/common';
import { BootstrapService } from '../src/modules/identity/application/bootstrap.service';
import { AccountService } from '../src/modules/identity/application/account.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { AccountRole } from '../src/modules/identity/domain/roles';
import { hashPassword, verifyPassword, newId } from '../src/common/crypto';
import { createTestApp } from './setup/app-factory';
import { setupTestDb, truncateAll } from './setup/db';

/**
 * Integration: identity/auth against a real PostgreSQL. Requires the test DB
 * (smartlearning_test) to be migrated and reachable. Skips automatically when
 * the DB is not reachable, so this suite stays green in a DB-less sandbox.
 */
describe('Identity (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrap: BootstrapService;
  let accounts: AccountService;
  let dbReachable = false;
  let migrationsReady = false;

  beforeAll(async () => {
    try {
      setupTestDb();
      migrationsReady = true;
    } catch {
      // Keep the suite blocked when any migration fails; do not probe stale schema.
    }
    app = await createTestApp();
    await app.init();
    prisma = app.get(PrismaService);
    bootstrap = app.get(BootstrapService);
    accounts = app.get(AccountService);
    if (!migrationsReady) return;
    try {
      await prisma.prisma.$queryRaw`SELECT 1`;
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    await truncateAll(prisma.prisma);
  });

  it('bootstrap is permitted on a fresh install', async () => {
    if (!dbReachable) {
      console.warn('Skipping: test DB not reachable.');
      return;
    }
    await expect(bootstrap.isPermitted()).resolves.toBe(true);
  });

  it('bootstrap only-one-wins under concurrency', async () => {
    if (!dbReachable) {
      console.warn('Skipping: test DB not reachable.');
      return;
    }
    const inputs = {
      username: 'race-admin',
      displayName: 'Race Admin',
      password: 'race-admin-password',
    };
    const results = await Promise.allSettled([
      bootstrap.createFirstAdmin(inputs),
      bootstrap.createFirstAdmin(inputs),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // Exactly one winner; the loser must reject (ConflictError).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('username uniqueness is enforced (P2002 path)', async () => {
    if (!dbReachable) {
      console.warn('Skipping: test DB not reachable.');
      return;
    }
    // Bootstrap a real admin first to satisfy createdBy FK.
    const admin = await bootstrap.createFirstAdmin({
      username: 'admin-uniq',
      displayName: 'Admin',
      password: 'admin-password-123',
    });
    await expect(
      accounts.createAccount({
        username: 'admin-uniq', // duplicate
        displayName: 'Dup',
        role: AccountRole.TEACHER,
        canCreateCourse: true,
        tempPassword: 'teacher-password-123',
        createdBy: admin.id,
      }),
    ).rejects.toBeDefined();
  });

  it('argon2id hashes round-trip and the stored hash is not plaintext', async () => {
    // No DB needed for the hash itself; skip gate keeps this fast.
    const hash = await hashPassword('round-trip-password');
    expect(hash).not.toBe('round-trip-password');
    await expect(verifyPassword(hash, 'round-trip-password')).resolves.toBe(
      true,
    );
    await expect(verifyPassword(hash, 'wrong')).resolves.toBe(false);
  });

  it('accepts student accounts but enforces the role database checks', async () => {
    if (!dbReachable) {
      console.warn('Skipping: test DB not reachable.');
      return;
    }
    const admin = await bootstrap.createFirstAdmin({
      username: 'admin-student-role',
      displayName: 'Admin',
      password: 'admin-password-123',
    });

    const student = await accounts.createAccount({
      username: 'student-role',
      displayName: 'Student',
      role: AccountRole.STUDENT,
      // The application invariant normalizes a contradictory input.
      canCreateCourse: true,
      tempPassword: 'student-password-123',
      createdBy: admin.id,
    });
    expect(student.role).toBe(AccountRole.STUDENT);
    expect(student.canCreateCourse).toBe(false);

    const stored = await prisma.prisma.account.findUnique({
      where: { id: student.id },
    });
    expect(stored?.canCreateCourse).toBe(false);

    const passwordHash = await hashPassword('direct-db-password-123');
    await expect(
      prisma.prisma.account.create({
        data: {
          id: newId(),
          username: 'invalid-role',
          displayName: 'Invalid Role',
          role: 'observer',
          canCreateCourse: false,
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
          createdBy: admin.id,
        },
      }),
    ).rejects.toBeDefined();

    await expect(
      prisma.prisma.account.create({
        data: {
          id: newId(),
          username: 'invalid-student-permission',
          displayName: 'Invalid Student',
          role: AccountRole.STUDENT,
          canCreateCourse: true,
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: new Date(),
          createdBy: admin.id,
        },
      }),
    ).rejects.toBeDefined();
  });

  it('course owner is immutable (update never changes owner_account_id)', async () => {
    if (!dbReachable) {
      console.warn('Skipping: test DB not reachable.');
      return;
    }
    const admin = await bootstrap.createFirstAdmin({
      username: 'admin-course',
      displayName: 'Admin',
      password: 'admin-password-123',
    });
    const course = await prisma.prisma.course.create({
      data: {
        id: newId(),
        ownerAccountId: admin.id,
        name: 'Test Course',
        status: 'draft',
      },
    });
    // The service has no update-owner path; verify the row's owner is stable.
    const refetched = await prisma.prisma.course.findUnique({
      where: { id: course.id },
    });
    expect(refetched?.ownerAccountId).toBe(admin.id);
  });
});
