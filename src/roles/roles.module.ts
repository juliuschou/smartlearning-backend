import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../database/prisma.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { RolesController } from './roles.controller';
import { RoleRepository } from './role.repository';
import { RoleService } from './role.service';

@Module({
  imports: [PrismaModule, AuthModule, PermissionsModule],
  controllers: [RolesController],
  providers: [RoleRepository, RoleService],
})
export class RolesModule {}
