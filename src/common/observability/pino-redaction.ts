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
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.tempPassword',
  'req.body.cookieSecret',
  // response
  'res.headers["set-cookie"]',
  'res.body.token',
  'res.body.sessionToken',
  'res.body.participantToken',
];

export const PINO_REDACT_REMOVE = true;
