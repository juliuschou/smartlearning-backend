import { Prisma } from '../../../generated/prisma/client';
import { errorType } from './error-type';

const CODE_PATTERN = /^[A-Za-z0-9._:-]{1,32}$/;

export type DiagnosticErrorProjection = {
  errorType: string;
  prismaCode?: string;
  databaseCode?: string;
};

function boundedCode(value: unknown): string | undefined {
  return typeof value === 'string' && CODE_PATTERN.test(value)
    ? value
    : undefined;
}

/** Project only bounded, non-payload fields from a thrown error. */
export function projectDiagnosticError(
  error: unknown,
): DiagnosticErrorProjection {
  const projection: DiagnosticErrorProjection = { errorType: errorType(error) };
  if (!(error instanceof Prisma.PrismaClientKnownRequestError))
    return projection;

  try {
    const prismaCode = boundedCode(error.code);
    if (prismaCode !== undefined) projection.prismaCode = prismaCode;

    const meta = error.meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const databaseCode = boundedCode(meta.code);
      if (databaseCode !== undefined) projection.databaseCode = databaseCode;
    }
  } catch {
    // Diagnostics must never alter the original error path.
  }
  return projection;
}
