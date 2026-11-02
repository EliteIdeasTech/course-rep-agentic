import {
  IsArray,
  IsInt,
  Max,
  Min,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LmsType } from '@cr-agentic/shared';
import { universityNameMustBeValidated } from '../../../integrations/course-rep/university-record';

export class StartOnboardingRequestDto {
  @ApiPropertyOptional({ description: 'University id from the main Course Rep app' })
  @IsOptional()
  @IsUUID()
  universityId?: string;

  @ApiPropertyOptional({
    description:
      'Required when universityId is omitted. Optional when universityId is set; the agent fills the name from the main API. CourseRepMobile still sends both.',
  })
  @ValidateIf((dto: StartOnboardingRequestDto) => universityNameMustBeValidated(dto))
  @IsString()
  universityName?: string;

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

  @ApiPropertyOptional({
    description:
      'URL the client showed for this candidate. Used if the id is stale. Scheme optional.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  loginUrl?: string;
}

export class ManualPortalRequestDto {
  @ApiProperty({
    description:
      'Portal address as typed. https:// is added when missing; spaces are removed. ' +
      'Validated after normalisation in PortalService.',
  })
  @IsString()
  @MaxLength(2048)
  loginUrl!: string;

  @ApiPropertyOptional({ enum: LmsType })
  @IsOptional()
  @IsEnum(LmsType)
  lmsType?: LmsType;

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

/** Optional body for POST /onboarding/:id/cancel. No credential fields. */
export class CancelOnboardingRequestDto {
  @ApiPropertyOptional({ description: 'Funnel step / screen the student was on (e.g. credentials_submitted)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  step?: string;

  @ApiPropertyOptional({ description: 'Why: cancel_button | start_over | back_exit | app_closed' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  reason?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) platform?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) appVersion?: string;
}

/**
 * POST /onboarding/:id/events. Client-reported funnel step or failure.
 * Never send usernames, passwords, OTPs or tokens; the server also strips
 * anything that looks like one.
 */
export class ClientFunnelEventDto {
  @ApiProperty({ description: 'One of CLIENT_FUNNEL_EVENTS (e.g. start_failed, credentials_submitted)' })
  @IsString()
  @MaxLength(40)
  event!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) step?: string;
  @ApiPropertyOptional({ description: 'FUNNEL_FAILURE_REASONS value, if the client knows it' })
  @IsOptional() @IsString() @MaxLength(40) reason?: string;
  @ApiPropertyOptional({ description: 'Exception class, e.g. AgentApiException, TimeoutException' })
  @IsOptional() @IsString() @MaxLength(80) errorClass?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(999) httpStatus?: number;
  @ApiPropertyOptional({ description: 'Error message (sanitised server-side, max 300)' })
  @IsOptional() @IsString() @MaxLength(500) message?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) platform?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) appVersion?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}
