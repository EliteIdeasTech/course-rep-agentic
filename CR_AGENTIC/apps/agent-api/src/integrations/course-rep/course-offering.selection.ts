/**
 * Mobile and web clients post a course selection on apply-results and may
 * repeat it on sync-to-course-rep.
 *
 * When `offeredCourseIds` or `offeredCodes` is present, `courseIds` is the
 * full discovered set (discovery order). Only that offered subset is marked
 * selected. Older clients omit the offered fields and send `courseIds` as the
 * offered subset; every other scraped row stays stored and unoffered.
 */
export interface CourseOfferingSelection {
  courseIds?: string[];
  offeredCourseIds?: string[];
  offeredCodes?: string[];
}

export interface ExistingDiscoveredCourse {
  id: string;
  code: string | null;
}

export interface CourseOfferingPlan {
  /** False when the client did not send a course selection. */
  apply: boolean;
  /** Requested ids that are not yet stored for this session. */
  missingIds: string[];
  updates: Array<{ id: string; selected: boolean }>;
}

function cleanIds(ids: string[] | undefined): string[] {
  if (!ids) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }
  return cleaned;
}

function normalizeCode(code: string): string {
  return code.trim().toLowerCase();
}

export function planCourseOffering(
  existing: ExistingDiscoveredCourse[],
  selection: CourseOfferingSelection,
): CourseOfferingPlan {
  const hasOfferedList =
    selection.offeredCourseIds !== undefined || selection.offeredCodes !== undefined;
  const hasCourseIds = selection.courseIds !== undefined;
  if (!hasOfferedList && !hasCourseIds) {
    return { apply: false, missingIds: [], updates: [] };
  }

  const offeredIds = new Set(
    cleanIds(hasOfferedList ? selection.offeredCourseIds : selection.courseIds),
  );
  const offeredCodes = new Set(
    (hasOfferedList ? selection.offeredCodes ?? [] : [])
      .map(normalizeCode)
      .filter((code) => code.length > 0),
  );
  const persistIds = cleanIds(selection.courseIds);
  const existingIds = new Set(existing.map((course) => course.id));
  const missingIds = persistIds.filter((id) => !existingIds.has(id));

  const rows: ExistingDiscoveredCourse[] = [
    ...existing,
    ...missingIds.map((id) => ({ id, code: null })),
  ];

  return {
    apply: true,
    missingIds,
    updates: rows.map((course) => ({
      id: course.id,
      selected: isOffered(course, offeredIds, offeredCodes),
    })),
  };
}

function isOffered(
  course: ExistingDiscoveredCourse,
  offeredIds: ReadonlySet<string>,
  offeredCodes: ReadonlySet<string>,
): boolean {
  if (offeredIds.has(course.id)) return true;
  const code = course.code?.trim().toLowerCase();
  return Boolean(code && offeredCodes.has(code));
}

/** Discovery order from `courseIds`, then any stored rows the client did not list. */
export function orderDiscoveredCourses<T extends { id: string }>(
  courses: T[],
  courseIds: string[] | undefined,
): T[] {
  const ids = cleanIds(courseIds);
  if (ids.length === 0) return courses;
  const byId = new Map(courses.map((course) => [course.id, course]));
  const ordered: T[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const course = byId.get(id);
    if (!course || seen.has(id)) continue;
    ordered.push(course);
    seen.add(id);
  }
  for (const course of courses) {
    if (seen.has(course.id)) continue;
    ordered.push(course);
    seen.add(course.id);
  }
  return ordered;
}
