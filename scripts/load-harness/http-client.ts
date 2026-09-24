import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { OperationMetrics } from './metrics';
import { W1DiagnosticsCollector } from './diagnostics';

const W1_RUN_ID_HEADER = 'x-w1-run-id';

export interface ApiResponse<T> {
  status: number;
  data?: T;
  errorCode?: string;
  requestId?: string;
  elapsedMs?: number;
}

export function requireLoadCorsOrigin(
  value = process.env.LOAD_CORS_ORIGIN,
): string {
  if (!value)
    throw new Error(
      'LOAD_CORS_ORIGIN is required for authenticated teacher requests.',
    );
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new Error('LOAD_CORS_ORIGIN must be an absolute HTTP(S) origin.');
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('LOAD_CORS_ORIGIN must be an absolute HTTP(S) origin.');
  }
  return origin.origin;
}

export class LoadHttpClient {
  private readonly corsOrigin: string;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly diagnostics?: W1DiagnosticsCollector,
    private readonly runId?: string,
    corsOrigin?: string,
  ) {
    this.corsOrigin = requireLoadCorsOrigin(corsOrigin);
  }

  private readonly cookies = new Map<string, string>();
  private csrfToken?: string;

  async request<T>(
    operation: OperationMetrics,
    method: string,
    path: string,
    options: {
      headers?: Record<string, string>;
      body?: unknown;
      expectedStatuses?: number[];
      captureCookies?: boolean;
    } = {},
  ): Promise<ApiResponse<T>> {
    const started = performance.now();
    const diagnosticRequestId =
      process.env.W1_DIAGNOSTICS === '1'
        ? `w1-${this.runId ?? 'run'}-${randomUUID()}`.slice(0, 128)
        : undefined;
    const releaseDiagnosticRequest =
      this.diagnostics?.startRequest() ?? (() => undefined);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(process.env.W1_DIAGNOSTICS === '1' && this.runId
            ? { [W1_RUN_ID_HEADER]: this.runId }
            : {}),
          ...(diagnosticRequestId
            ? { 'x-request-id': diagnosticRequestId }
            : {}),
          ...options.headers,
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (options.captureCookies) this.captureCookies(response.headers);
      let body: { data?: T; error?: { code?: string } } = {};
      let parsedJson = false;
      try {
        body = (await response.json()) as typeof body;
        parsedJson = true;
      } catch {
        /* classify below */
      }
      const elapsed = performance.now() - started;
      operation.timingsMs.push(elapsed);
      if (diagnosticRequestId) {
        this.diagnostics?.recordClient(diagnosticRequestId, elapsed);
        if (path.includes('/join'))
          this.diagnostics?.recordBackend(
            diagnosticRequestId,
            this.runId ?? '',
            response.headers.get('x-w1-join-diagnostic'),
          );
      }
      const expectedStatus =
        options.expectedStatuses?.includes(response.status) ??
        (response.status >= 200 && response.status < 300);
      const expected = expectedStatus && parsedJson;
      if (expected) operation.successCount += 1;
      else
        this.recordHttpError(
          operation,
          body.error?.code ?? `HTTP_${response.status}`,
          response.status >= 400 && response.status < 500,
        );
      return {
        status: response.status,
        data: body.data,
        errorCode: body.error?.code,
        requestId: diagnosticRequestId,
        elapsedMs: elapsed,
      };
    } catch (error) {
      const elapsed = performance.now() - started;
      operation.timingsMs.push(elapsed);
      if (diagnosticRequestId)
        this.diagnostics?.recordClient(diagnosticRequestId, elapsed);
      this.recordHttpError(
        operation,
        error instanceof DOMException && error.name === 'AbortError'
          ? 'TIMEOUT'
          : 'NETWORK_ERROR',
        false,
      );
      return {
        status: 0,
        errorCode:
          error instanceof DOMException && error.name === 'AbortError'
            ? 'TIMEOUT'
            : 'NETWORK_ERROR',
        requestId: diagnosticRequestId,
        elapsedMs: elapsed,
      };
    } finally {
      clearTimeout(timer);
      releaseDiagnosticRequest();
    }
  }

  async join(
    operation: OperationMetrics,
    sessionCode: string,
    displayName: string,
  ) {
    return this.request<{
      participantId: string;
      participantToken: string;
      liveSession: { id: string };
    }>(
      operation,
      'POST',
      `/live-sessions/${encodeURIComponent(sessionCode)}/join`,
      { body: { displayName } },
    );
  }

  async snapshot(
    operation: OperationMetrics,
    liveSessionId: string,
    participantToken: string,
  ) {
    return this.request<Record<string, unknown>>(
      operation,
      'GET',
      `/live-sessions/${liveSessionId}/snapshot`,
      { headers: { 'X-Participant-Token': participantToken } },
    );
  }

  async submit(
    operation: OperationMetrics,
    liveSessionId: string,
    sessionQuestionId: string,
    participantToken: string,
    answer: Record<string, unknown>,
    idempotencyKey = randomUUID(),
  ) {
    return this.request<{ id: string; participantId: string }>(
      operation,
      'POST',
      `/live-sessions/${liveSessionId}/submissions`,
      {
        headers: {
          'X-Participant-Token': participantToken,
          'Idempotency-Key': idempotencyKey,
        },
        body: { sessionQuestionId, ...answer },
      },
    );
  }

  /** Raw submission with caller-supplied idempotency key + request ID (W2). */
  async submitRaw(
    operation: OperationMetrics,
    liveSessionId: string,
    sessionQuestionId: string,
    participantToken: string,
    answer: Record<string, unknown>,
    idempotencyKey: string,
    requestId?: string,
  ) {
    return this.request<{ id: string; participantId: string }>(
      operation,
      'POST',
      `/live-sessions/${liveSessionId}/submissions`,
      {
        headers: {
          'X-Participant-Token': participantToken,
          'Idempotency-Key': idempotencyKey,
          ...(requestId ? { 'x-request-id': requestId } : {}),
        },
        body: { sessionQuestionId, ...answer },
      },
    );
  }

  async loginTeacher(
    operation: OperationMetrics,
    username: string,
    password: string,
  ) {
    const result = await this.request<{
      username?: string;
      role?: string;
      canCreateCourse?: boolean;
      mustChangePassword?: boolean;
    }>(operation, 'POST', '/auth/login', {
      body: { username, password },
      captureCookies: true,
    });
    if (result.status !== 201 || !this.csrfToken)
      throw new Error(
        `Teacher login failed (${result.errorCode ?? result.status}).`,
      );
    return result;
  }

  async createCourse(
    operation: OperationMetrics,
    name: string,
    description: string,
  ) {
    return this.teacherRequest<{ id: string }>(operation, 'POST', '/courses', {
      body: { name, description },
    });
  }

  async createQuestion(
    operation: OperationMetrics,
    courseId: string,
    prompt: string,
  ) {
    return this.teacherRequest<{ id: string }>(
      operation,
      'POST',
      `/courses/${courseId}/questions`,
      {
        body: {
          type: 'poll',
          prompt,
          selectionMode: 'single',
          options: [
            { optionRef: 'source', text: '資料來源' },
            { optionRef: 'alternate', text: '其他因素' },
          ],
        },
      },
    );
  }

  /** Generic question creation for W2 fixtures (poll / open_text / quiz). */
  async createQuestionRaw(
    operation: OperationMetrics,
    courseId: string,
    body: Record<string, unknown>,
  ) {
    return this.teacherRequest<Record<string, unknown>>(
      operation,
      'POST',
      `/courses/${courseId}/questions`,
      { body },
    );
  }

  /** Teacher snapshot (Web session) — used to read SessionQuestion snapshot options. */
  async teacherGetSnapshot(operation: OperationMetrics, liveSessionId: string) {
    return this.teacherRequest<{
      sessionQuestions?: Array<{
        id: string;
        options?: Array<{
          id: string;
          optionRef?: string | null;
          isCorrect?: boolean;
        }>;
      }>;
    }>(operation, 'GET', `/live-sessions/${liveSessionId}`);
  }

  /** Teacher quiz/poll results projection — the only wire shape carrying option isCorrect. */
  async teacherGetResults(
    operation: OperationMetrics,
    liveSessionId: string,
    sessionQuestionId: string,
  ) {
    return this.teacherRequest<{
      options?: Array<{
        optionId: string;
        optionRef?: string | null;
        isCorrect?: boolean;
      }>;
    }>(
      operation,
      'GET',
      `/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/results`,
    );
  }

  async createLiveSession(
    operation: OperationMetrics,
    courseId: string,
    questionId: string,
  ) {
    return this.teacherRequest<{ id: string; sessionCode: string }>(
      operation,
      'POST',
      '/live-sessions',
      { body: { courseId, questionIds: [questionId] } },
    );
  }

  async startLiveSession(operation: OperationMetrics, liveSessionId: string) {
    return this.teacherRequest<{
      status: string;
      sessionQuestions: Array<{ id: string }>;
    }>(operation, 'POST', `/live-sessions/${liveSessionId}/start`);
  }

  async openSessionQuestion(
    operation: OperationMetrics,
    liveSessionId: string,
    sessionQuestionId: string,
  ) {
    return this.teacherRequest<{ id: string; status: string }>(
      operation,
      'POST',
      `/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/open`,
    );
  }

  /** Close the current SessionQuestion via the real teacher application flow (W3). */
  async closeSessionQuestion(
    operation: OperationMetrics,
    liveSessionId: string,
    sessionQuestionId: string,
  ) {
    return this.teacherRequest<{ id: string; status: string }>(
      operation,
      'POST',
      `/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/close`,
    );
  }

  /** Participant-token view of a question's results (W3 access-control probe). */
  async participantGetResults(
    operation: OperationMetrics,
    liveSessionId: string,
    sessionQuestionId: string,
    participantToken: string,
  ) {
    return this.request<{
      options?: Array<{
        optionId: string;
        count?: number;
        isCorrect?: boolean;
      }>;
    }>(
      operation,
      'GET',
      `/live-sessions/${liveSessionId}/questions/${sessionQuestionId}/results`,
      { headers: { 'X-Participant-Token': participantToken } },
    );
  }

  private async teacherRequest<T>(
    operation: OperationMetrics,
    method: string,
    path: string,
    options: { body?: unknown } = {},
  ) {
    const result = await this.request<T>(operation, method, path, {
      ...options,
      captureCookies: true,
      headers: {
        Origin: this.corsOrigin,
        'X-CSRF-Token': this.csrfToken ?? '',
        Cookie: this.cookieHeader(),
      },
    });
    if (result.status < 200 || result.status >= 300)
      throw new Error(
        `Teacher fixture request failed: status=${result.status} code=${result.errorCode ?? 'UNKNOWN'}.`,
      );
    return result;
  }

  private captureCookies(headers: Headers): void {
    const setCookies = headers.getSetCookie?.() ?? [];
    for (const value of setCookies) {
      const [pair] = value.split(';', 1);
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (!cookieValue) this.cookies.delete(name);
      else this.cookies.set(name, cookieValue);
      if (name === '__Host-csrf') this.csrfToken = cookieValue || undefined;
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  /**
   * Read-only accessor for the captured cookie jar (W3 teacher socket handshake:
   * Socket.IO bypasses Express `cookie-parser`, so the `__Host-session` cookie
   * must be sent manually in the handshake headers). Additive; W1/W2 unaffected.
   */
  getCookieHeader(): string {
    return this.cookieHeader();
  }

  private recordHttpError(
    operation: OperationMetrics,
    code: string,
    expected: boolean,
  ) {
    operation.errors[code] = (operation.errors[code] ?? 0) + 1;
    if (expected) operation.expectedErrorCount += 1;
    else operation.unexpectedErrorCount += 1;
  }
}
