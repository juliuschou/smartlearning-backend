import { createOperation } from './metrics';
import { LoadHttpClient, requireLoadCorsOrigin } from './http-client';

type FakeResponse = {
  status: number;
  headers: { getSetCookie: () => string[] };
  json: () => Promise<unknown>;
};

describe('LoadHttpClient CSRF contract', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function response(
    status: number,
    body: unknown,
    setCookies: string[] = [],
  ): FakeResponse {
    return {
      status,
      headers: { getSetCookie: () => setCookies },
      json: async () => body,
    };
  }

  it('requires an explicit browser origin and validates its shape', () => {
    expect(requireLoadCorsOrigin('http://localhost:3000')).toBe(
      'http://localhost:3000',
    );
    expect(() => requireLoadCorsOrigin()).toThrow('LOAD_CORS_ORIGIN');
    expect(() => requireLoadCorsOrigin('http://localhost:3000/path')).toThrow(
      'absolute HTTP(S) origin',
    );
  });

  it('reuses login cookies and echoes the CSRF cookie on teacher mutations', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = jest.fn(async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (calls.length === 1) {
        return response(
          201,
          { data: { username: 'teacher', role: 'teacher' }, error: null },
          [
            '__Host-session=session-token; Path=/; HttpOnly',
            '__Host-csrf=csrf-token; Path=/',
          ],
        ) as unknown as Response;
      }
      return response(201, {
        data: { id: 'course-id' },
        error: null,
      }) as unknown as Response;
    }) as typeof fetch;

    const client = new LoadHttpClient(
      'http://127.0.0.1:3001',
      1000,
      undefined,
      'run-id',
      'http://localhost:3000',
    );
    await client.loginTeacher(
      createOperation('login', 'http'),
      'teacher',
      'password-not-persisted',
    );
    await client.createCourse(
      createOperation('course', 'http'),
      'Course',
      'Description',
    );

    const headers = calls[1].init.headers as Record<string, string>;
    expect(headers.Origin).toBe('http://localhost:3000');
    expect(headers['X-CSRF-Token']).toBe('csrf-token');
    expect(headers.Cookie).toContain('__Host-session=session-token');
    expect(headers.Cookie).toContain('__Host-csrf=csrf-token');
  });

  it('does not substitute the API origin when the browser origin is missing', () => {
    expect(
      () =>
        new LoadHttpClient(
          'http://127.0.0.1:3001',
          1000,
          undefined,
          'run-id',
          undefined,
        ),
    ).toThrow('LOAD_CORS_ORIGIN');
  });

  it('surfaces an authenticated CSRF rejection as a failed teacher request', async () => {
    global.fetch = jest.fn(
      async () =>
        response(403, {
          data: null,
          error: { code: 'AUTH_CSRF_INVALID' },
        }) as unknown as Response,
    ) as typeof fetch;
    const client = new LoadHttpClient(
      'http://127.0.0.1:3001',
      1000,
      undefined,
      'run-id',
      'http://localhost:3000',
    );
    await expect(
      client.createCourse(
        createOperation('course', 'http'),
        'Course',
        'Description',
      ),
    ).rejects.toThrow('status=403 code=AUTH_CSRF_INVALID');
  });
});
