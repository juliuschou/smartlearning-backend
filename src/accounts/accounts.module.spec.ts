import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AuthSecurityService } from '../auth/auth-security.service';
import { ResetMailService } from '../auth/reset-mail.service';
import { AccountsRepository } from './accounts.repository';
import { AccountsService } from './accounts.service';
import { bootstrapAdmin } from '../bootstrap/bootstrap-admin.core';
import type { BootstrapAdminClient } from '../bootstrap/bootstrap-admin.core';

// 對 bootstrap 純邏輯做驗證：參數檢查與交易內行為（冪等/衝突/回滾）在整合測試覆蓋。
describe('bootstrapAdmin parameter validation', () => {
  const client = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  } as unknown as BootstrapAdminClient;

  it.each([
    [
      { email: 'not-an-email', name: '管理者', password: 'longenough' },
      'BOOTSTRAP_EMAIL_INVALID',
    ],
    [
      { email: 'a@b.test', name: '', password: 'longenough' },
      'BOOTSTRAP_NAME_INVALID',
    ],
    [
      { email: 'a@b.test', name: '管理者', password: 'short' },
      'BOOTSTRAP_PASSWORD_INVALID',
    ],
  ])('rejects %j with %s', async (input, code) => {
    await expect(bootstrapAdmin(client, input)).rejects.toMatchObject({ code });
  });
});

// 確認 AccountsService 仍可被 DI 建構（module wiring 冒煙）。
describe('AccountsService wiring smoke', () => {
  it('builds with mocked providers', async () => {
    const module = await Test.createTestingModule({
      providers: [
        AccountsService,
        { provide: AccountsRepository, useValue: {} },
        { provide: AuthSecurityService, useValue: {} },
        { provide: ResetMailService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    expect(module.get(AccountsService)).toBeDefined();
  });
});
