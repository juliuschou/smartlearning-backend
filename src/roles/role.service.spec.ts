import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RoleRepository } from './role.repository';
import {
  RoleService,
  ROLE_STATUS_PERMISSION,
  ROLE_VIEW_PERMISSION,
} from './role.service';

describe('RoleService', () => {
  let repository: jest.Mocked<
    Pick<RoleRepository, 'findFixedRoles' | 'findFixedRole' | 'setStatus'>
  >;
  let permissionSummary: { forRole: jest.Mock };
  let service: RoleService;

  beforeEach(() => {
    repository = {
      findFixedRoles: jest.fn(),
      findFixedRole: jest.fn(),
      setStatus: jest.fn(),
    };
    permissionSummary = { forRole: jest.fn() };
    service = new RoleService(
      repository as unknown as RoleRepository,
      permissionSummary as never,
    );
  });

  it('returns only role-management fields for the fixed role list', async () => {
    repository.findFixedRoles.mockResolvedValue([
      {
        id: 'internal-id',
        role_code: 'TEACHER',
        name: '老師',
        description: '維護自己的題庫。',
        is_system_reserved: true,
        status: 'ENABLED',
      },
      {
        id: 'admin-id',
        role_code: 'SYSTEM_ADMIN',
        name: '系統管理者',
        description: '管理平台。',
        is_system_reserved: true,
        status: 'ENABLED',
      },
    ] as never);

    await expect(service.list([ROLE_VIEW_PERMISSION])).resolves.toEqual([
      {
        roleCode: 'TEACHER',
        name: '老師',
        description: '維護自己的題庫。',
        status: 'ENABLED',
        isSystemReserved: true,
      },
      {
        roleCode: 'SYSTEM_ADMIN',
        name: '系統管理者',
        description: '管理平台。',
        status: 'ENABLED',
        isSystemReserved: true,
      },
    ]);
  });

  it('requires the M04 view permission before reading role data', async () => {
    await expect(service.list([])).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.findFixedRoles).not.toHaveBeenCalled();
  });

  it('returns current permission summary in role detail', async () => {
    repository.findFixedRole.mockResolvedValue({
      id: 'teacher-id',
      role_code: 'TEACHER',
      name: '老師',
      description: '老師角色。',
      is_system_reserved: true,
      status: 'ENABLED',
    } as never);
    permissionSummary.forRole.mockResolvedValue([
      {
        permissionCode: 'M05_READ',
        name: '題庫檢視',
        description: '讀取題庫。',
        status: 'ENABLED',
      },
    ]);

    await expect(
      service.get('TEACHER', [ROLE_VIEW_PERMISSION]),
    ).resolves.toEqual({
      roleCode: 'TEACHER',
      name: '老師',
      description: '老師角色。',
      status: 'ENABLED',
      isSystemReserved: true,
      permissions: [
        {
          permissionCode: 'M05_READ',
          name: '題庫檢視',
          description: '讀取題庫。',
          status: 'ENABLED',
        },
      ],
    });
  });

  it('returns role-not-found for unsupported role codes', async () => {
    await expect(
      service.get('LEARNER', [ROLE_VIEW_PERMISSION]),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findFixedRole).not.toHaveBeenCalled();
  });

  it('does not replace permission-summary dependency failure with an empty list', async () => {
    repository.findFixedRole.mockResolvedValue({
      id: 'teacher-id',
      role_code: 'TEACHER',
      name: '老師',
      description: '老師角色。',
      is_system_reserved: true,
      status: 'ENABLED',
    } as never);
    permissionSummary.forRole.mockRejectedValue(new Error('M04 unavailable'));

    await expect(
      service.get('TEACHER', [ROLE_VIEW_PERMISSION]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('requires the distinct M04 status permission', async () => {
    await expect(
      service.setStatus('TEACHER', 'DISABLED', [ROLE_VIEW_PERMISSION]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.setStatus).not.toHaveBeenCalled();
  });

  it('returns conflict from the repository without hiding the business rule', async () => {
    repository.setStatus.mockRejectedValue(
      new ConflictException({ code: 'LAST_EFFECTIVE_SYSTEM_ADMIN_REQUIRED' }),
    );

    await expect(
      service.setStatus('SYSTEM_ADMIN', 'DISABLED', [ROLE_STATUS_PERMISSION]),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows re-enable requests using only the state-management permission', async () => {
    repository.setStatus.mockResolvedValue(undefined);

    await expect(
      service.setStatus('TEACHER', 'ENABLED', [ROLE_STATUS_PERMISSION]),
    ).resolves.toEqual({ roleCode: 'TEACHER', status: 'ENABLED' });
  });
});
