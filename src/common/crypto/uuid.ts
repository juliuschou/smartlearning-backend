import { v7 as uuidv7 } from 'uuid';

/**
 * Generate a UUID v7 (time-ordered) for new entity identity.
 * See M2 關鍵技術決策 §1 — app-layer generation for index locality.
 */
export function newId(): string {
  return uuidv7();
}

/** Validate a string is a UUID (any version) — used at API boundaries. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
