import { ValidationError } from '../../../common/errors';

/** Normalize and validate the anonymous display name used only in one session. */
export function normalizeParticipantDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('Display name is required.', 'displayName');
  }

  const normalized = value.normalize('NFC').trim();
  const characterCount = [...normalized].length;
  if (characterCount < 1 || characterCount > 40) {
    throw new ValidationError(
      'Display name must contain 1 to 40 characters.',
      'displayName',
    );
  }
  if (containsForbiddenDisplayNameCharacter(normalized)) {
    throw new ValidationError(
      'Display name contains an unsafe control or direction character.',
      'displayName',
    );
  }
  return normalized;
}

function containsForbiddenDisplayNameCharacter(value: string): boolean {
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
