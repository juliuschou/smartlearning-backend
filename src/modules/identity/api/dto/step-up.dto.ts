import { IsString, MaxLength, MinLength } from 'class-validator';

export class StepUpDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
