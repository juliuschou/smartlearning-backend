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
        'req.headers["x-cli-key"]',
        'req.headers["x-validation-token"]',
        'req.headers["idempotency-key"]',
        'req.body.payloadHash',
        'req.body.displayName',
        'req.body.questions',
        'res.headers["set-cookie"]',
        'res.body.questions',
        'res.body.data.questions',
        'res.body.preview',
        'res.body.data.preview',
        'res.body.payloadHash',
        'res.body.data.payloadHash',
        'res.body.expiresAt',
        'res.body.data.expiresAt',
        'res.body.rawKey',
        'res.body.data.rawKey',
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
            username: 'student-username-safe',
            displayName: 'request-display-name-secret',
            questions: [
              {
                prompt: 'question-prompt-secret',
                options: [{ text: 'question-option-secret' }],
                correctOptionRefs: ['question-correct-ref-secret'],
              },
            ],
            payloadHash: 'payload-hash-secret',
          },
          headers: {
            cookie: '__Host-session=session-secret',
            'x-csrf-token': 'csrf-secret',
            'x-cli-key': 'cli-key-secret',
            'x-validation-token': 'validation-token-secret',
            'idempotency-key': 'idempotency-key-secret',
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
              rawKey: 'enveloped-raw-key-secret',
              selectedOptionRefs: ['selected-option-secret'],
              textAnswer: 'text-answer-secret',
              questions: ['enveloped-question-secret'],
              preview: ['enveloped-preview-secret'],
              payloadHash: 'enveloped-payload-hash-secret',
              expiresAt: 'enveloped-expires-at-secret',
              accountId: 'account-id-safe',
              username: 'student-username-safe',
              displayName: 'Student Display Safe',
            },
            questions: ['top-level-question-secret'],
            preview: ['top-level-preview-secret'],
            payloadHash: 'top-level-payload-hash-secret',
            expiresAt: 'top-level-expires-at-secret',
            rawKey: 'top-level-raw-key-secret',
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
    expect(output).not.toContain('cli-key-secret');
    expect(output).not.toContain('validation-token-secret');
    expect(output).not.toContain('idempotency-key-secret');
    expect(output).not.toContain('payload-hash-secret');
    expect(output).not.toContain('response-secret');
    expect(output).not.toContain('enveloped-raw-key-secret');
    expect(output).not.toContain('top-level-raw-key-secret');
    expect(output).not.toContain('participant-token-secret');
    expect(output).not.toContain('selected-option-secret');
    expect(output).not.toContain('text-answer-secret');
    expect(output).not.toContain('top-level-option-secret');
    expect(output).not.toContain('top-level-answer-secret');
    expect(output).not.toContain('request-display-name-secret');
    expect(output).not.toContain('question-prompt-secret');
    expect(output).not.toContain('question-option-secret');
    expect(output).not.toContain('question-correct-ref-secret');
    expect(output).not.toContain('enveloped-question-secret');
    expect(output).not.toContain('enveloped-preview-secret');
    expect(output).not.toContain('enveloped-payload-hash-secret');
    expect(output).not.toContain('enveloped-expires-at-secret');
    expect(output).not.toContain('top-level-question-secret');
    expect(output).not.toContain('top-level-preview-secret');
    expect(output).not.toContain('top-level-payload-hash-secret');
    expect(output).not.toContain('top-level-expires-at-secret');
    expect(output).not.toContain('handshake-participant-secret');
    expect(output).not.toContain('handshake-session-secret');
    expect(output).not.toContain('handshake-cookie-secret');

    // Authorized profile metadata and opaque account IDs are not credentials;
    // avoid blanket redaction that would damage roster/session projections.
    expect(output).toContain('student-username-safe');
    expect(output).toContain('Student Display Safe');
    expect(output).toContain('account-id-safe');
  });
});
