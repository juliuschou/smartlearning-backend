import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { OperationMetrics } from './metrics';

export interface ApiResponse<T> {
  status: number;
  data?: T;
  errorCode?: string;
}

export class LoadHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (options.captureCookies) this.captureCookies(response.headers);
      const elapsed = performance.now() - started;
      operation.timingsMs.push(elapsed);
      let body: { data?: T; error?: { code?: string } } = {};
      let parsedJson = false;
      try {
        body = (await response.json()) as typeof body;
        parsedJson = true;
      } catch {
        /* classify below */
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
      };
    } catch (error) {
      operation.timingsMs.push(performance.now() - started);
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
      };
    } finally {
      clearTimeout(timer);
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

  async loginTeacher(
    operation: OperationMetrics,
    username: string,
    password: string,
  ) {
    const result = await this.request<Record<string, unknown>>(
      operation,
      'POST',
      '/auth/login',
      { body: { username, password }, captureCookies: true },
    );
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
        Origin: process.env.LOAD_CORS_ORIGIN ?? new URL(this.baseUrl).origin,
        'X-CSRF-Token': this.csrfToken ?? '',
        Cookie: this.cookieHeader(),
      },
    });
    if (result.status < 200 || result.status >= 300)
      throw new Error(
        `Teacher fixture request failed (${result.errorCode ?? result.status}).`,
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
