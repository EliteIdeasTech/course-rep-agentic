import type { VisionCapture } from './types';

/**
 * Writes a vision capture with the same rows the scripted scraper creates.
 * Callers pass the Prisma client. Existing courses and GPA rows are left in
 * place so a later scripted pass does not need a second model run.
 */
export interface VisionCaptureStore {
  discoveredCourse: {
    count(args: { where: { onboardingSessionId: string } }): Promise<number>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  discoveredPortalProfile: {
    upsert(args: {
      where: { onboardingSessionId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
  discoveredAcademicRecord: {
    count(args: { where: { onboardingSessionId: string } }): Promise<number>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export async function saveVisionCapture(
  db: VisionCaptureStore,
  ids: { onboardingSessionId: string; userId: string },
  capture: VisionCapture,
): Promise<{ courses: number; profile: boolean; results: boolean }> {
  let courses = 0;
  const existingCourses = await db.discoveredCourse.count({
    where: { onboardingSessionId: ids.onboardingSessionId },
  });
  if (existingCourses === 0) {
    for (const course of capture.courses) {
      if (!course.title.trim()) continue;
      await db.discoveredCourse.create({
        data: {
          onboardingSessionId: ids.onboardingSessionId,
          userId: ids.userId,
          externalId: course.externalId,
          code: course.code,
          title: course.title,
          units: course.units,
          semester: course.semester,
          instructor: course.instructor,
        },
      });
      courses += 1;
    }
  }

  const profile = capture.profile;
  const hasProfile = Object.values(profile).some((value) => !!value);
  if (hasProfile) {
    await db.discoveredPortalProfile.upsert({
      where: { onboardingSessionId: ids.onboardingSessionId },
      create: {
        onboardingSessionId: ids.onboardingSessionId,
        userId: ids.userId,
        displayName: profile.displayName ?? null,
        email: profile.email ?? null,
        studentId: profile.studentId ?? null,
        departmentName: profile.departmentName ?? null,
        academicLevelName: profile.academicLevelName ?? null,
        rawJson: { source: 'vision-fallback', ...profile },
      },
      update: {
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
        ...(profile.email ? { email: profile.email } : {}),
        ...(profile.studentId ? { studentId: profile.studentId } : {}),
        ...(profile.departmentName ? { departmentName: profile.departmentName } : {}),
        ...(profile.academicLevelName ? { academicLevelName: profile.academicLevelName } : {}),
        rawJson: { source: 'vision-fallback', ...profile },
      },
    });
  }

  let results = false;
  if (capture.results && (capture.results.gpa != null || capture.results.cumulativeGpa != null)) {
    const existing = await db.discoveredAcademicRecord.count({
      where: { onboardingSessionId: ids.onboardingSessionId },
    });
    if (existing === 0) {
      await db.discoveredAcademicRecord.create({
        data: {
          onboardingSessionId: ids.onboardingSessionId,
          userId: ids.userId,
          cumulativeGpa: capture.results.cumulativeGpa ?? capture.results.gpa,
          courseGrades: [],
          gradingScale: { source: 'vision-fallback', gpa: capture.results.gpa ?? null },
        },
      });
      results = true;
    }
  }

  return { courses, profile: hasProfile, results };
}
