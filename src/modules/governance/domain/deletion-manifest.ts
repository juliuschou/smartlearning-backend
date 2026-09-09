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

export function parseDeletionManifest(value: unknown): DeletionManifest {
  if (!value || typeof value !== 'object')
    throw new InvalidDeletionManifestError();
  const v = value as Record<string, unknown>;
  const required = [
    'deletionEventId',
    'archivedResultId',
    'liveSessionId',
    'trigger',
    'reason',
    'deletedAt',
  ];
  if (
    v.contractVersion !== DELETION_MANIFEST_VERSION ||
    required.some((k) => typeof v[k] !== 'string')
  ) {
    throw new InvalidDeletionManifestError();
  }
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
    deletionEventId: v.deletionEventId as string,
    archivedResultId: v.archivedResultId as string,
    liveSessionId: v.liveSessionId as string,
    trigger: v.trigger as string,
    reason: v.reason as string,
    deletedAt: date.toISOString(),
    categories: [...(v.categories as string[])].sort(),
  };
}
