export const DELETION_MANIFEST_VERSION = 'deletion-manifest.v1' as const;

export class InvalidDeletionManifestError extends TypeError {
  constructor() {
    super('Invalid deletion manifest');
    this.name = 'InvalidDeletionManifestError';
  }
}

export type DeletionManifest = {
  contractVersion: typeof DELETION_MANIFEST_VERSION;
  deletionEventId: string;
  archivedResultId: string;
  liveSessionId: string;
  trigger: string;
  reason: string;
  deletedAt: string;
  categories: string[];
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requireUuid(value: unknown): string {
  const s = typeof value === 'string' ? value.toLowerCase() : '';
  if (!UUID_RE.test(s)) throw new InvalidDeletionManifestError();
  return s;
}

export function parseDeletionManifest(value: unknown): DeletionManifest {
  if (!value || typeof value !== 'object')
    throw new InvalidDeletionManifestError();
  const v = value as Record<string, unknown>;
  if (v.contractVersion !== DELETION_MANIFEST_VERSION)
    throw new InvalidDeletionManifestError();
  // IDs must be well-formed UUIDs: a malformed ID that survives parsing
  // only fails later at the DB layer (22P02), after reconciliation has
  // committed to the apply path. Refuse it here, before any mutation.
  const deletionEventId = requireUuid(v.deletionEventId);
  const archivedResultId = requireUuid(v.archivedResultId);
  const liveSessionId = requireUuid(v.liveSessionId);
  if (typeof v.trigger !== 'string' || typeof v.reason !== 'string')
    throw new InvalidDeletionManifestError();
  if (
    !Array.isArray(v.categories) ||
    v.categories.some((x) => typeof x !== 'string')
  ) {
    throw new InvalidDeletionManifestError();
  }
  const date = new Date(v.deletedAt as string);
  if (Number.isNaN(date.getTime())) throw new InvalidDeletionManifestError();
  return {
    contractVersion: DELETION_MANIFEST_VERSION,
    deletionEventId,
    archivedResultId,
    liveSessionId,
    trigger: v.trigger,
    reason: v.reason,
    deletedAt: date.toISOString(),
    categories: [...(v.categories as string[])].sort(),
  };
}
