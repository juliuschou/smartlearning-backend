/**
 * Pino redaction paths — fields never written to logs, across all phases.
 * Extends as new sensitive fields appear (session tokens, participant tokens,
 * idempotency keys, answers). Keeping this centralized prevents ad-hoc leaks.
 */
export const PINO_REDACT_PATHS: string[] = [
  // request
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-participant-token"]',
  'req.headers["x-cli-key"]',
  'req.headers["x-validation-token"]',
  'req.headers["idempotency-key"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.tempPassword',
  'req.body.cookieSecret',
  'req.body.selectedOptionRefs',
  'req.body.textAnswer',
  'req.body.payloadHash',
  // realtime handshake auth (Socket.IO `auth` payload) — raw tokens never logged
  'req.body.participantToken',
  'req.body.sessionCode',
  // response
  'res.headers["set-cookie"]',
  'res.body.token',
  'res.body.sessionToken',
  'res.body.participantToken',
  'res.body.data.participantToken',
  'res.body.selectedOptionRefs',
  'res.body.data.selectedOptionRefs',
  'res.body.textAnswer',
  'res.body.data.textAnswer',
  // open_text results — anonymous answer texts must not appear in logs
  'res.body.responses',
  'res.body.data.responses',
  'res.body.rawKey',
  'res.body.data.rawKey',
  'res.body.validationToken',
  'res.body.data.validationToken',
];

export const PINO_REDACT_REMOVE = true;
