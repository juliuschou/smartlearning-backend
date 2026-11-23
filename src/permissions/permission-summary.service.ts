import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class PermissionSummaryService {
  constructor(private readonly prismaService: PrismaService) {}

  async forRole(roleId: string) {
    const mappings = await this.prismaService.client.role_permission.findMany({
      where: { role_id: roleId },
      select: {
        permission: {
          select: {
            permission_code: true,
            name: true,
            description: true,
            status: true,
          },
        },
      },
      orderBy: { permission: { permission_code: 'asc' } },
    });

    return mappings.map(({ permission }) => ({
      permissionCode: permission.permission_code,
      name: permission.name,
      description: permission.description,
      status: permission.status,
    }));
  }
}
