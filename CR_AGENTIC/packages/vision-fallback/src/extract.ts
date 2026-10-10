import type { VisionCapture, VisionCourse, VisionProfile, VisionResults } from './types';

export const EXTRACTION_PROMPT = [
  'Extract the student portal data visible in the screenshots and HTML.',
  'Return JSON only. Do not invent fields that are not on the page.',
  'profile.studentId is the matric or registration number.',
  'courses are registered course units (code, title, units), not the programme name.',
  'results.gpa is the semester GPA and results.cumulativeGpa is the CGPA, when shown.',
].join(' ');

export function parseVisionCapture(raw: unknown): VisionCapture {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const profile = parseProfile(body.profile);
  const courses = parseCourses(body.courses);
  const results = parseResults(body.results);
  return results ? { profile, courses, results } : { profile, courses };
}

function parseProfile(value: unknown): VisionProfile {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return compact({
    displayName: stringField(row.displayName ?? row.name),
    email: stringField(row.email),
    studentId: stringField(row.studentId ?? row.matricNumber ?? row.matric ?? row.registrationNumber),
    departmentName: stringField(row.departmentName ?? row.department),
    academicLevelName: stringField(row.academicLevelName ?? row.level),
  });
}

function parseCourses(value: unknown): VisionCourse[] {
  if (!Array.isArray(value)) return [];
  const courses: VisionCourse[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i++) {
    const row = value[i];
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const title = stringField(record.title) ?? '';
    const code = stringField(record.code);
    if (!title && !code) continue;
    const course: VisionCourse = {
      externalId: stringField(record.externalId) || `vision-${code ?? i}-${title.slice(0, 24)}`,
      title: title || code || '',
    };
    if (code) course.code = code;
    const units = numberField(record.units);
    if (units != null) course.units = units;
    const semester = stringField(record.semester);
    if (semester) course.semester = semester;
    const instructor = stringField(record.instructor);
    if (instructor) course.instructor = instructor;
    const key = `${(course.code ?? '').toLowerCase()}::${course.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    courses.push(course);
  }
  return courses;
}

function parseResults(value: unknown): VisionResults | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const gpa = numberField(row.gpa);
  const cumulativeGpa = numberField(row.cumulativeGpa ?? row.cgpa);
  if (gpa == null && cumulativeGpa == null) return undefined;
  return {
    ...(gpa != null ? { gpa } : {}),
    ...(cumulativeGpa != null ? { cumulativeGpa } : {}),
  };
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function compact(profile: VisionProfile): VisionProfile {
  return Object.fromEntries(
    Object.entries(profile).filter(([, value]) => value != null && value !== ''),
  ) as VisionProfile;
}
