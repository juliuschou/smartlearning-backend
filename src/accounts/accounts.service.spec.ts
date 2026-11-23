import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AuthSecurityService } from '../auth/auth-security.service';
import {
  EncryptedMailPayload,
  ResetMailService,
} from '../auth/reset-mail.service';
import { AccountsRepository } from './accounts.repository';
import { AccountsService } from './accounts.service';

describe('AccountsService.createTeacher', () => {
  const adminId = 'admin-0000-0000-0000-000000000001';
  const baseInput = {
    name: '王小明',
    accountName: 'teacher.wang',
    email: 'Teacher.Wang@Example.test',
    phone: undefined,
  };
  const mailPayload: EncryptedMailPayload = {
    encryptedPayload: 'encrypted',
    encryptionNonce: 'nonce',
    encryptionTag: 'tag',
  };

  let repository: { createTeacher: jest.Mock };
  let service: AccountsService;

  beforeEach(async () => {
    repository = {
      createTeacher: jest.fn().mockResolvedValue({
        accountId: 'account-1',
        email: 'teacher.wang@example.test',
        name: '王小明',
        accountName: 'teacher.wang',
        inviteExpiresAt: new Date('2026-11-30T00:00:00.000Z'),
      }),
    };
    const module = await Test.createTestingModule({
      providers: [
        AccountsService,
        { provide: AccountsRepository, useValue: repository },
        {
          provide: AuthSecurityService,
          useValue: {
            createOneTimeCredential: () => 'token-value',
            hashOneTimeCredential: (value: string) => `hash(${value})`,
          },
        },
        {
          provide: ResetMailService,
          useValue: {
            assertQueueConfiguration: () => undefined,
            encryptPayload: () => mailPayload,
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'TEACHER_INVITATION_URL'
                ? 'https://app.example.test/invite'
                : undefined,
          },
        },
      ],
    }).compile();
    service = module.get(AccountsService);
  });

  it('rejects callers without the M03_WRITE permission', async () => {
    await expect(
      service.createTeacher(baseInput, ['M02_READ'], adminId),
    ).rejects.toMatchObject({ response: { code: 'M03_PERMISSION_REQUIRED' } });
    expect(repository.createTeacher).not.toHaveBeenCalled();
  });

  it('creates the teacher as INVITED with a TEACHER role and hides the token', async () => {
    const result = await service.createTeacher(
      baseInput,
      ['M03_WRITE'],
      adminId,
    );
    expect(result).toEqual({
      accountId: 'account-1',
      status: 'INVITED',
      name: '王小明',
      accountName: 'teacher.wang',
      email: 'teacher.wang@example.test',
      roles: ['TEACHER'],
      inviteExpiresAt: '2026-11-30T00:00:00.000Z',
    });
    expect(JSON.stringify(result)).not.toContain('token-value');
    expect(repository.createTeacher).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'teacher.wang@example.test',
        assignedBy: adminId,
        invitationTokenHash: 'hash(token-value)',
      }),
    );
  });

  it('normalizes email, trims name, and passes the encrypted mail payload', async () => {
    await service.createTeacher(baseInput, ['M03_WRITE'], adminId);
    const call = repository.createTeacher.mock.calls[0][0] as {
      email: string;
      name: string;
      mailPayload: EncryptedMailPayload;
    };
    expect(call.email).toBe('teacher.wang@example.test');
    expect(call.name).toBe('王小明');
    expect(call.mailPayload).toBe(mailPayload);
  });
});
