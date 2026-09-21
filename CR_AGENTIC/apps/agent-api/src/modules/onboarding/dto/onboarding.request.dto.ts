import {
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LmsType } from '@cr-agentic/shared';

export class StartOnboardingRequestDto {
  @ApiPropertyOptional({ description: 'University id from the main Course Rep app' })
  @IsOptional()
  @IsUUID()
  universityId?: string;

  @ApiProperty()
  @IsString()
  universityName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  website?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  departmentName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  academicLevelName?: string;
}

export class ConfirmPortalRequestDto {
  @ApiProperty()
  @IsUUID()
  candidateId!: string;
}

export class ManualPortalRequestDto {
  @ApiProperty()
  @IsUrl({ require_tld: false })
  loginUrl!: string;

  @ApiProperty({ enum: LmsType })
  @IsEnum(LmsType)
  lmsType!: LmsType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  portalName?: string;
}

class StorageStateDto {
  @ApiProperty({ type: [Object] })
  @IsArray()
  cookies!: Array<Record<string, unknown>>;

  @ApiProperty({ type: [Object] })
  @IsArray()
  origins!: Array<Record<string, unknown>>;
}

export class LoginBridgeRequestDto {
  @ApiProperty()
  @IsUUID()
  sessionId!: string;

  @ApiProperty()
  @IsString()
  bridgeToken!: string;

  @ApiProperty({ type: StorageStateDto })
  @IsObject()
  @ValidateNested()
  @Type(() => StorageStateDto)
  storageState!: StorageStateDto;
}

export class CredentialLoginRequestDto {
  @ApiProperty({ description: 'School portal username or email' })
  @IsString()
  username!: string;

  @ApiProperty({ description: 'School portal password (one-shot; never persisted)' })
  @IsString()
  password!: string;
}

/**
 * Course fields shared by apply-results and sync-to-course-rep.
 * `offeredCourseIds` and `offeredCodes` must be declared or ValidationPipe
 * rejects them (`forbidNonWhitelisted`).
 */
export class CourseImportSelectionDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      'Discovered course ids. When offeredCourseIds or offeredCodes is sent, this is the full discovery list in discovery order and every id is kept. When those fields are omitted, this is the offered subset (older clients).',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  courseIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Discovered course ids the student chose to offer.',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  offeredCourseIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description:
      'Non-empty course codes for the offered subset, in discovery order. Matched case-insensitively. A checked course with no code is still offered via offeredCourseIds.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  offeredCodes?: string[];
}

export class ApplyResultsRequestDto extends CourseImportSelectionDto {
  @ApiPropertyOptional({ type: [String], description: 'DiscoveredAssignment ids to import' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  assignmentIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'DiscoveredTimetableSlot ids to import' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  timetableSlotIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'DiscoveredCalendarEvent ids to import' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  calendarEventIds?: string[];
}
