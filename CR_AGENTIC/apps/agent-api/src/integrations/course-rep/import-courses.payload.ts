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
  /** Letter grade from the portal's result statements, when known. */
  grade?: string;
}

export interface ImportCoursesFromAgentRequest {
  userId: string;
  courses: AgentImportCourse[];
  /** Latest cumulative GPA from the portal's results page. */
  cumulativeGpa?: number;
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
  gradesByCode: Map<string, string> = new Map(),
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
    const grade = gradesByCode.get(normalizeCourseCode(payload.code));
    if (grade) payload.grade = grade.slice(0, 8);
    return payload;
  });
}

export function normalizeCourseCode(code: string): string {
  return code.replace(/[\s-]+/g, '').toUpperCase();
}

type ResultCourse = { code?: unknown; grade?: unknown };
type ResultSemester = { courses?: unknown };

/**
 * Letter grades by course code from stored result statements
 * (`discovered_academic_records.courseGrades[].courses`). Semesters are stored
 * oldest first, so a retaken course ends up with its latest grade.
 */
export function gradesFromAcademicRecords(
  records: Array<{ courseGrades: unknown }>,
): Map<string, string> {
  const grades = new Map<string, string>();
  for (const record of records) {
    if (!Array.isArray(record.courseGrades)) continue;
    for (const semester of record.courseGrades as ResultSemester[]) {
      if (!semester || !Array.isArray(semester.courses)) continue;
      for (const row of semester.courses as ResultCourse[]) {
        if (typeof row?.code !== 'string' || typeof row?.grade !== 'string') continue;
        const grade = row.grade.trim();
        if (!grade) continue;
        grades.set(normalizeCourseCode(row.code), grade);
      }
    }
  }
  return grades;
}

/** Latest cumulative GPA across stored records, if any is a sane number. */
export function latestCumulativeGpa(
  records: Array<{ cumulativeGpa: number | null; createdAt?: Date }>,
): number | undefined {
  const sorted = [...records].sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
  );
  for (const record of sorted) {
    const gpa = record.cumulativeGpa;
    if (typeof gpa === 'number' && Number.isFinite(gpa) && gpa >= 0 && gpa <= 5) return gpa;
  }
  return undefined;
}

export function annotateOffered<T extends { selected: boolean }>(
  course: T,
): T & { offered: boolean } {
  return { ...course, offered: course.selected };
}
