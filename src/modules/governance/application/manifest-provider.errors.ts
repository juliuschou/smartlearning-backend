export class ManifestProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'unavailable' | 'conflict' | 'invalid',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ManifestProviderError';
  }
}

export class ManifestProviderConflictError extends ManifestProviderError {
  constructor(message = 'Manifest already exists with different content') {
    super(message, 'conflict');
  }
}
