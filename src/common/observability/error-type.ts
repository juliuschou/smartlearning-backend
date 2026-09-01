/** Return only a non-sensitive classifier for an arbitrary thrown value. */
export function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
