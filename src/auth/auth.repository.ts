import { Injectable } from '@nestjs/common';
import {
  Prisma,
  login_session_status_e,
  permission_status_e,
  role_status_e,
  user_status_e,
} from '../../generated/prisma-app/client';
import { PrismaService } from '../database/prisma.service';
import { PermissionSnapshot } from './auth.types';

export interface AccountForLogin {
  id: string;
  email: string;
  emailVerified: boolean;
  passwordHash: string;
  status: user_status_e;
  roleIds: string[];
  roleCodes: string[];
  permissionCodes: string[];
}

export interface TouchedSession {
  sessionId: string;
  userAccountId: string;
  permissionSnapshot: PermissionSnapshot;
}

@Injectable()
export class AuthRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async findAccountForLogin(email: string): Promise<AccountForLogin | null> {
    const account = await this.prismaService.client.user_account.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      include: {
        user_role_user_role_user_account_idTouser_account: {
          include: {
            role: {
              include: {
                role_permission: {
                  include: { permission: true },
                },
              },
            },
          },
        },
      },
    });
    if (!account) return null;

    const validRoles = account.user_role_user_role_user_account_idTouser_account
      .map((assignment) => assignment.role)
      .filter((role) => role.status === role_status_e.ENABLED);
    const permissionCodes = new Set<string>();
    for (const role of validRoles) {
      for (const rolePermission of role.role_permission) {
        if (rolePermission.permission.status === permission_status_e.ENABLED) {
          permissionCodes.add(rolePermission.permission.permission_code);
        }
      }
    }

    return {
      id: account.id,
      email: account.email,
      emailVerified: account.email_verified,
      passwordHash: account.password_hash,
      status: account.status,
      roleIds: validRoles.map((role) => role.id).sort(),
      roleCodes: validRoles.map((role) => role.role_code).sort(),
      permissionCodes: [...permissionCodes].sort(),
    };
  }

  async createSession(input: {
    userAccountId: string;
    tokenHash: string;
    permissionSnapshot: PermissionSnapshot;
  }): Promise<{ id: string }> {
    return this.prismaService.client.login_session.create({
      data: {
        user_account_id: input.userAccountId,
        token_hash: input.tokenHash,
        status: login_session_status_e.ACTIVE,
        permission_snapshot:
          input.permissionSnapshot as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  }

  async touchValidSession(tokenHash: string): Promise<TouchedSession | null> {
    const rows = await this.prismaService.client.$queryRaw<
      Array<{
        id: string;
        user_account_id: string;
        permission_snapshot: Prisma.JsonValue;
      }>
    >(Prisma.sql`
      WITH clock AS (
        SELECT statement_timestamp() AS now
      ), revoked AS (
        UPDATE app.login_session AS session
        SET status = 'REVOKED'::app.login_session_status_e,
            revoked_at = clock.now
        FROM app.user_account AS account, clock
        WHERE session.token_hash = ${tokenHash}
          AND session.status = 'ACTIVE'::app.login_session_status_e
          AND session.revoked_at IS NULL
          AND account.id = session.user_account_id
          AND (
            account.status <> 'ACTIVE'::app.user_status_e
            OR account.email_verified = FALSE
            OR session.created_at <= clock.now - INTERVAL '24 hours'
            OR session.last_used_at <= clock.now - INTERVAL '30 minutes'
            OR jsonb_typeof(session.permission_snapshot->'roleIds') IS DISTINCT FROM 'array'
            OR jsonb_typeof(session.permission_snapshot->'roleCodes') IS DISTINCT FROM 'array'
            OR jsonb_typeof(session.permission_snapshot->'permissionCodes') IS DISTINCT FROM 'array'
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(session.permission_snapshot->'roleIds') AS snapshot_role(role_id)
              JOIN app.role AS assigned_role
                ON assigned_role.id = snapshot_role.role_id::uuid
              WHERE assigned_role.status <> 'ENABLED'::app.role_status_e
            )
          )
        RETURNING session.id
      ), touched AS (
        UPDATE app.login_session AS session
        SET last_used_at = GREATEST(session.last_used_at, clock.now)
        FROM app.user_account AS account, clock
        WHERE session.token_hash = ${tokenHash}
          AND session.status = 'ACTIVE'::app.login_session_status_e
          AND session.revoked_at IS NULL
          AND account.id = session.user_account_id
          AND account.status = 'ACTIVE'::app.user_status_e
          AND account.email_verified = TRUE
          AND session.created_at > clock.now - INTERVAL '24 hours'
          AND session.last_used_at > clock.now - INTERVAL '30 minutes'
          AND jsonb_typeof(session.permission_snapshot->'roleIds') = 'array'
          AND jsonb_typeof(session.permission_snapshot->'roleCodes') = 'array'
          AND jsonb_typeof(session.permission_snapshot->'permissionCodes') = 'array'
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(session.permission_snapshot->'roleIds') AS snapshot_role(role_id)
            JOIN app.role AS assigned_role
              ON assigned_role.id = snapshot_role.role_id::uuid
            WHERE assigned_role.status <> 'ENABLED'::app.role_status_e
          )
        RETURNING session.id, session.user_account_id, session.permission_snapshot
      )
      SELECT id, user_account_id, permission_snapshot FROM touched
    `);
    const row = rows[0];
    if (!row) return null;

    const permissionSnapshot = parsePermissionSnapshot(row.permission_snapshot);
    if (!permissionSnapshot) return null;
    return {
      sessionId: row.id,
      userAccountId: row.user_account_id,
      permissionSnapshot,
    };
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.prismaService.client.$executeRaw(Prisma.sql`
      UPDATE app.login_session
      SET status = 'REVOKED'::app.login_session_status_e,
          revoked_at = statement_timestamp()
      WHERE token_hash = ${tokenHash}
        AND status = 'ACTIVE'::app.login_session_status_e
        AND revoked_at IS NULL
    `);
  }

  async revokeAllSessionsForAccount(userAccountId: string): Promise<void> {
    await this.prismaService.client.$executeRaw(Prisma.sql`
      UPDATE app.login_session
      SET status = 'REVOKED'::app.login_session_status_e,
          revoked_at = statement_timestamp()
      WHERE user_account_id = ${userAccountId}::uuid
        AND status = 'ACTIVE'::app.login_session_status_e
        AND revoked_at IS NULL
    `);
  }

  async revokeSessionsForRole(roleId: string): Promise<void> {
    await this.prismaService.client.$executeRaw(Prisma.sql`
      UPDATE app.login_session
      SET status = 'REVOKED'::app.login_session_status_e,
          revoked_at = statement_timestamp()
      WHERE status = 'ACTIVE'::app.login_session_status_e
        AND revoked_at IS NULL
        AND permission_snapshot @> jsonb_build_object(
          'roleIds', jsonb_build_array(${roleId}::text)
        )
    `);
  }
}

function parsePermissionSnapshot(
  value: Prisma.JsonValue,
): PermissionSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  const roleIds = snapshot.roleIds;
  const roleCodes = snapshot.roleCodes;
  const permissionCodes = snapshot.permissionCodes;
  if (
    !Array.isArray(roleIds) ||
    !Array.isArray(roleCodes) ||
    !Array.isArray(permissionCodes) ||
    !roleIds.every((item) => typeof item === 'string') ||
    !roleCodes.every((item) => typeof item === 'string') ||
    !permissionCodes.every((item) => typeof item === 'string')
  ) {
    return null;
  }
  return { roleIds, roleCodes, permissionCodes } as PermissionSnapshot;
}
