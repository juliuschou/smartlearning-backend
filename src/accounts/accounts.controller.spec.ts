import { Test } from '@nestjs/testing';
import { AuthSessionGuard } from '../auth/auth-session.guard';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';

describe('AccountsController.createTeacher', () => {
  it('delegates to the service with the caller permission snapshot and account id', async () => {
    const createTeacher = jest.fn().mockResolvedValue({ accountId: 'a1' });
    const module = await Test.createTestingModule({
      controllers: [AccountsController],
      providers: [{ provide: AccountsService, useValue: { createTeacher } }],
    })
      .overrideGuard(AuthSessionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const controller = module.get(AccountsController);

    const body = {
      name: '王小明',
      accountName: 'teacher.wang',
      email: 'teacher.wang@example.test',
    };
    const request = {
      auth: {
        sessionId: 's1',
        userAccountId: 'admin-1',
        permissionSnapshot: {
          roleIds: [],
          roleCodes: ['SYSTEM_ADMIN'],
          permissionCodes: ['M03_WRITE'],
        },
      },
    };
    await controller.createTeacher(body, request as never);
    expect(createTeacher).toHaveBeenCalledWith(body, ['M03_WRITE'], 'admin-1');
  });
});
