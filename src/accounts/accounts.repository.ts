import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-app/client';
import { PrismaService } from '../database/prisma.service';
import { EncryptedMailPayload } from '../auth/reset-mail.service';

export interface CreatedTeacherAccount {
  accountId: string;
  email: string;
  name: string;
  accountName: string;
  inviteExpiresAt: Date;
}

@Injectable()
export class AccountsRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async createTeacher(input: {
    email: string;
    name: string;
    accountName: string;
    phone: string | null;
    passwordHash: string;
    assignedBy: string;
    invitationTokenHash: string;
    invitationExpiresAt: Date;
    mailPayload: EncryptedMailPayload;
  }): Promise<CreatedTeacherAccount> {
    // 帳號、TEACHER 角色指派與邀請連結（含寄信工作）在同一筆交易完成；
    // 中途失敗時整筆回滾，不留下可登入或邀請失效中的半完成帳號。
    return this.prismaService.client.$transaction(async (transaction) => {
      // 以交易內 INSERT 攔截唯一性衝突（唯一索引不分大小寫），依違反的索引回報衝突欄位。
      const accountRows = await transaction.$queryRaw<
        Array<{ id: string; email: string }>
      >(Prisma.sql`
        INSERT INTO app.user_account (
          email, email_verified, password_hash, name, phone, account_name, status
        )
        VALUES (
          ${input.email},
          FALSE,
          ${input.passwordHash},
          ${input.name},
          ${input.phone},
          ${input.accountName},
          'INVITED'::app.user_status_e
        )
        RETURNING id, email
      `);
      const account = accountRows[0];
      if (!account) throw new Error('Teacher account was not created.');

      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO app.user_role (user_account_id, role_id, assigned_by)
        SELECT ${account.id}::uuid, role.id, ${input.assignedBy}::uuid
        FROM app.role AS role
        WHERE role.role_code = 'TEACHER'
          AND role.status = 'ENABLED'::app.role_status_e
      `);
      const assignmentCount = await transaction.$queryRaw<
        Array<{ found: boolean }>
      >(Prisma.sql`
        SELECT EXISTS (
          SELECT 1 FROM app.user_role
          WHERE user_account_id = ${account.id}::uuid
        ) AS found
      `);
      // M03：正式帳號至少須有一個有效角色；TEACHER 角色停用或不存在時不得留下無角色帳號。
      if (!assignmentCount[0]?.found) {
        throw new Error('Teacher role assignment was not created.');
      }

      const linkRows = await transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          INSERT INTO app.one_time_link (
            user_account_id, kind, token_hash, status, expires_at, last_sent_at
          )
          VALUES (
            ${account.id}::uuid,
            'INVITATION'::app.one_time_link_kind_e,
            ${input.invitationTokenHash},
            'PENDING'::app.link_status_e,
            ${input.invitationExpiresAt},
            statement_timestamp()
          )
          RETURNING id
        `,
      );
      const link = linkRows[0];
      if (!link) throw new Error('Invitation link was not created.');

      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO app.email_outbox (
          purpose, related_id, encrypted_payload, encryption_nonce, encryption_tag
        )
        VALUES (
          'TEACHER_INVITATION',
          ${link.id}::uuid,
          ${input.mailPayload.encryptedPayload},
          ${input.mailPayload.encryptionNonce},
          ${input.mailPayload.encryptionTag}
        )
      `);

      return {
        accountId: account.id,
        email: account.email,
        name: input.name,
        accountName: input.accountName,
        inviteExpiresAt: input.invitationExpiresAt,
      };
    });
  }
}
