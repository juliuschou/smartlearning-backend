import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AuthService } from './auth.service';
import { AuthConfig } from './auth.config';
import { AuthSecurityService } from './auth-security.service';
import { AuthController } from './auth.controller';
import { AuthSessionGuard } from './auth-session.guard';
import { PasswordResetService } from './password-reset.service';
import { CsrfGuard } from './csrf.guard';

describe('AuthController', () => {
  const authService = {
    createCsrfToken: jest.fn(),
    login: jest.fn(),
    logout: jest.fn(),
    validateSession: jest.fn(),
    getOwnProfile: jest.fn(),
    updateOwnProfile: jest.fn(),
    changeOwnPassword: jest.fn(),
  };
  const passwordResetService = {
    requestPasswordReset: jest.fn(),
    resetPassword: jest.fn(),
  };
  const config = {
    sessionCookieName: 'sl_session',
    sessionCookieSecure: false,
  };
  const security = {
    sessionCookieOptions: () => ({
      httpOnly: true,
      secure: false,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: 86_400_000,
    }),
    csrfCookieOptions: (maxAge = 86_400_000) => ({
      httpOnly: false,
      secure: false,
      sameSite: 'lax' as const,
      path: '/',
      maxAge,
    }),
  };
  let app: Awaited<ReturnType<typeof createApplication>>;

  async function createApplication() {
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: AuthConfig, useValue: config },
        { provide: AuthSecurityService, useValue: security },
        { provide: PasswordResetService, useValue: passwordResetService },
        { provide: CsrfGuard, useValue: { canActivate: () => true } },
        { provide: AuthSessionGuard, useClass: AuthSessionGuard },
      ],
    }).compile();
    const application = module.createNestApplication();
    application.use(cookieParser());
    application.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await application.init();
    return application;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    authService.createCsrfToken.mockReturnValue('signed-csrf-token');
    authService.login.mockResolvedValue({
      sessionCredential: 'private-session-credential',
      csrfToken: 'signed-session-csrf-token',
    });
    authService.logout.mockResolvedValue(undefined);
    authService.getOwnProfile.mockResolvedValue({
      email: 'user@example.test',
      name: '王小明',
      phone: null,
    });
    authService.updateOwnProfile.mockResolvedValue({
      email: 'user@example.test',
      name: '王小明',
      phone: null,
    });
    authService.changeOwnPassword.mockResolvedValue(undefined);
    passwordResetService.requestPasswordReset.mockResolvedValue({
      message:
        'If the account is eligible, password reset instructions will be sent.',
    });
    passwordResetService.resetPassword.mockResolvedValue(undefined);
    authService.validateSession.mockResolvedValue({
      sessionId: 'session-id',
      userAccountId: 'account-id',
      permissionSnapshot: { roleIds: [], roleCodes: [], permissionCodes: [] },
    });
    app = await createApplication();
  });

  afterEach(async () => {
    await app.close();
  });

  // 登入狀態放在瀏覽器不可直接讀取的 Cookie，前端只拿到防偽用的值。
  it('sets a readable CSRF cookie and returns the token for the client header', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/csrf')
      .expect(200);

    expect(response.body).toEqual({ csrfToken: 'signed-csrf-token' });
    expect(response.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('sl_csrf=signed-csrf-token'),
      ]),
    );
    expect(authService.createCsrfToken).toHaveBeenCalledWith(undefined);
  });

  it('sets the session only as an HttpOnly cookie and does not return it in JSON', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'User@example.test', password: 'password123' })
      .expect(200);

    expect(authService.login).toHaveBeenCalledWith(
      'User@example.test',
      'password123',
    );
    expect(response.body).toEqual({
      authenticated: true,
      csrfToken: 'signed-session-csrf-token',
    });
    expect(JSON.stringify(response.body)).not.toContain(
      'private-session-credential',
    );
    expect(response.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('sl_session=private-session-credential'),
        expect.stringContaining('sl_csrf=signed-session-csrf-token'),
      ]),
    );
    const setCookies = response.headers['set-cookie'] as unknown as string[];
    expect(setCookies.join(';')).toContain('HttpOnly');
    expect(setCookies.join(';')).toContain('SameSite=Lax');
  });

  it('clears both cookies after logout', async () => {
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', [
        'sl_session=private-session-credential',
        'sl_csrf=signed-csrf-token',
      ])
      .expect(204);

    expect(authService.logout).toHaveBeenCalledWith(
      'private-session-credential',
    );
  });

  it('returns only authentication state from the session validation endpoint', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/login-session')
      .set('Cookie', 'sl_session=valid-session-credential')
      .expect(200);
    expect(authService.validateSession).toHaveBeenCalledWith(
      'valid-session-credential',
    );
    expect(response.body).toEqual({ authenticated: true });
  });

  it('reads and updates only the authenticated account profile', async () => {
    const profile = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', 'sl_session=valid-session-credential')
      .expect(200);
    expect(profile.body).toEqual({
      email: 'user@example.test',
      name: '王小明',
      phone: null,
    });
    expect(authService.getOwnProfile).toHaveBeenCalledWith('account-id');

    await request(app.getHttpServer())
      .post('/auth/me/profile')
      .set('Cookie', 'sl_session=valid-session-credential')
      .send({ name: ' 王小明 ' })
      .expect(200);
    expect(authService.updateOwnProfile).toHaveBeenCalledWith('account-id', {
      name: '王小明',
    });

    await request(app.getHttpServer())
      .post('/auth/me/profile')
      .set('Cookie', 'sl_session=valid-session-credential')
      .send({ email: 'attacker@example.test', role: 'SYSTEM_ADMIN' })
      .expect(400);
    expect(authService.updateOwnProfile).toHaveBeenCalledTimes(1);
  });

  it('accepts forgot-password requests without exposing account eligibility', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/password/forgot')
      .send({ email: 'User@example.test' })
      .expect(202);

    expect(response.body).toEqual({
      message:
        'If the account is eligible, password reset instructions will be sent.',
    });
    expect(passwordResetService.requestPasswordReset).toHaveBeenCalledWith(
      'User@example.test',
    );
  });

  it('resets a password from a one-time token without returning credentials', async () => {
    await request(app.getHttpServer())
      .post('/auth/password/reset')
      .send({ token: 'a'.repeat(43), newPassword: 'new-password' })
      .expect(204);

    expect(passwordResetService.resetPassword).toHaveBeenCalledWith(
      'a'.repeat(43),
      'new-password',
    );
  });

  it('rejects unexpected forgot-password fields', async () => {
    await request(app.getHttpServer())
      .post('/auth/password/forgot')
      .send({ email: 'user@example.test', accountId: 'someone-else' })
      .expect(400);
    expect(passwordResetService.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('changes password for the authenticated account without returning secrets', async () => {
    await request(app.getHttpServer())
      .post('/auth/password/change')
      .set('Cookie', 'sl_session=valid-session-credential')
      .send({
        currentPassword: 'current-password',
        newPassword: 'new-password',
      })
      .expect(204);
    expect(authService.changeOwnPassword).toHaveBeenCalledWith(
      'account-id',
      'current-password',
      'new-password',
    );
  });
});
