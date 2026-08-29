import { AccountService } from './account.service';
import { AccountRole } from '../domain/roles';
import { AccountStatus } from '../domain/account-status';
import {
  ForbiddenError,
  NotFoundError,
  StepUpRequiredError,
} from '../../../common/errors';

/**
 * BE-8.2 CP2 — account profile update unit coverage. Mocks Prisma /
 * TransactionService / SessionService / CliCredentialService / lifecycle bus
 * (pattern mirrors the step-up spec). Focus: frozen allowlist invariants,
 * step-up-on-promotion, disabled/self-role/student gates, no-op short-circuit,
 * and the "no lifecycle side effects" invariant.
 */
describe('AccountService.updateAccount / setMustChangePassword', () => {
  const ACCOUNT_ID = '0190c6b8-0000-7000-8000-000000000001';
  const ACTOR_ID = '0190c6b8-0000-7000-8000-000000000002';
  const SESSION_ID = '0190c6b8-0000-7000-8000-000000000003';

  function makeAccount(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: ACCOUNT_ID,
      username: 'target',
      displayName: 'Target',
      role: AccountRole.TEACHER,
      status: AccountStatus.ACTIVE,
      canCreateCourse: true,
      mustChangePassword: false,
      passwordHash: 'hash',
      passwordChangedAt: new Date(),
      disabledAt: null,
      createdAt: new Date(),
      createdBy: ACTOR_ID,
      ...overrides,
    };
  }

  function setup(
    overrides: {
      target?: Record<string, unknown>;
      stepUpValid?: boolean;
    } = {},
  ) {
    const target = makeAccount(overrides.target);
    const txClient = {
      account: {
        findUnique: jest.fn().mockResolvedValue(target),
        update: jest.fn().mockImplementation(({ data }) => {
          Object.assign(target, data);
          return Promise.resolve(target);
        }),
      },
    };
    const tx = {
      run: jest
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) => fn(txClient)),
      lockAccountForUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const sessions = {
      assertRecentStepUp: jest
        .fn()
        .mockImplementation(() =>
          overrides.stepUpValid === false
            ? Promise.reject(new StepUpRequiredError())
            : Promise.resolve(),
        ),
      revokeAllForAccountInTransaction: jest.fn().mockResolvedValue(undefined),
    };
    const cliCredentials = {
      revokeAllForAccountInTransaction: jest.fn().mockResolvedValue(undefined),
    };
    const accountLifecycleBus = { publish: jest.fn() };
    const prismaService = { prisma: {} };

    const service = new AccountService(
      prismaService as never,
      tx as never,
      sessions as never,
      cliCredentials as never,
      accountLifecycleBus as never,
    );

    return {
      service,
      tx,
      txClient,
      sessions,
      cliCredentials,
      accountLifecycleBus,
      target,
    };
  }

  const actor = { account: { id: ACTOR_ID }, sessionId: SESSION_ID };

  it('updates displayName and role (teacher→student) successfully', async () => {
    const { service, txClient } = setup();
    const result = await service.updateAccount(ACCOUNT_ID, actor, {
      displayName: 'Renamed',
      role: AccountRole.STUDENT,
    });
    expect(result.displayName).toBe('Renamed');
    expect(result.role).toBe(AccountRole.STUDENT);
    expect(txClient.account.update).toHaveBeenCalledWith({
      where: { id: ACCOUNT_ID },
      data: { displayName: 'Renamed', role: AccountRole.STUDENT },
    });
  });

  it('short-circuits a same-value no-op without writing', async () => {
    const { service, txClient } = setup();
    const result = await service.updateAccount(ACCOUNT_ID, actor, {
      displayName: 'Target', // same as existing
      canCreateCourse: true, // same as existing
    });
    expect(result.displayName).toBe('Target');
    expect(txClient.account.update).not.toHaveBeenCalled();
  });

  it('promotes to admin when a recent step-up exists', async () => {
    const { service, sessions, txClient } = setup({ stepUpValid: true });
    const result = await service.updateAccount(ACCOUNT_ID, actor, {
      role: AccountRole.ADMIN,
    });
    expect(result.role).toBe(AccountRole.ADMIN);
    expect(sessions.assertRecentStepUp).toHaveBeenCalledWith(
      ACTOR_ID,
      SESSION_ID,
    );
    expect(txClient.account.update).toHaveBeenCalled();
  });

  it('rejects promotion to admin without a recent step-up', async () => {
    const { service, sessions, txClient } = setup({ stepUpValid: false });
    await expect(
      service.updateAccount(ACCOUNT_ID, actor, { role: AccountRole.ADMIN }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    expect(sessions.assertRecentStepUp).toHaveBeenCalled();
    expect(txClient.account.update).not.toHaveBeenCalled();
  });

  it('rejects updating a disabled target', async () => {
    const { service } = setup({
      target: { status: AccountStatus.DISABLED },
    });
    await expect(
      service.updateAccount(ACCOUNT_ID, actor, { displayName: 'X' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('rejects a missing target with NOT_FOUND', async () => {
    const { service, txClient } = setup();
    txClient.account.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.updateAccount(ACCOUNT_ID, actor, { displayName: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a malformed UUID with NOT_FOUND (existence-safe)', async () => {
    const { service, txClient } = setup();
    await expect(
      service.updateAccount('not-a-uuid', actor, { displayName: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(txClient.account.findUnique).not.toHaveBeenCalled();
  });

  it('rejects student + canCreateCourse=true', async () => {
    const { service, txClient } = setup({
      target: { role: AccountRole.STUDENT },
    });
    await expect(
      service.updateAccount(ACCOUNT_ID, actor, { canCreateCourse: true }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(txClient.account.update).not.toHaveBeenCalled();
  });

  it('rejects a self role change', async () => {
    const { service, txClient } = setup();
    const selfActor = { account: { id: ACCOUNT_ID }, sessionId: SESSION_ID };
    await expect(
      service.updateAccount(ACCOUNT_ID, selfActor, {
        role: AccountRole.STUDENT,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(txClient.account.update).not.toHaveBeenCalled();
  });

  it('allows a self displayName update', async () => {
    const { service, txClient } = setup();
    const selfActor = { account: { id: ACCOUNT_ID }, sessionId: SESSION_ID };
    const result = await service.updateAccount(ACCOUNT_ID, selfActor, {
      displayName: 'Self Renamed',
    });
    expect(result.displayName).toBe('Self Renamed');
    expect(txClient.account.update).toHaveBeenCalled();
  });

  it('never revokes sessions/CLI or publishes lifecycle on a successful update', async () => {
    const { service, sessions, cliCredentials, accountLifecycleBus } = setup();
    await service.updateAccount(ACCOUNT_ID, actor, { displayName: 'X' });
    expect(sessions.revokeAllForAccountInTransaction).not.toHaveBeenCalled();
    expect(
      cliCredentials.revokeAllForAccountInTransaction,
    ).not.toHaveBeenCalled();
    expect(accountLifecycleBus.publish).not.toHaveBeenCalled();
  });

  it('setMustChangePassword sets the flag and short-circuits a no-op', async () => {
    const { service, txClient } = setup();
    const set = await service.setMustChangePassword(ACCOUNT_ID, true);
    expect(set.mustChangePassword).toBe(true);
    expect(txClient.account.update).toHaveBeenCalledWith({
      where: { id: ACCOUNT_ID },
      data: { mustChangePassword: true },
    });

    txClient.account.update.mockClear();
    const noop = await service.setMustChangePassword(ACCOUNT_ID, true);
    expect(noop.mustChangePassword).toBe(true);
    expect(txClient.account.update).not.toHaveBeenCalled();
  });

  it('setMustChangePassword rejects a disabled target and a malformed id', async () => {
    const { service } = setup({
      target: { status: AccountStatus.DISABLED },
    });
    await expect(
      service.setMustChangePassword(ACCOUNT_ID, true),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const { service: svc2 } = setup();
    await expect(
      svc2.setMustChangePassword('not-a-uuid', true),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
