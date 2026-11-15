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

  it('maps persistence failure to a retryable generic service error', async () => {
    repository.findAccountForLogin.mockRejectedValue(
      new Error('database details'),
    );

    await expect(
      service.login('user@example.test', 'password123'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
