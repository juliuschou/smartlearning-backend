import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { Prisma, PrismaClient } from '../../generated/prisma-app/client';

export type BootstrapAdminClient = Pick<
  PrismaClient,
  '$transaction' | '$queryRaw'
>;

export interface BootstrapAdminInput {
  email?: string;
  name?: string;
  password?: string;
}

export interface BootstrapAdminResult {
  outcome: 'CREATED' | 'ALREADY_BOOTSTRAPPED';
  accountId?: string;
}

class BootstrapError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 可單元/整合測試的純邏輯：同一筆交易建立帳號（ACTIVE、已驗證 Email、argon2 密碼雜湊）
 * 與有效的 SYSTEM_ADMIN 指派；assigned_by 為 null（bootstrap 無操作者）。
 * 冪等：若該 Email 帳號已存在且具啟用中的 SYSTEM_ADMIN 指派，安全停止不做任何變更。
 * 任何失敗（缺參數、密碼政策、角色停用、資料庫錯誤）整筆回滾並抛出。
 */
export async function bootstrapAdmin(
  client: BootstrapAdminClient,
  input: BootstrapAdminInput,
): Promise<BootstrapAdminResult> {
  const email = input.email?.trim().toLowerCase();
  const name = input.name?.trim();
  const password = input.password;

  if (
    !email ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new BootstrapError(
      'BOOTSTRAP_EMAIL_INVALID',
      'A valid BOOTSTRAP_ADMIN_EMAIL is required.',
    );
  }
  if (!name || [...name].length < 1 || [...name].length > 100) {
    throw new BootstrapError(
      'BOOTSTRAP_NAME_INVALID',
      'BOOTSTRAP_ADMIN_NAME must be 1-100 characters.',
    );
  }
  if (typeof password !== 'string' || [...password].length < 8) {
    throw new BootstrapError(
      'BOOTSTRAP_PASSWORD_INVALID',
      'BOOTSTRAP_ADMIN_PASSWORD must contain at least 8 characters.',
    );
  }

  return client.$transaction(async (transaction) => {
    const existing = (
      await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM app.user_account WHERE lower(email) = ${email} FOR UPDATE
      `)
    )[0];

    if (existing) {
      const adminAssignment = await transaction.$queryRaw<
        Array<{ found: boolean }>
      >(Prisma.sql`
        SELECT EXISTS (
          SELECT 1
          FROM app.user_role AS assignment
          JOIN app.role AS assigned_role ON assigned_role.id = assignment.role_id
          WHERE assignment.user_account_id = ${existing.id}::uuid
            AND assigned_role.role_code = 'SYSTEM_ADMIN'
            AND assigned_role.status = 'ENABLED'::app.role_status_e
        ) AS found
      `);
      if (adminAssignment[0]?.found) {
        return { outcome: 'ALREADY_BOOTSTRAPPED' as const };
      }
      throw new BootstrapError(
        'BOOTSTRAP_ACCOUNT_CONFLICT',
        'An account with this email exists without an active SYSTEM_ADMIN assignment; use the controlled maintenance process instead.',
      );
    }

    const passwordHash = await argon2.hash(password as string);
    const accountRows = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        INSERT INTO app.user_account (
          email, email_verified, password_hash, name, account_name, status
        )
        VALUES (
          ${email}, TRUE, ${passwordHash}, ${name}, ${'bootstrap-' + randomBytes(8).toString('hex')},
          'ACTIVE'::app.user_status_e
        )
        RETURNING id
      `,
    );
    const account = accountRows[0];
    if (!account) {
      throw new BootstrapError(
        'BOOTSTRAP_FAILED',
        'The bootstrap account was not created.',
      );
    }

    const assignmentRows = await transaction.$queryRaw<
      Array<{ user_account_id: string }>
    >(Prisma.sql`
      INSERT INTO app.user_role (user_account_id, role_id, assigned_by)
      SELECT ${account.id}::uuid, role.id, NULL
      FROM app.role AS role
      WHERE role.role_code = 'SYSTEM_ADMIN'
        AND role.status = 'ENABLED'::app.role_status_e
      RETURNING user_account_id
    `);
    if (!assignmentRows[0]) {
      throw new BootstrapError(
        'BOOTSTRAP_ROLE_UNAVAILABLE',
        'The SYSTEM_ADMIN role is disabled or missing; bootstrap was rolled back.',
      );
    }

    return { outcome: 'CREATED' as const, accountId: account.id };
  });
}
