import {
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { user_status_e } from '../../generated/prisma-app/client';
import { AuthConfig } from './auth.config';
import { AuthRepository, AccountForLogin } from './auth.repository';
import { AuthSecurityService } from './auth-security.service';
import { AuthService } from './auth.service';

jest.mock('argon2', () => ({
  hash: jest.fn().mockResolvedValue('dummy-password-hash'),
  verify: jest.fn().mockResolvedValue(true),
}));

describe('AuthService', () => {
  const repository = {
    findAccountForLogin: jest.fn(),
    findOwnProfile: jest.fn(),
    updateOwnProfile: jest.fn(),
    findPasswordHashForActiveAccount: jest.fn(),
    changePasswordAndRevokeSessions: jest.fn(),
    createSession: jest.fn(),
    touchValidSession: jest.fn(),
    revokeSession: jest.fn(),
    revokeAllSessionsForAccount: jest.fn(),
    revokeSessionsForRole: jest.fn(),
  };
  const security = {
    createSessionCredential: jest
      .fn()
      .mockReturnValue('opaque-session-credential'),
    hashSessionCredential: jest.fn((value: string) => `sha256:${value}`),
    createCsrfToken: jest.fn((subject: string) => `csrf:${subject}`),
  };
  const config = { assertSessionDurations: jest.fn() };
  const service = new AuthService(
    repository as unknown as AuthRepository,
    security as unknown as AuthSecurityService,
    config as unknown as AuthConfig,
  );

  const activeAccount: AccountForLogin = {
    id: 'account-id',
    email: 'user@example.test',
    emailVerified: true,
    passwordHash: 'argon2-hash',
    status: user_status_e.ACTIVE,
    roleIds: ['role-id'],
    roleCodes: ['TEACHER'],
    permissionCodes: ['M05_READ'],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    repository.createSession.mockResolvedValue({ id: 'session-id' });
    (argon2.verify as jest.Mock).mockResolvedValue(true);
    (argon2.hash as jest.Mock).mockResolvedValue('dummy-password-hash');
    security.createSessionCredential.mockReturnValue(
      'opaque-session-credential',
    );
    security.hashSessionCredential.mockImplementation(
      (value: string) => `sha256:${value}`,
    );
    security.createCsrfToken.mockImplementation(
      (subject: string) => `csrf:${subject}`,
    );
  });

  // 登入時整理信箱但不改密碼內容，並固定記下當下可用的權限資料。
  it('normalizes Email, verifies password, stores only its hash and captures the permission snapshot', async () => {
    repository.findAccountForLogin.mockResolvedValue(activeAccount);

    const result = await service.login(' User@Example.test ', 'password123');

    expect(repository.findAccountForLogin).toHaveBeenCalledWith(
      'user@example.test',
    );
    expect(argon2.verify).toHaveBeenCalledWith('argon2-hash', 'password123');
    expect(repository.createSession).toHaveBeenCalledWith({
      userAccountId: 'account-id',
      tokenHash: 'sha256:opaque-session-credential',
      permissionSnapshot: {
        roleIds: ['role-id'],
        roleCodes: ['TEACHER'],
        permissionCodes: ['M05_READ'],
      },
    });
    expect(result).toEqual({
      sessionCredential: 'opaque-session-credential',
      csrfToken: 'csrf:sha256:opaque-session-credential',
    });
  });

  it('returns the same generic failure for missing, inactive, unverified, roleless, and wrong-password cases', async () => {
    const cases: Array<AccountForLogin | null> = [
      null,
      { ...activeAccount, status: user_status_e.DISABLED },
      { ...activeAccount, emailVerified: false },
      { ...activeAccount, roleIds: [], roleCodes: [], permissionCodes: [] },
      {
        ...activeAccount,
        roleIds: ['learner-role-id'],
        roleCodes: ['LEARNER'],
        permissionCodes: ['JOIN_ACTIVITY'],
      },
      activeAccount,
    ];
    const responses: unknown[] = [];

    for (let index = 0; index < cases.length; index += 1) {
      repository.findAccountForLogin.mockResolvedValueOnce(cases[index]);
      (argon2.verify as jest.Mock).mockResolvedValueOnce(
        index !== cases.length - 1,
      );
      try {
        await service.login('user@example.test', 'password123');
        throw new Error('Expected authentication to fail.');
      } catch (error) {
        expect(error).toBeInstanceOf(UnauthorizedException);
        responses.push((error as UnauthorizedException).getResponse());
      }
    }

    expect(
      new Set(responses.map((response) => JSON.stringify(response))).size,
    ).toBe(1);
    expect(argon2.hash).toHaveBeenCalledTimes(1);
  });

  it('returns and updates only the authenticated account profile fields', async () => {
    const profile = {
      email: 'user@example.test',
      name: '王小明',
      phone: null,
    };
    repository.findOwnProfile.mockResolvedValue(profile);
    repository.updateOwnProfile.mockResolvedValue(profile);

    await expect(service.getOwnProfile('account-id')).resolves.toEqual(profile);
    await expect(
      service.updateOwnProfile('account-id', { name: '王小明' }),
    ).resolves.toEqual(profile);
    expect(repository.updateOwnProfile).toHaveBeenCalledWith('account-id', {
      name: '王小明',
    });
    await expect(
      service.updateOwnProfile('account-id', {}),
    ).rejects.toMatchObject({
      response: { code: 'PROFILE_UPDATE_EMPTY' },
    });
  });

  it('validates the current password, hashes the new one, and revokes all sessions', async () => {
    repository.findPasswordHashForActiveAccount.mockResolvedValue('old-hash');
    repository.changePasswordAndRevokeSessions.mockResolvedValue(true);
    (argon2.verify as jest.Mock).mockResolvedValue(true);
    (argon2.hash as jest.Mock).mockResolvedValue('new-hash');

    await expect(
      service.changeOwnPassword('account-id', 'old-password', 'new-password'),
    ).resolves.toBeUndefined();

    expect(argon2.verify).toHaveBeenCalledWith('old-hash', 'old-password');
    expect(argon2.hash).toHaveBeenCalledWith('new-password');
    expect(repository.changePasswordAndRevokeSessions).toHaveBeenCalledWith({
      userAccountId: 'account-id',
      currentPasswordHash: 'old-hash',
      newPasswordHash: 'new-hash',
    });
  });

  it('does not change the password when current credentials are wrong', async () => {
    repository.findPasswordHashForActiveAccount.mockResolvedValue('old-hash');
    (argon2.verify as jest.Mock).mockResolvedValue(false);

    await expect(
      service.changeOwnPassword('account-id', 'wrong-password', 'new-password'),
    ).rejects.toMatchObject({
      response: { code: 'CURRENT_PASSWORD_INVALID' },
    });
    expect(repository.changePasswordAndRevokeSessions).not.toHaveBeenCalled();
  });

  it('rejects a new password shorter than the agreed minimum', async () => {
    await expect(
      service.changeOwnPassword('account-id', 'old-password', 'short'),
    ).rejects.toMatchObject({
      response: { code: 'PASSWORD_POLICY_FAILED' },
    });
    expect(repository.findPasswordHashForActiveAccount).not.toHaveBeenCalled();
  });

  it('maps persistence failure to a retryable generic service error', async () => {
    repository.findAccountForLogin.mockRejectedValue(
      new Error('database details'),
    );

    await expect(
      service.login('user@example.test', 'password123'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
