import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Create a course. Only `name` is required; description is optional. */
export class CreateCourseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}

/** Course response projection — never includes internal FK beyond owner id. */
export class CourseDto {
  id!: string;
  name!: string;
  description!: string | null;
  status!: string;
  ownerAccountId!: string;
  createdAt!: string;
  updatedAt!: string;
}
