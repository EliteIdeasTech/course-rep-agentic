import type { Page } from 'playwright-core';
import { LmsType } from '@cr-agentic/shared';
import {
  GenericPortalConfig,
  ILmsAdapter,
  LmsAssignment,
  LmsCourse,
  LmsMaterial,
  LmsProfile,
  LmsTimetableSlot,
} from '../core/lms-adapter.interface';

const DEFAULT_CONFIG: GenericPortalConfig = {
  selectors: {
    authMarker: '[data-user-profile], .user-menu, #profile-dropdown, .usermenu, .avatar',
    courseList: '.course-list, [data-course-list], .courses',
    courseLink: 'a.course-link, [data-course-link], a[href*="course"]',
    courseTitle: '.course-title, [data-course-title]',
    materialList: '.material-list, [data-materials], .files-list',
    materialLink: 'a.material-link, [data-file-link], a[href*="download"]',
    materialTitle: '.material-title, [data-file-name]',
    downloadLink: 'a[download], a[href*="download"]',
    username: 'input[name="username"], input[name="email"], input[name="matric_number"], input[name="matric"], input[name="student_id"], input[name="studentId"], input[type="email"], #username, #email, #matric_number, #matric',
    password: 'input[name="password"], input[type="password"], #password',
    submit: 'button[type="submit"], input[type="submit"]',
    assignmentList: '.assignment, .assignment-item, [data-assignment]',
    assignmentLink: 'a[href*="assignment"], a[href*="homework"]',
    assignmentTitle: '.assignment-title, .title',
    assignmentDue: '.due-date, .deadline, time',
    timetableRow: '.timetable-row, .schedule-row, tr[data-slot]',
    profileMarker: '.profile, .user-profile, #profile',
  },
  paths: {
    courses: '/courses',
    dashboard: '/dashboard',
    assignments: '/assignments',
    timetable: '/timetable',
    profile: '/profile',
    login: '/login',
  },
};

export class GenericPortalAdapter implements ILmsAdapter {
  readonly lmsType = LmsType.GENERIC;

  loginUrl(baseUrl: string): string {
    return new URL('/login', baseUrl).toString();
  }

  async validateSession(
    page: Page,
    config: GenericPortalConfig = DEFAULT_CONFIG,
  ): Promise<boolean> {
    const selector = config.selectors?.authMarker ?? DEFAULT_CONFIG.selectors!.authMarker!;
    try {
      await page.waitForSelector(selector, { timeout: 8_000 });
      return true;
    } catch {
      // Nigerian portals like YabaTech portalplus often lack shared auth chrome.
      const url = page.url().toLowerCase();
      const passwordVisible = (await page.locator('input[type="password"]').count()) > 0;
      if (passwordVisible) return false;

      if (/[?&]pg=home\b/.test(url) || /\/portalplus\//i.test(url) && !/login/i.test(url)) {
        return true;
      }

      const body = ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase();
      const looksLoggedIn =
        /(dashboard|biodata|course registration|my result|current semester)/i.test(body) &&
        !/sign in to student portal/i.test(body.slice(0, 160));
      return looksLoggedIn;
    }
  }

  async attemptCredentialLogin(
    page: Page,
    credentials: { username: string; password: string },
    config: GenericPortalConfig = DEFAULT_CONFIG,
  ): Promise<boolean> {
    const userSel = config.selectors?.username ?? DEFAULT_CONFIG.selectors!.username!;
    const passSel = config.selectors?.password ?? DEFAULT_CONFIG.selectors!.password!;
    const submitSel = config.selectors?.submit ?? DEFAULT_CONFIG.selectors!.submit!;

    // If the confirmed login URL already has a form, stay put; otherwise try common paths.
    const passwordProbe = page.locator(passSel).first();
    if ((await passwordProbe.count()) === 0) {
      const base = page.url();
      const candidates = [
        config.paths?.login,
        '/portalplus/',
        '/portalplus/login',
        '/portal/',
        '/login',
        '/',
      ].filter(Boolean) as string[];
      for (const path of candidates) {
        try {
          await page.goto(new URL(path, base).toString(), {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          });
          await page.waitForTimeout(1500);
          if ((await page.locator(passSel).first().count()) > 0) break;
        } catch {
          // try next path
        }
      }
    }

    try {
      await page.waitForSelector(passSel, { timeout: 15_000 });
    } catch {
      return false;
    }

    const username = page.locator(userSel).first();
    const password = page.locator(passSel).first();
    const submit = page.locator(submitSel).first();

    if ((await username.count()) === 0 || (await password.count()) === 0) {
      return false;
    }

    await username.fill(credentials.username);
    await password.fill(credentials.password);
    if ((await submit.count()) > 0) {
      await submit.click();
    } else {
      await password.press('Enter');
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);

    const url = page.url().toLowerCase();
    if (
      /mfa|sso|oauth|captcha|challenge|verify|2fa|otp/.test(url) ||
      (await page.locator('iframe[src*="captcha"], .g-recaptcha, [data-sitekey]').count()) > 0
    ) {
      return false;
    }

    return this.validateSession(page, config);
  }

