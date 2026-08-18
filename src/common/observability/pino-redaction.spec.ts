import { Writable } from 'node:stream';
import pino from 'pino';
import { PINO_REDACT_PATHS, PINO_REDACT_REMOVE } from './pino-redaction';

describe('Pino auth redaction', () => {
  it('redacts all password and cookie/token paths used by auth mutations', () => {
    expect(PINO_REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'req.body.password',
        'req.body.currentPassword',
        'req.body.newPassword',
        'req.body.tempPassword',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        'res.body.data.selectedOptionRefs',
        'res.body.data.textAnswer',
        'req.handshake.auth.participantToken',
        'req.handshake.auth.sessionCode',
        'req.handshake.headers.cookie',
      ]),
    );
    expect(PINO_REDACT_REMOVE).toBe(true);
  });

  it('removes auth secrets from a pino log record using the configured paths', () => {
    const chunks: Buffer[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const logger = pino(
      {
        redact: {
          paths: PINO_REDACT_PATHS,
          remove: PINO_REDACT_REMOVE,
        },
      },
      destination,
    );

    logger.info(
      {
        req: {
          body: {
            password: 'password-secret',
            currentPassword: 'current-secret',
            newPassword: 'new-secret',
            tempPassword: 'temp-secret',
          },
          headers: {
            cookie: '__Host-session=session-secret',
            'x-csrf-token': 'csrf-secret',
          },
          handshake: {
            auth: {
              participantToken: 'handshake-participant-secret',
              sessionCode: 'handshake-session-secret',
            },
            headers: { cookie: 'handshake-cookie-secret' },
          },
        },
        res: {
          headers: {
            'set-cookie': ['__Host-session=response-secret'],
          },
          body: {
            data: {
              participantToken: 'participant-token-secret',
              selectedOptionRefs: ['selected-option-secret'],
              textAnswer: 'text-answer-secret',
            },
            selectedOptionRefs: ['top-level-option-secret'],
            textAnswer: 'top-level-answer-secret',
          },
        },
      },
      'request',
    );

    const output = Buffer.concat(chunks).toString('utf8');
    expect(output).not.toContain('password-secret');
    expect(output).not.toContain('current-secret');
    expect(output).not.toContain('new-secret');
    expect(output).not.toContain('temp-secret');
    expect(output).not.toContain('session-secret');
    expect(output).not.toContain('csrf-secret');
    expect(output).not.toContain('response-secret');
    expect(output).not.toContain('participant-token-secret');
    expect(output).not.toContain('selected-option-secret');
    expect(output).not.toContain('text-answer-secret');
    expect(output).not.toContain('top-level-option-secret');
    expect(output).not.toContain('top-level-answer-secret');
    expect(output).not.toContain('handshake-participant-secret');
    expect(output).not.toContain('handshake-session-secret');
    expect(output).not.toContain('handshake-cookie-secret');
  });
});
