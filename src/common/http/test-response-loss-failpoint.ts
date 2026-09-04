import type { NextFunction, Request, Response } from 'express';

const FAILPOINT_HEADER = 'x-fe42-response-loss';
const SUBMISSION_PATH = /^\/api\/v1\/live-sessions\/[0-9a-f-]+\/submissions$/iu;

/**
 * Test-only transport failpoint. It aborts exactly one submission response after
 * Nest has produced the body, leaving the already-committed transaction intact.
 */
export function installTestResponseLossFailpoint(
  app: {
    use: (
      middleware: (req: Request, res: Response, next: NextFunction) => void,
    ) => void;
  },
  options: { enabled: boolean; token: string },
): void {
  if (!options.enabled || options.token.trim().length === 0) return;

  let consumed = false;
  app.use((request, response, next) => {
    const token = request.header(FAILPOINT_HEADER);
    const target =
      request.method === 'POST' &&
      (SUBMISSION_PATH.test(request.path) ||
        SUBMISSION_PATH.test(request.originalUrl ?? '')) &&
      token === options.token;

    if (!target || consumed) {
      next();
      return;
    }

    const originalEnd = response.end.bind(response);
    response.end = ((...args: Parameters<Response['end']>) => {
      if (!consumed) {
        consumed = true;
        response.socket?.destroy();
        return response;
      }
      return originalEnd(...args);
    }) as Response['end'];
    next();
  });
}

export const TEST_RESPONSE_LOSS_HEADER = FAILPOINT_HEADER;
