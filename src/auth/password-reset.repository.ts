import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-app/client';
import { PrismaService } from '../database/prisma.service';
import { EncryptedMailPayload } from './reset-mail.service';

export interface ClaimedEmail {
  id: string;
  relatedId: string;
  encryptedPayload: string;
  encryptionNonce: string;
  encryptionTag: string;
  claimToken: string;
  attempts: number;
}

@Injectable()
export class PasswordResetRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async queuePasswordReset(input: {
    email: string;
    tokenHash: string;
    mailPayload: EncryptedMailPayload;
  }): Promise<'QUEUED' | 'COOLDOWN' | 'NOT_ELIGIBLE'> {
    // 同一帳號的資格檢查、冷卻時間與建立寄信工作放在一起，避免同時連續申請而重複寄信。
    return this.prismaService.client.$transaction(async (transaction) => {
      const accounts = await transaction.$queryRaw<
        Array<{ id: string; email: string }>
      >(Prisma.sql`
        SELECT account.id, account.email
        FROM app.user_account AS account
        WHERE lower(account.email) = ${input.email}
          AND account.status = 'ACTIVE'::app.user_status_e
          AND account.email_verified = TRUE
          AND EXISTS (
            SELECT 1
            FROM app.user_role AS assignment
            JOIN app.role AS assigned_role ON assigned_role.id = assignment.role_id
            WHERE assignment.user_account_id = account.id
              AND assigned_role.status = 'ENABLED'::app.role_status_e
              AND assigned_role.role_code IN ('SYSTEM_ADMIN', 'TEACHER')
          )
        FOR UPDATE OF account
      `);
      const account = accounts[0];
      if (!account) return 'NOT_ELIGIBLE';

      const recentSend = await transaction.$queryRaw<Array<{ found: boolean }>>(
        Prisma.sql`
          SELECT EXISTS (
            SELECT 1
            FROM app.one_time_link
            WHERE user_account_id = ${account.id}::uuid
              AND last_sent_at > statement_timestamp() - INTERVAL '60 seconds'
          ) AS found
        `,
      );
      if (recentSend[0]?.found) return 'COOLDOWN';

      const activeDelivery = await transaction.$queryRaw<
        Array<{ found: boolean }>
      >(Prisma.sql`
        SELECT EXISTS (
          SELECT 1
          FROM app.email_outbox AS outbox
          JOIN app.one_time_link AS link ON link.id = outbox.related_id
          WHERE link.user_account_id = ${account.id}::uuid
            AND link.kind = 'PASSWORD_RESET'::app.one_time_link_kind_e
            AND link.status = 'PENDING'::app.link_status_e
            AND link.expires_at > statement_timestamp()
            AND (
              outbox.status = 'PENDING'
              OR (
                outbox.status = 'PROCESSING'
                AND outbox.locked_until > statement_timestamp()
              )
            )
        ) AS found
      `);
      if (activeDelivery[0]?.found) return 'COOLDOWN';

      await transaction.$executeRaw(Prisma.sql`
        UPDATE app.email_outbox
        SET status = 'CANCELLED',
            updated_at = statement_timestamp()
        WHERE status = 'PENDING'
          AND related_id IN (
            SELECT id
            FROM app.one_time_link
            WHERE user_account_id = ${account.id}::uuid
              AND kind = 'PASSWORD_RESET'::app.one_time_link_kind_e
              AND status = 'PENDING'::app.link_status_e
          )
      `);
      await transaction.$executeRaw(Prisma.sql`
        UPDATE app.one_time_link
        SET status = 'SUPERSEDED'::app.link_status_e,
            superseded_at = statement_timestamp()
        WHERE user_account_id = ${account.id}::uuid
          AND kind = 'PASSWORD_RESET'::app.one_time_link_kind_e
          AND status = 'PENDING'::app.link_status_e
          AND used_at IS NULL
          AND superseded_at IS NULL
      `);

      const linkRows = await transaction.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          INSERT INTO app.one_time_link (
            user_account_id, kind, token_hash, status, expires_at
          )
          VALUES (
            ${account.id}::uuid,
            'PASSWORD_RESET'::app.one_time_link_kind_e,
            ${input.tokenHash},
            'PENDING'::app.link_status_e,
            statement_timestamp() + INTERVAL '30 minutes'
          )
          RETURNING id
        `,
      );
      const link = linkRows[0];
      if (!link) throw new Error('Password reset link was not created.');

      await transaction.$executeRaw(Prisma.sql`
        INSERT INTO app.email_outbox (
          purpose,
          related_id,
          encrypted_payload,
          encryption_nonce,
          encryption_tag
        )
        VALUES (
          'PASSWORD_RESET',
          ${link.id}::uuid,
          ${input.mailPayload.encryptedPayload},
          ${input.mailPayload.encryptionNonce},
          ${input.mailPayload.encryptionTag}
        )
      `);
      return 'QUEUED';
    });
  }

  async consumePasswordReset(input: {
    tokenHash: string;
    newPasswordHash: string;
  }): Promise<boolean> {
    // 使用連結、更新密碼及撤銷所有登入狀態一起完成；中途失敗時不會只做一部分。
    return this.prismaService.client.$transaction(async (transaction) => {
      const consumedLinks = await transaction.$queryRaw<
        Array<{ user_account_id: string }>
      >(Prisma.sql`
        WITH candidate AS (
          SELECT link.id, link.user_account_id
          FROM app.one_time_link AS link
          JOIN app.user_account AS account
            ON account.id = link.user_account_id
          WHERE link.token_hash = ${input.tokenHash}
            AND link.kind = 'PASSWORD_RESET'::app.one_time_link_kind_e
            AND link.status = 'PENDING'::app.link_status_e
            AND link.used_at IS NULL
            AND link.superseded_at IS NULL
            AND link.expires_at > statement_timestamp()
            AND account.status = 'ACTIVE'::app.user_status_e
            AND account.email_verified = TRUE
          FOR UPDATE OF link, account
        ), consumed AS (
          UPDATE app.one_time_link AS link
          SET status = 'USED'::app.link_status_e,
              used_at = statement_timestamp()
          FROM candidate
          WHERE link.id = candidate.id
            AND link.status = 'PENDING'::app.link_status_e
          RETURNING candidate.user_account_id
        ), updated_account AS (
          UPDATE app.user_account AS account
          SET password_hash = ${input.newPasswordHash},
              updated_at = statement_timestamp()
          FROM consumed
          WHERE account.id = consumed.user_account_id
            AND account.status = 'ACTIVE'::app.user_status_e
            AND account.email_verified = TRUE
          RETURNING account.id
        )
        SELECT id AS user_account_id FROM updated_account
      `);
      const account = consumedLinks[0];
      if (!account) return false;

      await transaction.$executeRaw(Prisma.sql`
        UPDATE app.login_session
        SET status = 'REVOKED'::app.login_session_status_e,
            revoked_at = statement_timestamp()
        WHERE user_account_id = ${account.user_account_id}::uuid
          AND status = 'ACTIVE'::app.login_session_status_e
          AND revoked_at IS NULL
      `);
      return true;
    });
  }

  async claimOutboxBatch(limit: number): Promise<ClaimedEmail[]> {
    // 每筆工作先領取並加上專屬記號，讓多個寄信程序能分工，避免重複處理同一封信。
    return this.prismaService.client.$queryRaw<ClaimedEmail[]>(Prisma.sql`
      WITH candidates AS (
        SELECT id
        FROM app.email_outbox
        WHERE (
          status = 'PENDING'
          AND available_at <= statement_timestamp()
        ) OR (
          status = 'PROCESSING'
          AND locked_until <= statement_timestamp()
        )
        ORDER BY available_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE app.email_outbox AS outbox
      SET status = 'PROCESSING',
          attempts = outbox.attempts + 1,
          locked_until = statement_timestamp() + INTERVAL '60 seconds',
          claim_token = gen_random_uuid(),
          updated_at = statement_timestamp()
      FROM candidates
      WHERE outbox.id = candidates.id
      RETURNING
        outbox.id,
        outbox.related_id AS "relatedId",
        outbox.encrypted_payload AS "encryptedPayload",
        outbox.encryption_nonce AS "encryptionNonce",
        outbox.encryption_tag AS "encryptionTag",
        outbox.claim_token AS "claimToken",
        outbox.attempts
    `);
  }

  async isPasswordResetLinkPending(relatedId: string): Promise<boolean> {
    const rows = await this.prismaService.client.$queryRaw<
      Array<{ found: boolean }>
    >(Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM app.one_time_link
        WHERE id = ${relatedId}::uuid
          AND kind = 'PASSWORD_RESET'::app.one_time_link_kind_e
          AND status = 'PENDING'::app.link_status_e
          AND used_at IS NULL
          AND superseded_at IS NULL
          AND expires_at > statement_timestamp()
      ) AS found
    `);
    return rows[0]?.found === true;
  }

  async markOutboxCancelled(input: {
    id: string;
    claimToken: string;
  }): Promise<void> {
    await this.prismaService.client.$executeRaw(Prisma.sql`
      UPDATE app.email_outbox
      SET status = 'CANCELLED',
          encrypted_payload = '',
          encryption_nonce = '',
          encryption_tag = '',
          locked_until = NULL,
          claim_token = NULL,
          updated_at = statement_timestamp()
      WHERE id = ${input.id}::uuid
        AND claim_token = ${input.claimToken}::uuid
        AND status = 'PROCESSING'
    `);
  }

  async markOutboxSent(input: {
    id: string;
    relatedId: string;
    claimToken: string;
  }): Promise<void> {
    await this.prismaService.client.$transaction(async (transaction) => {
      const updated = await transaction.$executeRaw(Prisma.sql`
        UPDATE app.email_outbox
        SET status = 'SENT',
            encrypted_payload = '',
            encryption_nonce = '',
            encryption_tag = '',
            sent_at = statement_timestamp(),
            locked_until = NULL,
            claim_token = NULL,
            last_error_code = NULL,
            updated_at = statement_timestamp()
        WHERE id = ${input.id}::uuid
          AND claim_token = ${input.claimToken}::uuid
          AND status = 'PROCESSING'
      `);
      if (updated !== 1) return;
      await transaction.$executeRaw(Prisma.sql`
        UPDATE app.one_time_link
        SET last_sent_at = statement_timestamp()
        WHERE id = ${input.relatedId}::uuid
          AND status = 'PENDING'::app.link_status_e
          AND expires_at > statement_timestamp()
      `);
    });
  }

  async markOutboxFailed(input: {
    id: string;
    relatedId: string;
    claimToken: string;
    attempts: number;
    errorCode: string;
  }): Promise<void> {
    // 超過重試次數就停止寄送並清掉信件內容，避免敏感資料長期留在佇列中。
    const maxAttempts = 5;
    if (input.attempts >= maxAttempts) {
      await this.prismaService.client.$transaction(async (transaction) => {
        const updated = await transaction.$executeRaw(Prisma.sql`
          UPDATE app.email_outbox
          SET status = 'FAILED',
              encrypted_payload = '',
              encryption_nonce = '',
              encryption_tag = '',
              locked_until = NULL,
              claim_token = NULL,
              last_error_code = ${input.errorCode},
              updated_at = statement_timestamp()
          WHERE id = ${input.id}::uuid
            AND claim_token = ${input.claimToken}::uuid
            AND status = 'PROCESSING'
        `);
        if (updated !== 1) return;
        await transaction.$executeRaw(Prisma.sql`
          UPDATE app.one_time_link
          SET status = 'EXPIRED'::app.link_status_e
          WHERE id = ${input.relatedId}::uuid
            AND status = 'PENDING'::app.link_status_e
            AND used_at IS NULL
        `);
      });
      return;
    }

    const delaySeconds = Math.min(60 * 2 ** (input.attempts - 1), 900);
    await this.prismaService.client.$executeRaw(Prisma.sql`
      UPDATE app.email_outbox
      SET status = 'PENDING',
          available_at = statement_timestamp() + (${delaySeconds} * INTERVAL '1 second'),
          locked_until = NULL,
          claim_token = NULL,
          last_error_code = ${input.errorCode},
          updated_at = statement_timestamp()
      WHERE id = ${input.id}::uuid
        AND claim_token = ${input.claimToken}::uuid
        AND status = 'PROCESSING'
    `);
  }
}
