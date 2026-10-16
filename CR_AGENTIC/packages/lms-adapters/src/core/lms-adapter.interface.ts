import type { Page } from 'playwright-core';
import { LmsType } from '@cr-agentic/shared';

export interface LmsCourse {
  externalId: string;
  title: string;
  code?: string;
  url?: string;
}

export interface LmsMaterial {
  externalId: string;
  title: string;
  url?: string;
  mimeType?: string;
  courseExternalId?: string;
  courseTitle?: string;
}

export interface LmsAnnouncement {
  externalId: string;
  title: string;
  body?: string;
  publishedAt?: string;
}

export interface LmsAssignment {
  externalId: string;
  title: string;
  courseExternalId?: string;
  courseTitle?: string;
  dueAt?: string;
  url?: string;
  eventType?: 'assignment' | 'exam' | 'test' | 'quiz';
}

export interface LmsTimetableSlot {
  externalId: string;
  title: string;
  courseExternalId?: string;
  courseTitle?: string;
  /** ISO weekday 1=Monday … 7=Sunday, or null for one-off. */
  dayOfWeek?: number;
  startsAt?: string;
  endsAt?: string;
  location?: string;
}

export interface LmsProfile {
  displayName?: string;
  email?: string;
  studentId?: string;
  departmentName?: string;
  academicLevelName?: string;
}

export interface ILmsAdapter {
  readonly lmsType: LmsType;
  loginUrl(baseUrl: string): string;
  validateSession(page: Page, config?: GenericPortalConfig): Promise<boolean>;
  listCourses(page: Page, config?: GenericPortalConfig): Promise<LmsCourse[]>;
  listMaterials(
    page: Page,
    course: LmsCourse,
    config?: GenericPortalConfig,
  ): Promise<LmsMaterial[]>;
  downloadMaterial(
    page: Page,
    material: LmsMaterial,
    config?: GenericPortalConfig,
  ): Promise<Buffer>;
  parseAnnouncements?(
    page: Page,
    config?: GenericPortalConfig,
  ): Promise<LmsAnnouncement[]>;
  listAssignments?(
    page: Page,
    config?: GenericPortalConfig,
  ): Promise<LmsAssignment[]>;
  listTimetable?(
    page: Page,
    config?: GenericPortalConfig,
  ): Promise<LmsTimetableSlot[]>;
  extractProfile?(
    page: Page,
    config?: GenericPortalConfig,
  ): Promise<LmsProfile | null>;
  /**
   * Attempt a username/password form login. Returns true when the session
   * appears authenticated afterwards. Should return false (not throw) when
   * SSO/MFA/captcha blocks automated login.
   */
  attemptCredentialLogin?(
    page: Page,
    credentials: { username: string; password: string },
    config?: GenericPortalConfig,
  ): Promise<boolean>;

  /**
   * Like attemptCredentialLogin but explains a failure (wrong password,
   * captcha, SSO, MFA...) so the student gets a precise next step.
   */
  attemptCredentialLoginDetailed?(
    page: Page,
    credentials: { username: string; password: string },
    config?: GenericPortalConfig,
  ): Promise<CredentialLoginResult>;
}

export type CredentialLoginBlocker =
  | 'invalid_credentials'
  | 'captcha_required'
  | 'sso_required'
  | 'mfa_required'
  | 'login_form_not_found'
  | 'not_authenticated';

export interface CredentialLoginResult {
  ok: boolean;
  reason?: CredentialLoginBlocker;
  /** Non-secret detail for logs (e.g. which marker matched). */
  detail?: string;
}

export interface GenericPortalConfig {
  selectors?: {
    authMarker?: string;
    courseList?: string;
    courseLink?: string;
    courseTitle?: string;
    materialList?: string;
    materialLink?: string;
    materialTitle?: string;
    downloadLink?: string;
    username?: string;
    password?: string;
    submit?: string;
    assignmentList?: string;
    assignmentLink?: string;
    assignmentTitle?: string;
    assignmentDue?: string;
    timetableRow?: string;
    profileMarker?: string;
  };
  paths?: {
    courses?: string;
    dashboard?: string;
    assignments?: string;
    timetable?: string;
    profile?: string;
    login?: string;
  };
}
