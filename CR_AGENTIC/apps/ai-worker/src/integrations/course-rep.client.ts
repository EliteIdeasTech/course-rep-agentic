import { normalizeCourseRepApiUrl } from '@cr-agentic/config';

export class CourseRepClient {
  constructor(
    private readonly baseUrl = normalizeCourseRepApiUrl(
      process.env.COURSE_REP_API_URL ?? 'http://localhost:3000',
    ),
    private readonly secret = process.env.INTERNAL_API_SECRET ?? '',
  ) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Internal-Secret': this.secret,
    };
  }

  async importMaterial(payload: Record<string, unknown>): Promise<{ materialId: string }> {
    const res = await fetch(`${this.baseUrl}/internal/materials/import-from-agent`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Material import failed: ${res.status}`);
    return res.json() as Promise<{ materialId: string }>;
  }

  async recomputeStudyPlan(userId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/internal/study-plan/recompute`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error(`Study plan recompute failed: ${res.status}`);
  }
}
