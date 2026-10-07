import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ImportCoursesFromAgentRequest,
  ImportCoursesFromAgentResponse,
} from './import-courses.payload';
import {
  httpStatusOf,
  internalUniversityPath,
  publicUniversityPath,
  shouldFallbackUniversityLookup,
} from './university-record';

export interface CourseRepUser {
  id: string;
  email?: string;
  universityId?: string;
  departmentId?: string;
}

@Injectable()
export class CourseRepClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = config.get<string>('COURSE_REP_API_URL', 'http://localhost:3000');
    this.secret = config.get<string>('INTERNAL_API_SECRET', '');
    this.timeoutMs = Number(config.get<string>('COURSE_REP_HTTP_TIMEOUT_MS', '12000'));
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Internal-Secret': this.secret,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...this.headers(),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        let body = '';
        try {
          body = (await res.text()).slice(0, 500);
        } catch {
          body = '';
        }
        const err = new Error(
          `Course Rep API ${path} failed: ${res.status}${body ? ` — ${body}` : ''}`,
        ) as Error & { status?: number; body?: string };
        err.status = res.status;
        err.body = body;
        throw err;
      }

      if (res.status === 204) {
        return undefined as T;
      }

      return (await res.json()) as T;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'name' in error &&
        (error as { name?: string }).name === 'AbortError'
      ) {
        throw new Error(
          `Request timed out after ${this.timeoutMs}ms: ${this.baseUrl}${path}`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async getUser(userId: string): Promise<CourseRepUser> {
    return this.request<CourseRepUser>(`/internal/users/${userId}`);
  }

  /**
   * University row including demo schools. Tries
   * `GET /internal/universities/:id` (header `X-Internal-Secret`, same secret
   * as import-from-agent). That route is not on the main API yet; a 404 falls
   * back to public `GET /universities/:id`. Both responses may be the
   * `{ success, data }` envelope. Callers read `isDemo` from the row inside
   * `data` (see university-record.ts).
   */
  async getUniversity(universityId: string): Promise<unknown> {
    const internalPath = internalUniversityPath(universityId);
    try {
      return await this.request<unknown>(internalPath);
    } catch (error) {
      if (!shouldFallbackUniversityLookup(httpStatusOf(error))) {
        throw error;
      }
      return this.request<unknown>(publicUniversityPath(universityId));
    }
  }

  /**
   * Seeds the JWT user on a demo university. Same `X-Internal-Secret` header
   * as import-from-agent. Full URL is `/api/internal/reviewer-demo/provision`
   * when `COURSE_REP_API_URL` includes the Nest `/api` prefix.
   */
  async provisionReviewerDemo(payload: {
    userId: string;
    universityId: string;
  }): Promise<{ courses?: Array<{
    code?: string | null;
    title?: string | null;
    units?: number | null;
    instructor?: string | null;
    offered?: boolean;
  }> }> {
    return this.request('/internal/reviewer-demo/provision', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async importMaterial(payload: Record<string, unknown>): Promise<{ materialId: string }> {
    return this.request<{ materialId: string }>(
      '/internal/materials/import-from-agent',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  }

  async createStudyPlanEvent(payload: Record<string, unknown>): Promise<void> {
    await this.request<void>('/internal/study-plan/events', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /**
   * Upserts the full scraped catalog. Each course carries `offered` so the
   * main API can offer the selection and leave the rest unoffered.
   * Requires the backend import contract that accepts `offered` (see
   * import-courses.payload.ts). The current main API rejects unknown fields.
   */
  async importCourses(
    payload: ImportCoursesFromAgentRequest,
  ): Promise<ImportCoursesFromAgentResponse> {
    return this.request<ImportCoursesFromAgentResponse>(
      '/internal/courses/import-from-agent',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    );
  }

  async upsertUserFromPortal(payload: {
    email: string;
    displayName?: string;
    universityId?: string;
    universityName?: string;
    departmentName?: string;
    academicLevelName?: string;
    studentId?: string;
  }): Promise<{
    userId: string;
    email: string;
    username?: string;
    universityId?: string;
    departmentId?: string;
    academicLevelId?: string;
    refreshToken?: string;
    created: boolean;
  }> {
    return this.request('/internal/users/upsert-from-portal', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async updateUniversityPortal(payload: Record<string, unknown>): Promise<void> {
    await this.request<void>('/internal/universities/portal', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async recomputeStudyPlan(userId: string): Promise<{ jobId?: string }> {
    return this.request<{ jobId?: string }>('/internal/study-plan/recompute', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async createNotification(payload: Record<string, unknown>): Promise<{ notificationId: string }> {
    return this.request<{ notificationId: string }>('/internal/notifications', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
}
