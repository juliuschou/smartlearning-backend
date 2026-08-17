/**
 * Shared text helpers for question domain validators.
 *
 * Extraction point for NFC normalization, whitespace collapse, trim,
 * code-point length, unsafe-text rejection, and duplicate comparison keys.
 * The single-choice poll validator (`poll-single-choice.ts`) keeps its own
 * copies for backward compatibility; new multi-type validators reuse these.
 */
export function readText(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(/\s+/gu, ' ').trim()
    : undefined;
}

export function characterLength(value: string): number {
  return [...value].length;
}

export function containsUnsafeText(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    );
  });
}

export function duplicateKeyFor(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
