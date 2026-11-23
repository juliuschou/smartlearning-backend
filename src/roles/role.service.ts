import {
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma-app/client';
import { ROLE_CODES, RoleCode, RoleStatus } from './role.dto';
import { PermissionSummaryService } from '../permissions/permission-summary.service';
import { RoleRepository } from './role.repository';

export const ROLE_VIEW_PERMISSION = 'M02_READ';
export const ROLE_STATUS_PERMISSION = 'M02_WRITE';

@Injectable()
export class RoleService {
  constructor(
    private readonly repository: RoleRepository,
    private readonly permissionSummary: PermissionSummaryService,
  ) {}

  async list(permissionCodes: string[]) {
    this.assertPermission(permissionCodes, ROLE_VIEW_PERMISSION);
    try {
      return (await this.repository.findFixedRoles()).map((role) => ({
        roleCode: role.role_code as RoleCode,
        name: role.name,
        description: role.description,
        status: role.status as RoleStatus,
        isSystemReserved: role.is_system_reserved,
      }));
    } catch (error) {
      this.rethrowKnown(error);
      throw this.unavailable();
    }
  }

  async get(roleCode: string, permissionCodes: string[]) {
    this.assertPermission(permissionCodes, ROLE_VIEW_PERMISSION);
    const code = this.parseRoleCode(roleCode);
    try {
      const role = await this.repository.findFixedRole(code);
      const permissions = await this.permissionSummary.forRole(role.id);
      return {
        roleCode: role.role_code as RoleCode,
        name: role.name,
        description: role.description,
        status: role.status as RoleStatus,
        isSystemReserved: role.is_system_reserved,
        permissions,
      };
    } catch (error) {
      this.rethrowKnown(error);
      throw this.unavailable();
    }
  }

  async setStatus(
    roleCode: string,
    status: RoleStatus,
    permissionCodes: string[],
  ): Promise<{ roleCode: RoleCode; status: RoleStatus }> {
    this.assertPermission(permissionCodes, ROLE_STATUS_PERMISSION);
    const code = this.parseRoleCode(roleCode);
    try {
      await this.repository.setStatus(code, status);
      return { roleCode: code, status };
    } catch (error) {
      this.rethrowKnown(error);
      // Serialization failures are safe to retry; no partial update commits.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw new ServiceUnavailableException({
          code: 'ROLE_STATUS_RETRY_REQUIRED',
          message:
            'The role could not be updated right now. Retry the request.',
        });
      }
      throw this.unavailable();
    }
  }

  private parseRoleCode(value: string): RoleCode {
    if ((ROLE_CODES as readonly string[]).includes(value))
      return value as RoleCode;
    throw new NotFoundException({
      code: 'ROLE_NOT_FOUND',
      message: 'The requested role does not exist.',
    });
  }

  private assertPermission(codes: string[], required: string): void {
    if (!codes.includes(required)) {
      throw new ForbiddenException({
        code: 'ROLE_PERMISSION_REQUIRED',
        message:
          'You are not allowed to perform this role-management operation.',
      });
    }
  }

  private rethrowKnown(error: unknown): void {
    if (
      error instanceof ForbiddenException ||
      error instanceof InternalServerErrorException ||
      error instanceof ServiceUnavailableException
    ) {
      throw error;
    }
    if (
      error instanceof ConflictException ||
      error instanceof NotFoundException
    ) {
      throw error;
    }
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'ROLE_SERVICE_UNAVAILABLE',
      message: 'Role management is temporarily unavailable.',
    });
  }
}