  async listCourses(
    page: Page,
    config: GenericPortalConfig = DEFAULT_CONFIG,
  ): Promise<LmsCourse[]> {
    const start = page.url();
    const courseSelector = config.selectors?.courseLink ?? DEFAULT_CONFIG.selectors!.courseLink!;
    const titleSelector = config.selectors?.courseTitle ?? DEFAULT_CONFIG.selectors!.courseTitle!;
    const courses: LmsCourse[] = [];
    const seen = new Set<string>();

    const pushCourse = (c: LmsCourse) => {
      const key = `${(c.code || '').toLowerCase()}|${c.title.toLowerCase()}|${c.externalId}`;
      if (!c.title || seen.has(key)) return;
      seen.add(key);
      courses.push(c);
    };

    // Follow academic nav targets already in the DOM. Collapsed side menus are
    // often off-canvas but still present — no hamburger click required.
    const navHrefs = await this.collectAcademicNavHrefs(page).catch(() => [] as string[]);

    const pathProbes = [
      config.paths?.courses ?? '/courses',
      '/course_registration',
      '/course_registration/view',
      '/course_registration/register',
      '/course_registration/session',
      '/course-registration',
      '/course-registration/view',
      '/courses',
      '/dashboard',
      '?pg=home',
      '?pg=course-registration',
      '?pg=courses',
    ];

    const targets: string[] = [];
    for (const href of navHrefs) {
      if (/course|regist/i.test(href)) targets.push(href);
    }
    for (const path of pathProbes) {
      try {
        targets.push(
          path.startsWith('?')
            ? this.withQuery(start, path)
            : new URL(path, start).toString(),
        );
      } catch {
        // ignore bad path
      }
    }

    for (const target of Array.from(new Set(targets))) {
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await page.waitForTimeout(1_200);
        const text = ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase();
        if (/access is restricted/i.test(text)) continue;

        for (const c of await this.extractCoursesFromTables(page)) pushCourse(c);

        const elements = await page.locator(courseSelector).all();
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i];
          const href = (await el.getAttribute('href')) ?? `course-${i}`;
          const titleEl = el.locator(titleSelector).first();
          const title =
            (await titleEl.count()) > 0
              ? (await titleEl.textContent())?.trim()
              : (await el.textContent())?.trim();
          if (!title || this.isNavJunkTitle(title)) continue;
          pushCourse({
            externalId: href,
            title: title.replace(/\s+/g, ' ').trim(),
            url: new URL(href, page.url()).toString(),
          });
        }

