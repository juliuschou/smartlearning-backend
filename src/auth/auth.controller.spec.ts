import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AuthService } from './auth.service';
import { AuthConfig } from './auth.config';
import { AuthSecurityService } from './auth-security.service';
import { AuthController } from './auth.controller';
import { AuthSessionGuard } from './auth-session.guard';
import { CsrfGuard } from './csrf.guard';

describe('AuthController', () => {
  const authService = {
    createCsrfToken: jest.fn(),
    login: jest.fn(),
    logout: jest.fn(),
    validateSession: jest.fn(),
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
});
