import { IsString, MaxLength, MinLength } from 'class-validator';

/** Login request — username + password. Validated at the API boundary. */
export class LoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
