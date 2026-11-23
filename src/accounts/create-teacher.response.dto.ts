import { ApiProperty } from '@nestjs/swagger';

export class CreateTeacherResponseDto {
  @ApiProperty({ example: '3f6d2a10-1f6e-4a2f-9f01-3d29cf0d1234' })
  accountId!: string;

  @ApiProperty({ enum: ['INVITED'], example: 'INVITED' })
  status!: 'INVITED';

  @ApiProperty({ example: '王小明' })
  name!: string;

  @ApiProperty({ example: 'teacher.wang' })
  accountName!: string;

  @ApiProperty({ example: 'teacher.wang@example.test' })
  email!: string;

  @ApiProperty({
    type: 'array',
    items: { enum: ['TEACHER'] },
    example: ['TEACHER'],
  })
  roles!: ['TEACHER'];

  @ApiProperty({ example: '2026-11-30T00:00:00.000Z' })
  inviteExpiresAt!: string;
}
