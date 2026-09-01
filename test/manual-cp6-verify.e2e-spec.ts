import { Writable } from 'node:stream';
import pino from 'pino';
import { ErrorCode, RateLimitUnavailableError } from '../src/common/errors';
import { GlobalExceptionFilter } from '../src/common/http/global-exception-filter';
import { validationExceptionFactory } from '../src/common/http/validation-exception';
import {
  PINO_REDACT_PATHS,
  PINO_REDACT_REMOVE,
} from '../src/common/observability';

type Specimen = { id: string; output: unknown };

function pinoSpecimen(id: string, input: Record<string, unknown>): Specimen {
  const chunks: Buffer[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const logger = pino(
    {
      redact: { paths: PINO_REDACT_PATHS, remove: PINO_REDACT_REMOVE },
    },
    destination,
  );
  logger.info(input, 'CP6 synthetic log specimen');
  return { id, output: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}

function filterSpecimen(id: string, exception: unknown): Specimen {
  const body = { value: undefined as unknown };
  const response = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn((value: unknown) => {
      body.value = value;
    }),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ requestId: `cp6-${id}` }),
      getResponse: () => response,
    }),
  } as never;
  new GlobalExceptionFilter().catch(exception, host);
  return { id, output: body.value };
}

describe('CP6 redaction manual verifier', () => {
  it('prints synthetic sanitized specimens for manual inspection', () => {
    const sentinel = 'CP6-SENTINEL-DO-NOT-RETAIN';
    const specimens: Specimen[] = [
      pinoSpecimen('pino-request-response', {
        req: {
          body: {
            displayName: sentinel,
            questions: [{ prompt: sentinel, options: [sentinel] }],
          },
        },
        res: {
          body: {
            data: {
              questions: [sentinel],
              preview: [sentinel],
              payloadHash: sentinel,
              expiresAt: sentinel,
              accountId: 'safe-account-id',
            },
            expiresAt: sentinel,
          },
        },
      }),
      pinoSpecimen('caught-exception-log', {
        event: 'realtime.signal.listener_failed',
        signalType: 'question.opened',
        liveSessionId: 'safe-session-id',
        errorType: 'Error',
      }),
      filterSpecimen(
        'validation-envelope',
        validationExceptionFactory([
          {
            property: 'displayName',
            constraints: { custom: `rejected ${sentinel}` },
            children: [],
            target: { displayName: sentinel },
            value: sentinel,
          },
        ]),
      ),
      filterSpecimen('unknown-error-envelope', new Error(sentinel)),
      filterSpecimen('rate-limit-envelope', new RateLimitUnavailableError()),
      pinoSpecimen('rate-limit-outage-log', {
        reason: 'command_error',
        errorType: 'Error',
      }),
    ];

    const serialized = JSON.stringify(specimens);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).toContain('safe-account-id');
    expect(serialized).toContain(ErrorCode.AUTH_RATE_LIMIT_UNAVAILABLE);
    for (const specimen of specimens) {
      console.log(JSON.stringify(specimen));
    }
  });
});
