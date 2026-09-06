import type { NextFunction, Request, Response } from 'express';

const FAILPOINT_HEADER = 'x-fe42-response-loss';
const SUBMISSION_PATH = /\/live-sessions\/[0-9a-f-]+\/submissions$/iu;

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

  const diagnostic = process.env.FE42_RESPONSE_LOSS_DIAGNOSTIC === '1';
  const report = (event: string, fields: Record<string, boolean>): void => {
    if (!diagnostic) return;
    console.info(JSON.stringify({ event, ...fields }));
  };
  const consumedKeys = new Set<string>();
  app.use((request, response, next) => {
    const token = request.header(FAILPOINT_HEADER);
    const idempotencyKey = request.header('idempotency-key')?.trim();
    const requestPath = (request.originalUrl ?? request.path).split('?')[0];
    const methodMatches = request.method === 'POST';
    const pathMatches = SUBMISSION_PATH.test(requestPath);
    const tokenMatches = token === options.token;
    const keyPresent = Boolean(idempotencyKey);
    const target = methodMatches && pathMatches && tokenMatches && keyPresent;
    const alreadyConsumed = Boolean(
      idempotencyKey && consumedKeys.has(idempotencyKey),
    );
    report('fe42_response_loss_decision', {
      methodMatches,
      pathMatches,
      tokenPresent: Boolean(token),
      tokenMatches,
      keyPresent,
      alreadyConsumed,
      target,
    });

    if (!target || alreadyConsumed) {
      next();
      return;
    }

    const abort = (): Response => {
      if (consumedKeys.has(idempotencyKey!)) return response;
      consumedKeys.add(idempotencyKey!);
      const destroy = (response as Response & { destroy?: () => void }).destroy;
      const hasDestroy = typeof destroy === 'function';
      report('fe42_response_loss_abort', { hasDestroy });
      if (hasDestroy) {
        destroy!.call(response);
      } else {
        response.socket?.destroy();
      }
      return response;
    };
    const originalEnd = response.end.bind(response);
    response.end = ((...args: Parameters<Response['end']>) => {
      if (!consumedKeys.has(idempotencyKey!)) return abort();
      return originalEnd(...args);
    }) as Response['end'];
    if (typeof response.json === 'function') {
      const originalJson = response.json.bind(response);
      response.json = ((...args: Parameters<Response['json']>) => {
        if (!consumedKeys.has(idempotencyKey!)) return abort();
        return originalJson(...args);
      }) as Response['json'];
    }
    next();
  });
}

export const TEST_RESPONSE_LOSS_HEADER = FAILPOINT_HEADER;
