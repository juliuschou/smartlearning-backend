import { randomBytes } from 'node:crypto';

export const SESSION_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SESSION_CODE_LENGTH = 8;

/** Generate an uppercase, non-confusable classroom code. */
export function generateSessionCode(): string {
  const bytes = randomBytes(SESSION_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) {
    code += SESSION_CODE_ALPHABET[byte % SESSION_CODE_ALPHABET.length];
  }
  return code;
}

export function normalizeSessionCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isSessionCode(value: string): boolean {
  return new RegExp(
    `^[${SESSION_CODE_ALPHABET}]{${SESSION_CODE_LENGTH}}$`,
  ).test(normalizeSessionCode(value));
}
