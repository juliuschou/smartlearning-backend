import { createHash } from 'crypto';

/**
 * Deterministic JSON serialization for stable payload hashing.
 *
 * Rules (M2 紅卡: deterministic object-key ordering, normalized strings,
 * preserved array order, UTF-8 JSON without insignificant whitespace):
 *   - Object keys are sorted ascending (lexicographic by UTF-16 code unit).
 *   - Array order is preserved.
 *   - `undefined` is omitted (object values) and not emitted in arrays.
 *   - `NaN`/`Infinity` are not produced by the batch contract; if encountered
 *     they serialize as `null` (JSON default) — callers must not pass them.
 *   - No insignificant whitespace.
 *
 * This is NOT a general-purpose canonical JSON; it is sufficient for hashing
 * batch question payloads whose values are strings, numbers, booleans, null,
 * arrays, and plain objects.
 */
export function canonicalJsonStringify(value: unknown): string {
  return stringifyCanonical(value);
}

function stringifyCanonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = value
      .filter((item) => item !== undefined)
      .map((item) => stringifyCanonical(item));
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const parts = entries.map(
      ([k, v]) => `${JSON.stringify(k)}:${stringifyCanonical(v)}`,
    );
    return `{${parts.join(',')}}`;
  }
  // functions, symbols, bigint — not part of the batch contract
  return 'null';
}

/**
 * SHA-256 over the canonical JSON serialization of `value`.
 * Returns `sha256:<hex>` so the prefix distinguishes it from raw hex token
 * hashes and makes the wire value self-describing.
 */
export function hashPayload(value: unknown): string {
  const canonical = canonicalJsonStringify(value);
  const digest = createHash('sha256').update(canonical).digest('hex');
  return `sha256:${digest}`;
}
