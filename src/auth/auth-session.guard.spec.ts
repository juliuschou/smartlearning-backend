import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthConfig } from './auth.config';
import { AuthService } from './auth.service';
import { AuthSessionGuard } from './auth-session.guard';

describe('AuthSessionGuard', () => {
  const config = { sessionCookieName: 'sl_session' } as AuthConfig;
  const authService = { validateSession: jest.fn() } as unknown as AuthService;
  const guard = new AuthSessionGuard(config, authService);

  function contextFor(credential?: string) {
    const request = { cookies: credential ? { sl_session: credential } : {} };
    return {
      request,
      context: {
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  }

  beforeEach(() => jest.clearAllMocks());

  // 沒有登入憑證或憑證失效時都要擋下請求，不能繼續查詢受保護資料。
  it('rejects requests without a session cookie', async () => {
    const { context } = contextFor();
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(authService.validateSession).not.toHaveBeenCalled();
  });

  it('rejects invalid or expired sessions', async () => {
    (authService.validateSession as jest.Mock).mockResolvedValue(null);
    const { context } = contextFor('invalid');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('attaches the validated session and its permission snapshot to the request', async () => {
    const session = {
      sessionId: 'session-id',
      userAccountId: 'account-id',
      permissionSnapshot: {
        roleIds: ['role-id'],
        roleCodes: ['TEACHER'],
        permissionCodes: ['M05_READ'],
      },
    };
    (authService.validateSession as jest.Mock).mockResolvedValue(session);
    const { context, request } = contextFor('valid-credential');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(authService.validateSession).toHaveBeenCalledWith(
      'valid-credential',
    );
    expect(request).toHaveProperty('auth', session);
  });
});
