/**
 * Payload for `POST /internal/courses/import-from-agent`.
 *
 * The main API stores departmental catalog courses and a separate student
 * offering. Portal sync upserts every scraped course and sets the offering
 * from `offered`. Re-sending the same `code` updates the existing catalog row
 * and offer/unoffers it; it does not insert a second course.
 *
 * `code` is the stable departmental key: portal course code, otherwise the
 * portal external id, otherwise the title. School names never appear here.
 */
export interface AgentImportCourse {
  code: string;
  title: string;
  units?: number;
  instructor?: string;
  /** True when the student chose to offer this course; false leaves it unoffered. */
  offered: boolean;
}

export interface ImportCoursesFromAgentRequest {
  userId: string;
  courses: AgentImportCourse[];
}

export interface ImportCoursesFromAgentResponse {
  /** Catalog rows upserted, offered and unoffered. */
  imported: number;
  offered?: number;
  unoffered?: number;
  /** Existing catalog rows whose fields or offering were updated. */
  updated?: number;
}

export interface DiscoveredCourseForImport {
  code: string | null;
  externalId: string | null;
  title: string;
  units: number | null;
  instructor: string | null;
  selected: boolean;
}

function courseCode(course: DiscoveredCourseForImport): string {
  for (const candidate of [course.code, course.externalId, course.title]) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return course.title.trim();
}

export function toAgentImportCourses(
  courses: DiscoveredCourseForImport[],
): AgentImportCourse[] {
  return courses.map((course) => {
    const payload: AgentImportCourse = {
      code: courseCode(course),
      title: course.title,
      offered: course.selected,
    };
    if (course.units != null) payload.units = course.units;
    const instructor = course.instructor?.trim();
    if (instructor) payload.instructor = instructor;
    return payload;
  });
}

export function annotateOffered<T extends { selected: boolean }>(
  course: T,
): T & { offered: boolean } {
  return { ...course, offered: course.selected };
}
