const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/** Return only a bounded, non-sensitive classifier for an arbitrary thrown value. */
export function errorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;

  try {
    const name = error.name;
    return typeof name === 'string' && SAFE_ERROR_NAME.test(name)
      ? name
      : 'Error';
  } catch {
    return 'Error';
  }
}