        if (courses.length > 0) return courses;
      } catch {
        // try next target
      }
    }

    // Fallback: programme line on dashboard / portal home.
    try {
      await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForTimeout(800);
      const text = ((await page.locator('body').innerText().catch(() => '')) || '').trim();
      const prog =
        /(?:ND|HND|B\.?\s*Sc|B\.?\s*Eng|M\.?\s*Sc)\s*\([^)]+\)[^\n]*/i.exec(text)?.[0]?.trim();
      const matric = /\b([A-Z]\/[A-Z0-9/]+)\b/i.exec(text)?.[1];
      if (prog) {
        pushCourse({
          externalId: matric ? `programme:${matric}` : 'programme:current',
          title: prog,
        });
      }
    } catch {
      // ignore
    }
    return courses;
  }

  async listAssignments(
    page: Page,
    config: GenericPortalConfig = DEFAULT_CONFIG,
  ): Promise<LmsAssignment[]> {
    const path = config.paths?.assignments ?? DEFAULT_CONFIG.paths!.assignments!;
    const base = page.url();
    await page.goto(new URL(path, base).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    }).catch(() => undefined);

    const linkSel = config.selectors?.assignmentLink ?? DEFAULT_CONFIG.selectors!.assignmentLink!;
    const items = await page.locator(linkSel).all().catch(() => []);
    const assignments: LmsAssignment[] = [];

    for (let i = 0; i < items.length; i++) {
      const el = items[i];
      const title = (await el.textContent())?.trim();
      const href = await el.getAttribute('href');
      if (!title) continue;
      assignments.push({
        externalId: href ?? `generic-a-${i}`,
        title,
        url: href ? (href.startsWith('http') ? href : new URL(href, base).toString()) : undefined,
        eventType: /exam|test|quiz/i.test(title) ? 'exam' : 'assignment',
      });
    }
    return assignments;
  }

  async listTimetable(
    page: Page,
    config: GenericPortalConfig = DEFAULT_CONFIG,
  ): Promise<LmsTimetableSlot[]> {
    const path = config.paths?.timetable ?? DEFAULT_CONFIG.paths!.timetable!;
    const base = page.url();
    await page.goto(new URL(path, base).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    }).catch(async () => {
      await page.goto(new URL('/calendar', base).toString(), {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      }).catch(() => undefined);
    });

    const rowSel = config.selectors?.timetableRow ?? DEFAULT_CONFIG.selectors!.timetableRow!;
    const rows = await page.locator(rowSel).all().catch(() => []);
    const slots: LmsTimetableSlot[] = [];
    for (let i = 0; i < rows.length; i++) {
      const text = (await rows[i].textContent())?.trim();
      if (!text) continue;
      slots.push({
        externalId: `generic-slot-${i}`,
        title: text.slice(0, 200),
      });
    }
    return slots;
  }

  async extractProfile(
    page: Page,
    config: GenericPortalConfig = DEFAULT_CONFIG,
  ): Promise<LmsProfile | null> {
    const start = page.url();
    // Prefer in-app query pages; avoid absolute "/profile" which can leave /portalplus/.
    const candidates = ['?pg=biodata', '?pg=home', config.paths?.profile].filter(
      Boolean,
    ) as string[];

    for (const path of candidates) {
      try {
        const target = path.startsWith('?')
          ? this.withQuery(start, path)
          : path.startsWith('http')
            ? path
            : new URL(path.replace(/^\//, ''), start.endsWith('/') ? start : start + '/').toString();
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(800);
        const text = ((await page.locator('body').innerText().catch(() => '')) || '').trim();
        const parsed = this.parseLabeledProfile(text);
        if (parsed) return parsed;

        const email =
          (await page.locator('a[href^="mailto:"]').first().textContent().catch(() => null))?.trim() ||
          undefined;
        const displayName =
          (await page.locator('h1, h2, .profile-name, .user-name').first().textContent().catch(() => null))?.trim() ||
          undefined;
        if (email || (displayName && !/^dashboard$/i.test(displayName))) {
          return { displayName, email };
        }
      } catch {
        // try next candidate
      }
    }
    return null;
  }



  /** Nav chrome titles — not enrolled courses. */
  private isNavJunkTitle(title: string): boolean {
    return /download your course material|course registration|course management|hostel|biodata|fee payment|school fees|telegram|twitter|dashboard|helpdesk|settings|acceptance|logout|modules|reports|school setup/i.test(
      title.trim(),
    );
  }

  /**
   * Collect academic destinations from ALL anchors in the DOM, including those
   * inside collapsed/off-canvas side menus (no click needed if href exists).
   */
  private async collectAcademicNavHrefs(page: Page): Promise<string[]> {
    // String form avoids needing DOM libs in the Node TS project.
    return page.evaluate(`(() => {
      const textRe = /course\\s*reg|registered\\s*course|my\\s*courses?|results?|transcript|time\\s*table|timetable|biodata|profile|lecture/i;
      const hrefRe = /course[_-]?reg|registered|\\/courses(?:\\/|$)|\\/results?(?:\\/|$)|timetable|transcript|biodata|lecture/i;
      const out = [];
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const text = (a.textContent || '').replace(/\\s+/g, ' ').trim();
        const href = a.getAttribute('href') || '';
        if (!href || href.startsWith('javascript:') || href === '#') continue;
        if (textRe.test(text) || hrefRe.test(href)) {
          try { out.push(new URL(href, location.href).toString()); } catch (e) {}
        }
      }
      return Array.from(new Set(out));
    })()`) as Promise<string[]>;
  }

  /** Parse course code/title rows from tables and plain text lines. */
  private async extractCoursesFromTables(page: Page): Promise<LmsCourse[]> {
    return page.evaluate(`(() => {
      const codeRe = /^[A-Z]{2,4}\\s*\\d{2,4}[A-Z]?$/i;
      const out = [];
      const seen = new Set();
      const add = (code, title) => {
        const t = (title || '').replace(/\\s+/g, ' ').trim();
        if (!t || t.length < 3) return;
        const key = ((code || '') + '|' + t).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          externalId: code ? ('course:' + code) : ('course:' + t.slice(0, 40)),
          title: t,
          code: code || undefined,
        });
      };
      for (const tr of Array.from(document.querySelectorAll('table tr'))) {
        const cells = Array.from(tr.querySelectorAll('td,th')).map((c) =>
          (c.textContent || '').replace(/\\s+/g, ' ').trim(),
        );
        if (cells.length < 2) continue;
        if (cells.some((c) => /^(s\\/n|sn|code|course\\s*code|title|course\\s*title)$/i.test(c))) continue;
        const codeIdx = cells.findIndex((c) => codeRe.test(c));
        if (codeIdx >= 0) {
          const code = cells[codeIdx].toUpperCase().replace(/\\s+/g, ' ');
          const title = cells.find((c, i) => i !== codeIdx && c.length > 3 && !/^\\d+(\\.\\d+)?$/.test(c)) || '';
          add(code, title || code);
        }
      }
      const body = (document.body && document.body.innerText) || '';
      for (const line of body.split(/\\n/)) {
        const m = /^\\s*([A-Z]{2,4}\\s*\\d{2,4}[A-Z]?)\\s*[-–:]\\s*(.+)$/i.exec(line.trim());
        if (m) add(m[1].toUpperCase().replace(/\\s+/g, ' '), m[2]);
      }
      return out;
    })()`) as Promise<LmsCourse[]>;
  }

  private withQuery(currentUrl: string, query: string): string {
    const u = new URL(currentUrl);
    const q = query.startsWith('?') ? query.slice(1) : query;
    u.search = q;
    // Keep directory path (e.g. /portalplus/)
    return u.toString();
  }

  parseLabeledProfile(text: string): LmsProfile | null {
    const get = (label: string) => {
      const re = new RegExp(
        '(?:^|[\\n\\r])\\s*' + label + '\\s*[:\\t]+\\s*([^\\n\\r]+)',
        'i',
      );
      const m = re.exec('\n' + text);
      return m?.[1]?.trim().replace(/\s+/g, ' ') || undefined;
    };
    const displayName = get('Full Name');
    const studentId = get('Matric number') || get('Matric No') || get('Matric');
    const email = get('Email');
    const departmentName = get('Department');
    const academicLevelName = get('Level');
    if (displayName || studentId || email) {
      return { displayName, email, studentId, departmentName, academicLevelName };
    }
    // Dashboard cards: matric + ALL-CAPS name line, no "Full Name:" labels.
    const matric = /\b(F\/[A-Z0-9/]+)\b/i.exec(text)?.[1];
    const nameLine = text
      .split(/\n/)
      .map((l) => l.trim().replace(/\s+/g, ' '))
      .find(
        (l) =>
          /^[A-Z][A-Z\s.'-]{5,}$/.test(l) &&
          !/DASHBOARD|SEMESTER|STATUS|DOWNLOAD|ACADEMIC|CURRENT|COLLEGE|HELP|SETTINGS/i.test(
            l,
          ),
      );
    if (!matric && !nameLine) return null;
    return {
      displayName: nameLine,
      studentId: matric,
      departmentName: undefined,
      academicLevelName: undefined,
    };
  }

  async listMaterials(
    page: Page,
    course: LmsCourse,
    config: GenericPortalConfig = DEFAULT_CONFIG,
  ): Promise<LmsMaterial[]> {
    if (course.url) {
      await page.goto(course.url, { waitUntil: 'domcontentloaded' });
    }

    const materialSelector =
      config.selectors?.materialLink ?? DEFAULT_CONFIG.selectors!.materialLink!;
    const titleSelector =
      config.selectors?.materialTitle ?? DEFAULT_CONFIG.selectors!.materialTitle!;

    const elements = await page.locator(materialSelector).all();
    const materials: LmsMaterial[] = [];

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const href = (await el.getAttribute('href')) ?? `material-${i}`;
      const titleEl = el.locator(titleSelector).first();
      const title =
        (await titleEl.count()) > 0
          ? (await titleEl.textContent())?.trim()
          : (await el.textContent())?.trim();
      if (!title) continue;
      materials.push({
        externalId: href,
        title,
        url: href.startsWith('http') ? href : new URL(href, page.url()).toString(),
        courseExternalId: course.externalId,
        courseTitle: course.title,
      });
    }

    return materials;
  }

  async downloadMaterial(
    page: Page,
    material: LmsMaterial,
    config: GenericPortalConfig = DEFAULT_CONFIG,
  ): Promise<Buffer> {
    const downloadSelector =
      config.selectors?.downloadLink ?? DEFAULT_CONFIG.selectors!.downloadLink!;

    if (material.url) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        page.goto(material.url),
      ]);
      const stream = await download.createReadStream();
      if (!stream) throw new Error('Download stream unavailable');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }

    const link = page.locator(downloadSelector).first();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      link.click(),
    ]);
    const stream = await download.createReadStream();
    if (!stream) throw new Error('Download stream unavailable');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}

export function createDefaultLmsRegistry(): import('../core/lms-adapter.registry').LmsAdapterRegistry {
  const { LmsAdapterRegistry } = require('../core/lms-adapter.registry');
  const { CanvasAdapter } = require('../canvas/canvas.adapter');
  const { MoodleAdapter } = require('../moodle/moodle.adapter');
  const registry = new LmsAdapterRegistry();
  registry.register(new GenericPortalAdapter());
  registry.register(new CanvasAdapter());
  registry.register(new MoodleAdapter());
  return registry;
}
