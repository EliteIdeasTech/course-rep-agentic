import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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

  async importCourses(
    payload: Record<string, unknown>,
  ): Promise<{ imported: number }> {
    return this.request<{ imported: number }>(
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
