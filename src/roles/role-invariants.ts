import { Prisma } from '../../generated/prisma-app/client';

// Every transaction that can change USER_ROLE, USER_ACCOUNT.status, or ROLE.status
// must acquire this same lock before checking last-role/last-admin predicates.
// M03 assignment/account lifecycle writers are not present yet and must reuse this helper.
export async function lockRoleIntegrityInvariants(
  transaction: Prisma.TransactionClient,
): Promise<void> {
  await transaction.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(1295208754::bigint)`,
  );
}
