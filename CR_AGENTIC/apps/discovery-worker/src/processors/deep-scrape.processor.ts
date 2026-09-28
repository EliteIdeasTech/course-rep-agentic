import type { Page } from 'playwright';
import Redis from 'ioredis';
import { prisma, OnboardingStage, recordOnboardingTransition } from '@cr-agentic/database';
import { createLogger, writeAuditLog } from '@cr-agentic/observability';
import { enqueueJob } from '@cr-agentic/queue';
import { QUEUE_NAMES } from '@cr-agentic/shared';
import type { DeepScrapePhase, DiscoveryDeepScrapeJob } from '@cr-agentic/shared';
import {
  LmsAdapterRegistry,
  GenericPortalAdapter,
  CanvasAdapter,
  MoodleAdapter,
} from '@cr-agentic/lms-adapters';
import type { GenericPortalConfig } from '@cr-agentic/lms-adapters';
import { LmsType } from '@cr-agentic/shared';
import type { LlmCompletionClient } from '@cr-agentic/portal-discovery';
import { DiscoveryBrowser } from '../browser/discovery-browser';
import {
  PortalAgent,
  withTimeout,
  type AgentGoal,
  type AgentGoalName,
  type AgentRunResult,
  type ExtractOutcome,
  type LearnedPath,
  type PageObservation,
} from '../agent/course-agent';

const logger = createLogger('deep-scrape-processor');
// BUILD_STAMP: 20260928a-agentic-course-discovery

const PHASE_ORDER: DeepScrapePhase[] = [
  'profile',
  'courses',
  'assignments',
  'timetable',
];

const COURSE_CODE = /\b[A-Z]{2,4}\s?-?\d{3,4}[A-Z]?\b/i;
const EXTRACT_TIMEOUT_MS = 60_000;

type AgentAccount = {
  lmsType: string;
  universityId: string | null;
};

type ScrapedCourse = {
  externalId: string;
  code?: string;
  title: string;
  units?: number;
  semester?: string;
  url?: string;
};

type ScrapedAssignment = {
  externalId: string;
  title: string;
  courseExternalId?: string;
  courseTitle?: string;
  dueAt?: string;
  url?: string;
  eventType?: 'assignment' | 'exam' | 'test' | 'quiz';
};

type ScrapedSlot = {
  externalId: string;
  title: string;
  courseExternalId?: string;
  courseTitle?: string;
  dayOfWeek?: number;
  startsAt?: string;
  endsAt?: string;
  location?: string;
};

type LearnedStore = Record<string, Partial<Record<AgentGoalName, LearnedPath>>>;

export class DeepScrapeProcessor {
  private readonly registry = new LmsAdapterRegistry();
  private readonly navLlms: LlmCompletionClient[];

  constructor(
    private readonly redis: Redis,
    private readonly browser: DiscoveryBrowser,
    private readonly llm: LlmCompletionClient,
    navLlm: LlmCompletionClient = llm,
  ) {
    this.registry.register(new GenericPortalAdapter());
    this.registry.register(new CanvasAdapter());
    this.registry.register(new MoodleAdapter());
    this.navLlms = navLlm === llm ? [llm] : [navLlm, llm];
  }


  private async resolvePortalHome(account: {
    id: string;
    lmsBaseUrl: string;
    portalCandidateId?: string | null;
  }): Promise<string> {
    let home = account.lmsBaseUrl;
    if (account.portalCandidateId) {
      const candidate = await prisma.portalCandidate.findUnique({
        where: { id: account.portalCandidateId },
      });
      if (candidate?.loginUrl) {
        try {
          const u = new URL(candidate.loginUrl);
          let path = u.pathname.replace(/\/login\/?$/i, '/');
          if (!path.endsWith('/')) path += '/';
          home = path === '/' ? u.origin : `${u.origin}${path}`;
        } catch {
          home = candidate.loginUrl;
        }
      }
    }
    // Prefer a path-bearing LMS base from the confirmed candidate (e.g. /portalplus/,
    // /studentportal/) over a bare school hub origin whenever we have one.
    return home;
  }

