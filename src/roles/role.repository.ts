import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Prisma, role_status_e } from '../../generated/prisma-app/client';
import { PrismaService } from '../database/prisma.service';
import { AuthRepository } from '../auth/auth.repository';
import { ROLE_CODES, RoleCode, RoleStatus } from './role.dto';
import { lockRoleIntegrityInvariants } from './role-invariants';

const ROLE_SELECT = {
  id: true,
  role_code: true,
  name: true,
  description: true,
  is_system_reserved: true,
  status: true,
} satisfies Prisma.roleSelect;

@Injectable()
export class RoleRepository {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly authRepository: AuthRepository,
  ) {}

  async findFixedRoles() {
    const roles = await this.prismaService.client.role.findMany({
      where: { role_code: { in: [...ROLE_CODES] } },
      select: ROLE_SELECT,
      orderBy: { role_code: 'asc' },
    });
    this.assertFixedCatalog(roles);
    return roles;
  }

  async findFixedRole(roleCode: RoleCode) {
    const role = await this.prismaService.client.role.findUnique({
      where: { role_code: roleCode },
      select: ROLE_SELECT,
    });
    if (!role) throw this.catalogUnavailable();
    return role;
  }

  async setStatus(roleCode: RoleCode, status: RoleStatus): Promise<void> {
    await this.prismaService.client.$transaction(
      async (transaction) => {
        // Serialize role/account/assignment invariant writers before reading predicate state.
        await lockRoleIntegrityInvariants(transaction);
        const role = await transaction.role.findUnique({
          where: { role_code: roleCode },
          select: { id: true, status: true },
        });
        if (!role) throw this.catalogUnavailable();

        const targetStatus = status as role_status_e;
        if (role.status === targetStatus) {
          if (targetStatus === role_status_e.DISABLED) {
            await this.authRepository.revokeSessionsForRoleInTransaction(
              transaction,
              role.id,
            );
          }
          return;
        }

        if (targetStatus === role_status_e.DISABLED) {
          const accountsLosingLastRole = await transaction.$queryRaw<
            Array<{ id: string }>
          >(
            Prisma.sql`
              SELECT account.id
              FROM app.user_account AS account
              JOIN app.user_role AS assignment
                ON assignment.user_account_id = account.id
              JOIN app.role AS target_role ON target_role.id = assignment.role_id
              WHERE account.status = 'ACTIVE'::app.user_status_e
                AND target_role.id = ${role.id}::uuid
                AND NOT EXISTS (
                  SELECT 1
                  FROM app.user_role AS other_assignment
                  JOIN app.role AS other_role ON other_role.id = other_assignment.role_id
                  WHERE other_assignment.user_account_id = account.id
                    AND other_role.id <> target_role.id
                    AND other_role.role_code IN ('SYSTEM_ADMIN', 'TEACHER')
                    AND other_role.status = 'ENABLED'::app.role_status_e
                )
              LIMIT 1
            `,
          );
          if (accountsLosingLastRole.length > 0) {
            throw new ConflictException({
              code: 'ROLE_DISABLE_WOULD_REMOVE_LAST_VALID_ROLE',
              message:
                'The role cannot be disabled while an active account would have no enabled role.',
            });
          }

          if (roleCode === 'SYSTEM_ADMIN') {
            const administrators = await transaction.$queryRaw<
              Array<{ count: bigint }>
            >(
              Prisma.sql`
                SELECT COUNT(DISTINCT account.id)::bigint AS count
                FROM app.user_account AS account
                JOIN app.user_role AS assignment
                  ON assignment.user_account_id = account.id
                JOIN app.role AS assigned_role ON assigned_role.id = assignment.role_id
                WHERE account.status = 'ACTIVE'::app.user_status_e
                  AND assigned_role.role_code = 'SYSTEM_ADMIN'
                  AND assigned_role.status = 'ENABLED'::app.role_status_e
                  AND assigned_role.id <> ${role.id}::uuid
              `,
            );
            if (administrators[0]?.count === 0n) {
              throw new ConflictException({
                code: 'LAST_EFFECTIVE_SYSTEM_ADMIN_REQUIRED',
                message:
                  'At least one active system administrator must remain.',
              });
            }
          }
        }

        const updated = await transaction.role.updateMany({
          where: { id: role.id, status: role.status },
          data: { status: targetStatus, updated_at: new Date() },
        });
        if (updated.count !== 1) {
          throw new ConflictException({
            code: 'ROLE_STATUS_CHANGED_CONCURRENTLY',
            message: 'The role status changed concurrently. Reload and retry.',
          });
        }

        if (targetStatus === role_status_e.DISABLED) {
          await this.authRepository.revokeSessionsForRoleInTransaction(
            transaction,
            role.id,
          );
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private assertFixedCatalog(
    roles: Array<{ role_code: string; is_system_reserved: boolean }>,
  ): void {
    if (
      roles.length !== ROLE_CODES.length ||
      ROLE_CODES.some(
        (code) => !roles.some((role) => role.role_code === code),
      ) ||
      roles.some((role) => !role.is_system_reserved)
    ) {
      throw this.catalogUnavailable();
    }
  }

  private catalogUnavailable(): InternalServerErrorException {
    return new InternalServerErrorException({
      code: 'ROLE_CATALOG_UNAVAILABLE',
      message: 'The role catalog is temporarily unavailable.',
    });
  }
}
