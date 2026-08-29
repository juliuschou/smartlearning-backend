import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Admin forces (or clears) the `mustChangePassword` gate for an account
 * (BE-8.2 CP2, plan §1.3). This is a quasi-lifecycle operation distinct from
 * reset-password: setting `true` requires the target to change their own
 * password on next login without the admin supplying a temporary one. The
 * route is step-up protected.
 */
export class RequirePasswordChangeDto {
  @ApiProperty({
    description:
      'true forces the account to change its password on next login; false clears the gate.',
  })
  @IsBoolean()
  mustChangePassword!: boolean;
}