  async process(job: { data: DiscoveryDeepScrapeJob }): Promise<void> {
    const { connectedAccountId, onboardingSessionId, userId, phase } = job.data;

    const account = await prisma.connectedAccount.findUnique({
      where: { id: connectedAccountId },
      include: {
        browserSessions: {
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    if (!account?.browserSessions[0]) {
      throw new Error('No active browser session for deep scrape');
    }

    const config = await this.loadAdapterConfig(account.universityId, account.lmsType);
    const context = await this.browser.contextFromSession(
      account.browserSessions[0].storageStateS3Key,
    );
    const page = await context.newPage();

    try {
      try {
        switch (phase) {
          case 'profile':
            await this.scrapeProfile(page, account, onboardingSessionId, userId, config);
            break;
          case 'courses':
            await this.scrapeCourses(page, account, onboardingSessionId, userId, config);
            break;
          case 'assignments':
            await this.scrapeAssignments(page, account, onboardingSessionId, userId, config);
            break;
          case 'timetable':
            await this.scrapeTimetable(page, account, onboardingSessionId, userId, config);
            break;
          case 'transcript':
          case 'calendar':
            // Legacy phases no longer in the default chain; keep no-ops for old jobs.
            break;
        }
      } catch (err) {
        logger.warn(
          { err, onboardingSessionId, phase },
          'Deep scrape phase failed; continuing to next phase',
        );
      }

      await writeAuditLog({
        actorId: userId,
        action: `deep_scrape_${phase}`,
        resourceType: 'onboarding_session',
        resourceId: onboardingSessionId,
      }).catch(() => undefined);

      await this.enqueueNextPhase(job.data);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private async enqueueNextPhase(data: DiscoveryDeepScrapeJob): Promise<void> {
    const idx = PHASE_ORDER.indexOf(data.phase);
    const next = idx >= 0 ? PHASE_ORDER[idx + 1] : undefined;
    if (!next) {
      const session = await prisma.onboardingSession.findUnique({
        where: { id: data.onboardingSessionId },
      });
      if (session && session.stage !== OnboardingStage.DEEP_DISCOVERY) {
        await recordOnboardingTransition(
          data.onboardingSessionId,
          session.stage,
          OnboardingStage.DEEP_DISCOVERY,
        ).catch(() => undefined);
      }
      await prisma.connectedAccount.update({
        where: { id: data.connectedAccountId },
        data: { discoveryStatus: 'COMPLETE' },
      }).catch(() => undefined);
      logger.info({ onboardingSessionId: data.onboardingSessionId }, 'Deep scrape complete');
      return;
    }
    await enqueueJob<DiscoveryDeepScrapeJob>(
      QUEUE_NAMES.DISCOVERY_DEEP_SCRAPE,
      this.redis,
      'deep-scrape',
      { ...data, phase: next },
    );
  }

  private portalPage(home: string, pg: string): string {
    const base = home.includes('?') ? home.replace(/(\?.*)$/, '') : home.replace(/\/?$/, '/');
    const root = base.endsWith('/') ? base : `${base}/`;
    return `${root}?pg=${pg}`;
  }

  private async scrapeProfile(
    page: Page,
    account: { id: string; lmsType: string; lmsBaseUrl: string; portalCandidateId?: string | null },
    onboardingSessionId: string,
    userId: string,
    config?: GenericPortalConfig,
  ): Promise<void> {
    const home = await this.resolvePortalHome(account);
    await this.capturePortalAcademics(page, home, onboardingSessionId, userId);
  }

  /** Semester/result tables via ?pg=result or similar portal query pages. */
  private async scrapeAcademicResults(
    page: Page,
    home: string,
    onboardingSessionId: string,
    userId: string,
  ): Promise<void> {
    const resultUrl = this.portalPage(home, 'result');
    await page.goto(resultUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForSelector('table', { timeout: 8_000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    const text = ((await page.locator('body').innerText().catch(() => '')) || '').trim();
    if (!/academic session|cgpa|gpa/i.test(text)) {
      logger.warn({ onboardingSessionId, resultUrl, url: page.url() }, 'No GPA table markers');
      return;
    }

    const rows: Array<Record<string, string>> = [];
    const tableText = await page.locator('table').first().innerText().catch(() => '');
    for (const line of tableText.split('\n')) {
      const parts = line.split('\t').map((p) => p.trim()).filter(Boolean);
      const sessionIdx = parts.findIndex((p) => /\d{4}\/\d{4}/.test(p));
      if (sessionIdx >= 0 && parts.length - sessionIdx >= 5) {
        const slice = parts.slice(sessionIdx);
        rows.push({
          session: slice[0],
          semester: slice[1],
          level: slice[2],
          cgpa: slice[3],
          gpa: slice[4],
        });
      }
    }
    if (rows.length === 0) {
      logger.warn({ onboardingSessionId, tableText: tableText.slice(0, 300) }, 'GPA rows empty');
      return;
    }

    const latestCgpa = Number(rows[rows.length - 1]?.cgpa);
    await prisma.discoveredAcademicRecord.create({
      data: {
        onboardingSessionId,
        userId,
        cumulativeGpa: Number.isFinite(latestCgpa) ? latestCgpa : undefined,
        courseGrades: rows,
        gradingScale: { source: 'portal-result-table' },
      },
    });
    logger.info({ onboardingSessionId, rows: rows.length }, 'Scraped academic results');
  }

  private async scrapeCourses(
    page: Page,
    account: { id: string; lmsType: string; lmsBaseUrl: string; universityId: string | null; portalCandidateId?: string | null },
    onboardingSessionId: string,
    userId: string,
    config?: GenericPortalConfig,
  ): Promise<void> {
    const home = await this.resolvePortalHome(account);
    logger.info({ onboardingSessionId, home }, 'Deep scrape courses home');

    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    const adapter = this.safeAdapter(account.lmsType);
    // Raw adapter output can include a programme:<matric> record; it feeds the
    // identity harvest below but is never saved as a course.
    const courses = await adapter.listCourses(page, config).catch(() => []);
    const adapterCourses: ScrapedCourse[] = courses
      .map((c) => ({ externalId: c.externalId, code: c.code, title: c.title, url: c.url }))
      .filter((c) => this.isLikelyCourse(c));

    let finalCourses: ScrapedCourse[];
    if (this.isTrustworthyAdapterCourseList(account.lmsType, adapterCourses)) {
      finalCourses = adapterCourses;
      logger.info({ onboardingSessionId, count: finalCourses.length }, 'Courses from LMS adapter');
    } else {
      logger.info(
        { onboardingSessionId, adapterCount: courses.length, likelyCourses: adapterCourses.length },
        'Adapter course list not trustworthy; running portal agent',
      );
      finalCourses = await this.runAgent(page, account, home, this.courseGoal(), onboardingSessionId, userId);
    }

    const seenCourses = new Set<string>();
    for (const course of finalCourses) {
      const key = `${(course.code ?? '').toLowerCase()}::${course.title.toLowerCase()}`;
      if (seenCourses.has(key)) continue;
      seenCourses.add(key);
      await prisma.discoveredCourse.create({
        data: {
          onboardingSessionId,
          userId,
          externalId: course.externalId,
          code: course.code,
          title: course.title,
          units: course.units,
          semester: course.semester,
        },
      });
    }
    logger.info({ onboardingSessionId, count: seenCourses.size, home }, 'Scraped courses');

    // Prefer structured signals we already extracted (e.g. programme:<matric>).
    for (const course of courses) {
      const fromExt = /^programme:(.+)$/i.exec(course.externalId || '')?.[1];
      if (!fromExt && !course.title) continue;
      const synthetic = [
        fromExt ? `Matric number: ${fromExt}` : '',
        course.title ? `Programme: ${course.title}` : '',
        course.title || '',
      ]
        .filter(Boolean)
        .join('\n');
      await this.harvestIdentityFromText(
        synthetic,
        onboardingSessionId,
        userId,
        'course-record',
      ).catch((err) => logger.warn({ err, onboardingSessionId }, 'course-record harvest failed'));
      break;
    }

    // Also try live page text when available.
    const dashText = ((await page.locator('body').innerText().catch(() => '')) || '').trim();
    if (dashText.length > 40) {
      await this.harvestIdentityFromText(dashText, onboardingSessionId, userId, 'courses-page').catch(
        (err) => logger.warn({ err, onboardingSessionId }, 'identity harvest failed'),
      );
    }

    // Then try biodata/result pages for richer profile + GPA tables.
    await this.capturePortalAcademics(page, home, onboardingSessionId, userId);
  }

  /**
   * Canvas/Moodle adapters read real course lists. The generic adapter
   * probes heuristically, so its output must look like course units (codes)
   * before we trust it over the agent.
   */
  private isTrustworthyAdapterCourseList(lmsType: string, courses: ScrapedCourse[]): boolean {
    if (courses.length === 0) return false;
    if (lmsType !== LmsType.GENERIC) return true;
    const withCodes = courses.filter((c) => COURSE_CODE.test(`${c.code ?? ''} ${c.title}`));
    return withCodes.length >= Math.max(1, Math.ceil(courses.length / 2));
  }

  private courseGoal(): AgentGoal<ScrapedCourse> {
    return {
      name: 'courses',
      description:
        "Find the page that lists the student's registered / enrolled courses for the current " +
        "(or most recent) session: individual course units with codes like 'COM 212' and titles, " +
        'often under Course Registration, Course Form, Registered Courses, Print Course Form or My Courses. ' +
        "The student's programme name (e.g. 'ND (Computer Engineering) Full Time') is NOT a course.",
      maxSteps: 10,
      timeBudgetMs: 150_000,
      extract: (obs) => this.extractCourses(obs),
    };
  }

  private async extractCourses(obs: PageObservation): Promise<ExtractOutcome<ScrapedCourse>> {
    const input = buildExtractionInput(obs);
    if (input.length < 60) return { items: [], accepted: false, reason: 'page is nearly empty' };

    const extracted = await this.extractJson(
      "You read one page from a student's school portal (tables are TSV). Decide whether it lists " +
        "the student's registered / enrolled courses: individual course units, usually with codes like " +
        "'COM 212' or 'MTH101', titles, and often credit units. " +
        "Programme names such as 'ND (COMPUTER ENGINEERING) FULL TIME', HND/B.Sc programmes, levels " +
        '(ND 1, 200 Level), sessions, fees and status labels are NOT courses. Results or transcript pages ' +
        'listing grades for past semesters are not the current course list: set isCourseList false for them. ' +
        'If several semesters are shown, return only the current / most recent one. ' +
        'Set isRegistrationForm true ONLY when the courses have unchecked checkboxes next to them for selecting ' +
        'which to register (see FORM STATE); session/semester dropdowns with a View button do not count. ' +
        'Return STRICT JSON: {"isCourseList": boolean, "isRegistrationForm": boolean, ' +
        '"confidence": number (0-1), "reason": string, ' +
        '"courses": [{"code": string|null, "title": string, "units": number|null, ' +
        '"semester": string|null, "session": string|null}]}.',
      input,
    );
    if (Object.keys(extracted).length === 0) {
      return { items: [], accepted: false, reason: 'extraction model error', retryable: true };
    }

    const list = Array.isArray(extracted.courses) ? extracted.courses : [];
    const courses: ScrapedCourse[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const title = typeof r.title === 'string' ? r.title.trim() : '';
      const code = typeof r.code === 'string' && r.code.trim() ? r.code.trim() : undefined;
      const semester = [r.semester, r.session]
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((v) => v.trim())
        .join(' ');
      const course: ScrapedCourse = {
        externalId: `agent-c-${code ?? i}-${title.slice(0, 24)}`,
        code,
        title: title || code || '',
        units: parseUnits(r.units),
        semester: semester || undefined,
      };
      if (!this.isLikelyCourse(course)) continue;
      const key = `${(code ?? '').toLowerCase()}::${course.title.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      courses.push(course);
    }

    const reason = typeof extracted.reason === 'string' ? extracted.reason.slice(0, 160) : undefined;
    const uncheckedBoxes = obs.checkboxCount - obs.checkedCount;
    if (extracted.isRegistrationForm === true && uncheckedBoxes >= 2) {
      return {
        items: [],
        accepted: false,
        reason: 'this is a registration form of offered courses; find the registered / printed course form',
      };
    }
    if (extracted.isCourseList === false) {
      return { items: [], accepted: false, reason: reason ?? 'not a course list' };
    }
    if (typeof extracted.confidence === 'number' && extracted.confidence < 0.4) {
      return { items: [], accepted: false, reason: `low confidence (${extracted.confidence})` };
    }
    const enough =
      courses.length >= 2 ||
      (courses.length === 1 && COURSE_CODE.test(`${courses[0].code ?? ''} ${courses[0].title}`));
    if (!enough) {
      return { items: [], accepted: false, reason: 'no real course units with codes found' };
    }
    return { items: courses, accepted: true, reason };
  }

  /** Reject programme/level/status strings that are not real course units. */
  private isLikelyCourse(course: { title?: string; code?: string; externalId?: string }): boolean {
    if (/^programme:/i.test(course.externalId ?? '')) return false;
    const title = (course.title ?? '').trim();
    const code = (course.code ?? '').trim();
    if (!title && !code) return false;
    const blob = `${code} ${title}`.trim();
    if (blob.length < 3) return false;

    if (
      /\b(full\s*time|part\s*time)\b/i.test(blob) &&
      /\b(nd|hnd|b\.?\s*sc|b\.?\s*eng|m\.?\s*sc|phd|pgd|degree|diploma|programme|program)\b/i.test(
        blob,
      )
    ) {
      return false;
    }
    if (
      /^(nd|hnd|b\.?\s*sc|b\.?\s*eng|m\.?\s*sc|phd|pgd)\b/i.test(blob) &&
      !/\b[A-Z]{2,4}\s*\d{2,4}\b/.test(blob)
    ) {
      return false;
    }
    if (
      /\b(academic session|current semester|current level|student status|school fees|hostel status|course registration status|not paid|not registered|graduated)\b/i.test(
        blob,
      )
    ) {
      return false;
    }
    if (/^(dashboard|biodata|fee payments|telegram|twitter|support)\b/i.test(blob)) {
      return false;
    }
    return true;
  }

  /**
   * School-agnostic identity harvest: if a page exposes matric/name/email/programme
   * labels or common dashboard patterns, upsert a portal profile. Safe to call often.
   */
  private async harvestIdentityFromText(
    text: string,
    onboardingSessionId: string,
    userId: string,
    source: string,
  ): Promise<boolean> {
    const body = (text || '').trim();
    if (body.length < 20) return false;

    let profile: {
      displayName?: string;
      email?: string;
      studentId?: string;
      departmentName?: string;
      academicLevelName?: string;
    } | null = null;

    const adapter = this.safeAdapter('GENERIC');
    if (adapter instanceof GenericPortalAdapter) {
      profile = adapter.parseLabeledProfile(body);
    }
    if (!profile) {
      const matric = /\b([A-Z]\/[A-Z0-9][A-Z0-9/]+|\d{5,}[A-Z]?\d*)\b/i.exec(body)?.[1];
      const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(body)?.[0];
      const full = /Full Name:\s*([^\n\r]+)/i.exec(body)?.[1]?.trim();
      const nameLine = body
        .split(/\n/)
        .map((l) => l.trim().replace(/\s+/g, ' '))
        .find(
          (l) =>
            /^[A-Z][A-Z\s.'-]{5,}$/.test(l) &&
            !/DASHBOARD|SEMESTER|STATUS|DOWNLOAD|ACADEMIC|CURRENT|COLLEGE|HELP|SETTINGS|PORTAL/i.test(
              l,
            ),
        );
      const programme = /\b((?:ND|HND|B\.?Sc\.?|B\.?Eng\.?|M\.?Sc\.?)\s*\([^)]+\)[^\n]*)/i.exec(
        body,
      )?.[1]?.trim();
      if (!full && !matric && !email && !nameLine) return false;
      profile = {
        displayName: full || nameLine,
        studentId: matric,
        email,
        departmentName: programme,
      };
    }

    const compact = Object.fromEntries(
      Object.entries({ ...profile, source }).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    );
    try {
      await prisma.discoveredPortalProfile.upsert({
        where: { onboardingSessionId },
        create: {
          onboardingSessionId,
          userId,
          displayName: profile.displayName || null,
          email: profile.email || null,
          studentId: profile.studentId || null,
          departmentName: profile.departmentName || null,
          academicLevelName: profile.academicLevelName || null,
          rawJson: compact,
        },
        update: {
          ...(profile.displayName ? { displayName: profile.displayName } : {}),
          ...(profile.email ? { email: profile.email } : {}),
          ...(profile.studentId ? { studentId: profile.studentId } : {}),
          ...(profile.departmentName ? { departmentName: profile.departmentName } : {}),
          ...(profile.academicLevelName ? { academicLevelName: profile.academicLevelName } : {}),
          rawJson: compact,
        },
      });
    } catch (err) {
      logger.error(
        { err, onboardingSessionId, source, compact },
        'Portal identity upsert failed',
      );
      throw err;
    }
    logger.info(
      { onboardingSessionId, source, studentId: profile.studentId, displayName: profile.displayName },
      'Harvested portal identity',
    );
    return true;
  }

  /** Retrying biodata/result capture used by profile + courses phases. */
  private async capturePortalAcademics(
    page: Page,
    home: string,
    onboardingSessionId: string,
    userId: string,
  ): Promise<void> {
    const existing = await prisma.discoveredPortalProfile.findUnique({
      where: { onboardingSessionId },
    });

    if (!existing) {
      for (const pg of ['home', 'biodata'] as const) {
        try {
          await page.goto(this.portalPage(home, pg), {
            waitUntil: 'domcontentloaded',
            timeout: 25_000,
          });
          if (pg === 'biodata') {
            await page.waitForSelector('text=Full Name', { timeout: 6_000 }).catch(() => undefined);
          }
          await page.waitForTimeout(900);
          const body = ((await page.locator('body').innerText().catch(() => '')) || '').trim();
          const ok = await this.harvestIdentityFromText(
            body,
            onboardingSessionId,
            userId,
            `capture:${pg}`,
          );
          if (ok) break;
        } catch (err) {
          logger.warn({ err, onboardingSessionId, pg }, 'capture page failed');
        }
      }
    }

    const recCount = await prisma.discoveredAcademicRecord.count({
      where: { onboardingSessionId },
    });
    if (recCount === 0) {
      for (const pg of ['result', 'results', 'transcript'] as const) {
        try {
          // scrapeAcademicResults navigates using portalPage(home,'result') internally when home given;
          // for alternate pages, goto first then reuse table parser via temporary home query.
          await page.goto(this.portalPage(home, pg), {
            waitUntil: 'domcontentloaded',
            timeout: 20_000,
          });
          await page.waitForSelector('table', { timeout: 5_000 }).catch(() => undefined);
          const text = ((await page.locator('body').innerText().catch(() => '')) || '').trim();
          if (!/academic session|cgpa|\bgpa\b|transcript|grade/i.test(text)) continue;
          // Parse table in-place (same logic as scrapeAcademicResults) without re-navigation.
          const rows: Array<Record<string, string>> = [];
          const tableText = await page.locator('table').first().innerText().catch(() => '');
          for (const line of tableText.split('\n')) {
            const parts = line.split('\t').map((p) => p.trim()).filter(Boolean);
            const sessionIdx = parts.findIndex((p) => /\d{4}\/\d{4}/.test(p));
            if (sessionIdx >= 0 && parts.length - sessionIdx >= 5) {
              const slice = parts.slice(sessionIdx);
              rows.push({
                session: slice[0],
                semester: slice[1],
                level: slice[2],
                cgpa: slice[3],
                gpa: slice[4],
              });
            }
          }
          if (rows.length === 0) continue;
          const latestCgpa = Number(rows[rows.length - 1]?.cgpa);
          await prisma.discoveredAcademicRecord.create({
            data: {
              onboardingSessionId,
              userId,
              cumulativeGpa: Number.isFinite(latestCgpa) ? latestCgpa : undefined,
              courseGrades: rows,
              gradingScale: { source: 'portal-result-table', page: pg },
            },
          });
          logger.info({ onboardingSessionId, rows: rows.length, pg }, 'Scraped academic results');
          break;
        } catch {
          continue;
        }
      }
    }
  }

  private async scrapeAssignments(
    page: Page,
    account: {
      id: string;
      lmsType: string;
      lmsBaseUrl: string;
      universityId: string | null;
      portalCandidateId?: string | null;
    },
    onboardingSessionId: string,
    userId: string,
    config?: GenericPortalConfig,
  ): Promise<void> {
    const home = await this.resolvePortalHome(account);
    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const adapter = this.safeAdapter(account.lmsType);
    let assignments: ScrapedAssignment[] =
      (adapter.listAssignments
        ? await adapter.listAssignments(page, config).catch(() => [])
        : []) ?? [];

    if (assignments.length === 0) {
      assignments = await this.runAgent(
        page,
        account,
        home,
        this.assignmentGoal(),
        onboardingSessionId,
        userId,
      );
    }

    for (const a of assignments) {
      await prisma.discoveredAssignment.create({
        data: {
          onboardingSessionId,
          userId,
          externalId: a.externalId,
          title: a.title,
          courseExternalId: a.courseExternalId,
          courseTitle: a.courseTitle,
          dueAt: this.parseDate(a.dueAt),
          url: a.url,
          eventType: a.eventType,
        },
      });
    }
    logger.info({ onboardingSessionId, count: assignments.length }, 'Scraped assignments');
  }

  private assignmentGoal(): AgentGoal<ScrapedAssignment> {
    return {
      name: 'assignments',
      description:
        "Find where the student's assignments, coursework, tests, quizzes or exams are listed with " +
        'due dates or dates (e.g. Assignments, Coursework, CA/Tests, Exam Timetable, Calendar).',
      maxSteps: 6,
      timeBudgetMs: 75_000,
      extract: async (obs) => {
        const input = buildExtractionInput(obs);
        if (input.length < 60) return { items: [], accepted: false, reason: 'page is nearly empty' };
        const extracted = await this.extractJson(
          "You read one page from a student's school portal (tables are TSV). Decide whether it lists " +
            "the student's assignments, coursework, tests, quizzes or exams with dates. " +
            'Return STRICT JSON: {"isAssignmentList": boolean, "reason": string, "assignments": ' +
            '[{"title": string, "courseTitle": string|null, "dueAt": ISO8601|null, ' +
            '"eventType": "assignment"|"exam"|"test"|"quiz"|null}]}.',
          input,
        );
        if (Object.keys(extracted).length === 0) {
          return { items: [], accepted: false, reason: 'extraction model error', retryable: true };
        }
        const list = Array.isArray(extracted.assignments) ? extracted.assignments : [];
        const items: ScrapedAssignment[] = list
          .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
          .filter((a) => typeof a.title === 'string' && a.title.trim().length > 0)
          .map((a, i) => ({
            externalId: `agent-a-${i}`,
            title: (a.title as string).trim(),
            courseTitle: typeof a.courseTitle === 'string' ? a.courseTitle : undefined,
            dueAt: typeof a.dueAt === 'string' ? a.dueAt : undefined,
            eventType: parseEventType(a.eventType),
          }));
        const reason = typeof extracted.reason === 'string' ? extracted.reason.slice(0, 160) : undefined;
        if (extracted.isAssignmentList !== true || items.length === 0) {
          return { items: [], accepted: false, reason: reason ?? 'no assignments on this page' };
        }
        return { items, accepted: true, reason };
      },
    };
  }

  private async scrapeTimetable(
    page: Page,
    account: {
      id: string;
      lmsType: string;
      lmsBaseUrl: string;
      universityId: string | null;
      portalCandidateId?: string | null;
    },
    onboardingSessionId: string,
    userId: string,
    config?: GenericPortalConfig,
  ): Promise<void> {
    const home = await this.resolvePortalHome(account);
    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const adapter = this.safeAdapter(account.lmsType);
    let slots: ScrapedSlot[] =
      (adapter.listTimetable
        ? await adapter.listTimetable(page, config).catch(() => [])
        : []) ?? [];

    if (slots.length === 0) {
      slots = await this.runAgent(page, account, home, this.timetableGoal(), onboardingSessionId, userId);
    }

    for (const slot of slots) {
      await prisma.discoveredTimetableSlot.create({
        data: {
          onboardingSessionId,
          userId,
          externalId: slot.externalId,
          title: slot.title,
          courseExternalId: slot.courseExternalId,
          courseTitle: slot.courseTitle,
          dayOfWeek: slot.dayOfWeek,
          startsAt: this.parseDate(slot.startsAt),
          endsAt: this.parseDate(slot.endsAt),
          location: slot.location,
        },
      });
    }
    logger.info({ onboardingSessionId, count: slots.length }, 'Scraped timetable');
  }

  private timetableGoal(): AgentGoal<ScrapedSlot> {
    return {
      name: 'timetable',
      description:
        "Find the student's class / lecture timetable or weekly schedule (days, times, venues, courses).",
      maxSteps: 6,
      timeBudgetMs: 75_000,
      extract: async (obs) => {
        const input = buildExtractionInput(obs);
        if (input.length < 60) return { items: [], accepted: false, reason: 'page is nearly empty' };
        const extracted = await this.extractJson(
          "You read one page from a student's school portal (tables are TSV). Decide whether it shows " +
            "the student's class / lecture timetable. " +
            'Return STRICT JSON: {"isTimetable": boolean, "reason": string, "slots": [{"title": string, ' +
            '"dayOfWeek": 1-7|null, "startsAt": ISO8601|null, "endsAt": ISO8601|null, ' +
            '"location": string|null, "courseTitle": string|null}]}.',
          input,
        );
        if (Object.keys(extracted).length === 0) {
          return { items: [], accepted: false, reason: 'extraction model error', retryable: true };
        }
        const list = Array.isArray(extracted.slots) ? extracted.slots : [];
        const items: ScrapedSlot[] = list
          .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
          .filter((s) => typeof s.title === 'string' && s.title.trim().length > 0)
          .map((s, i) => ({
            externalId: `agent-slot-${i}`,
            title: (s.title as string).trim(),
            dayOfWeek:
              typeof s.dayOfWeek === 'number' && s.dayOfWeek >= 1 && s.dayOfWeek <= 7
                ? s.dayOfWeek
                : undefined,
            startsAt: typeof s.startsAt === 'string' ? s.startsAt : undefined,
            endsAt: typeof s.endsAt === 'string' ? s.endsAt : undefined,
            location: typeof s.location === 'string' ? s.location : undefined,
            courseTitle: typeof s.courseTitle === 'string' ? s.courseTitle : undefined,
          }));
        const reason = typeof extracted.reason === 'string' ? extracted.reason.slice(0, 160) : undefined;
        if (extracted.isTimetable !== true || items.length === 0) {
          return { items: [], accepted: false, reason: reason ?? 'no timetable on this page' };
        }
        return { items, accepted: true, reason };
      },
    };
  }

  /**
   * Learned path first (fast, no navigation LLM calls), then the full agent.
   * Successful agent runs are saved so the next student at the same school
   * skips exploration.
   */
  private async runAgent<T>(
    page: Page,
    account: AgentAccount,
    home: string,
    goal: AgentGoal<T>,
    onboardingSessionId: string,
    userId: string,
  ): Promise<T[]> {
    const agent = new PortalAgent(page, this.navLlms);
    const learned = await this.loadLearnedPath(account, home, goal.name).catch(() => undefined);

    let result: AgentRunResult<T> | null = null;
    if (learned) {
      result = await agent.replay(goal, learned, home).catch(() => null);
      if (!result) logger.info({ onboardingSessionId, goal: goal.name }, 'Learned path failed; exploring');
    }
    if (!result) {
      result = await agent.run(goal, home).catch((err) => {
        logger.warn(
          { onboardingSessionId, goal: goal.name, err: err instanceof Error ? err.message : String(err) },
          'Portal agent crashed',
        );
        return { items: [], via: 'none', trace: [], durationMs: 0 } as AgentRunResult<T>;
      });
    }

    if (result.items.length > 0 && result.learned) {
      await this.saveLearnedPath(account, home, goal.name, result.learned).catch((err) =>
        logger.warn(
          { onboardingSessionId, goal: goal.name, err: err instanceof Error ? err.message : String(err) },
          'Could not save learned path',
        ),
      );
    }

    logger.info(
      {
        onboardingSessionId,
        goal: goal.name,
        via: result.via,
        count: result.items.length,
        steps: result.trace.length,
        durationMs: result.durationMs,
      },
      'Portal agent finished',
    );

    await writeAuditLog({
      actorId: userId,
      action: `deep_scrape_${goal.name}_trace`,
      resourceType: 'onboarding_session',
      resourceId: onboardingSessionId,
      metadata: {
        via: result.via,
        usedLearnedPath: !!learned,
        itemCount: result.items.length,
        durationMs: result.durationMs,
        steps: result.trace.map((t) => ({
          step: t.step,
          url: t.url,
          action: t.action,
          target: t.target,
          result: t.result,
        })),
      },
    }).catch(() => undefined);

    return result.items;
  }

  private async loadLearnedPath(
    account: AgentAccount,
    home: string,
    goal: AgentGoalName,
  ): Promise<LearnedPath | undefined> {
    if (!account.universityId) return undefined;
    const row = await prisma.portalAdapterConfig.findUnique({
      where: {
        universityId_lmsType: {
          universityId: account.universityId,
          lmsType: account.lmsType as never,
        },
      },
    });
    const learned = (row?.paths as { learned?: LearnedStore } | null)?.learned;
    const path = learned?.[portalHost(home)]?.[goal];
    if (!path || typeof path.finalUrl !== 'string' || !Array.isArray(path.steps)) return undefined;
    return path;
  }

  private async saveLearnedPath(
    account: AgentAccount,
    home: string,
    goal: AgentGoalName,
    path: LearnedPath,
  ): Promise<void> {
    if (!account.universityId) return;
    const where = {
      universityId_lmsType: {
        universityId: account.universityId,
        lmsType: account.lmsType as never,
      },
    };
    const row = await prisma.portalAdapterConfig.findUnique({ where });
    const paths = (row?.paths && typeof row.paths === 'object' ? row.paths : {}) as Record<string, unknown>;
    const learned = (paths.learned && typeof paths.learned === 'object'
      ? paths.learned
      : {}) as LearnedStore;
    const host = portalHost(home);
    learned[host] = { ...learned[host], [goal]: path };
    const nextPaths = { ...paths, learned } as object;

    await prisma.portalAdapterConfig.upsert({
      where,
      create: {
        universityId: account.universityId,
        lmsType: account.lmsType as never,
        paths: nextPaths,
      },
      update: { paths: nextPaths },
    });
  }

  private safeAdapter(lmsType: string) {
    try {
      return this.registry.get(lmsType as LmsType);
    } catch {
      return this.registry.get(LmsType.GENERIC);
    }
  }

  private async loadAdapterConfig(
    universityId: string | null,
    lmsType: string,
  ): Promise<GenericPortalConfig | undefined> {
    if (!universityId) return undefined;
    const row = await prisma.portalAdapterConfig.findUnique({
      where: {
        universityId_lmsType: {
          universityId,
          lmsType: lmsType as never,
        },
      },
    });
    if (!row) return undefined;
    const { learned: _learned, ...paths } = (row.paths ?? {}) as Record<string, unknown>;
    return {
      selectors: (row.selectors as GenericPortalConfig['selectors']) ?? undefined,
      paths: Object.keys(paths).length > 0 ? (paths as GenericPortalConfig['paths']) : undefined,
    };
  }

  private async extractJson(
    instruction: string,
    text: string,
  ): Promise<Record<string, unknown>> {
    try {
      const raw = await withTimeout(this.llm.completeJson(instruction, text), EXTRACT_TIMEOUT_MS);
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'LLM extraction failed');
      return {};
    }
  }

  private parseDate(value: unknown): Date | undefined {
    if (typeof value !== 'string') return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
}

function buildExtractionInput(obs: PageObservation): string {
  const parts = [`URL: ${obs.url}`, `TITLE: ${obs.title}`];
  parts.push(`FORM STATE: ${obs.checkboxCount} visible checkboxes, ${obs.checkedCount} checked`);
  if (obs.tables.length > 0) {
    parts.push(`TABLES (TSV):\n${obs.tables.join('\n---\n').slice(0, 10_000)}`);
  }
  parts.push(`PAGE TEXT:\n${obs.text.slice(0, 4_000)}`);
  return parts.join('\n\n');
}

function parseUnits(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  return Number.isInteger(n) && n > 0 && n < 30 ? n : undefined;
}

function parseEventType(value: unknown): ScrapedAssignment['eventType'] {
  return value === 'assignment' || value === 'exam' || value === 'test' || value === 'quiz'
    ? value
    : 'assignment';
}

function portalHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
