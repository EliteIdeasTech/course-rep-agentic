import type { Page, Response } from 'playwright-core';
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
      if (this.isNavJunkTitle(c.title)) return;
      seen.add(key);
      courses.push(c);
    };

    // Capture course-like JSON from XHR/fetch while we navigate (SPA portals).
    const stopNetworkHarvest = this.startCourseNetworkHarvest(page, pushCourse);

    try {
      await this.dismissBlockingOverlays(page);

      // SPA portals (School Manager etc.): pull courses via authenticated APIs.
      for (const c of await this.harvestCoursesFromSpaApis(page).catch(() => [] as LmsCourse[])) {
        pushCourse(c);
      }
      if (courses.length > 0) return courses;

      // Ensure side-nav links exist in DOM; open hamburger if they do not.
      let navHrefs = await this.collectAcademicNavHrefs(page).catch(() => [] as string[]);
      if (navHrefs.length === 0) {
        await this.openSideNavIfPresent(page);
        await this.dismissBlockingOverlays(page);
        navHrefs = await this.collectAcademicNavHrefs(page).catch(() => [] as string[]);
      }

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
          // ignore
        }
      }

      for (const target of Array.from(new Set(targets))) {
        try {
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25_000 });
          await page.waitForTimeout(1_200);
          await this.dismissBlockingOverlays(page);

          const text = ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase();
          if (/access is restricted/i.test(text)) continue;

          for (const c of await this.extractCoursesFromTables(page)) pushCourse(c);

          // History tables (Session / Semester / Level + View): open each View.
          const drilled = await this.drillIntoDetailViews(page, pushCourse);
          if (drilled > 0 && courses.length > 0) {
            return courses;
          }

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
    } finally {
      stopNetworkHarvest();
    }
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





  /**
   * Generic SPA course harvest: find a Bearer JWT in web storage, discover /api
   * bases from performance entries, then call common registration history +
   * registered-courses endpoints (School Manager pattern used by many NG schools).
   */
  private async harvestCoursesFromSpaApis(page: Page): Promise<LmsCourse[]> {
    // Visit dashboard first so the SPA hydrates storage + fires API calls.
    try {
      const dash = new URL('/dashboard', page.url()).toString();
      await page.goto(dash, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => undefined);
      await page.waitForTimeout(2_000);
      await this.dismissBlockingOverlays(page);
    } catch {
      // continue with current page
    }

    return page.evaluate(`(async () => {
      const out = [];
      const seen = new Set();
      const add = (code, title) => {
        const t = (title || '').toString().replace(/\\s+/g, ' ').trim();
        if (!t || t.length < 3) return;
        const c = code ? String(code).replace(/\\s+/g, ' ').trim() : '';
        const key = (c + '|' + t).toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          externalId: c ? ('course:' + c) : ('course:' + t.slice(0, 40)),
          title: t,
          code: c || undefined,
        });
      };

      const findJwt = (node, depth) => {
        if (node == null || depth > 10) return null;
        if (typeof node === 'string') {
          if (/^eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(node)) return node;
          try { return findJwt(JSON.parse(node), depth + 1); } catch (e) { return null; }
        }
        if (typeof node !== 'object') return null;
        if (typeof node.token === 'string' && node.token.length > 20) {
          if (/^eyJ/.test(node.token) || node.token.length > 40) return node.token;
        }
        if (node.jwtToken) {
          const t = findJwt(node.jwtToken, depth + 1);
          if (t) return t;
        }
        for (const v of Object.values(node)) {
          const t = findJwt(v, depth + 1);
          if (t) return t;
        }
        return null;
      };

      let token = null;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const v = localStorage.getItem(k);
          token = findJwt(v, 0);
          if (token) break;
        }
      } catch (e) {}
      try {
        if (!token) {
          for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            const v = sessionStorage.getItem(k);
            token = findJwt(v, 0);
            if (token) break;
          }
        }
      } catch (e) {}

      const bases = new Set();
      try {
        performance.getEntriesByType('resource').forEach((e) => {
          const m = String(e.name).match(/^(https?:\\/\\/[^/]+\\/api)\\b/i);
          if (m) bases.add(m[1]);
        });
      } catch (e) {}
      // Same-origin fallback; many portals proxy /api.
      bases.add(location.origin.replace(/\\/$/, '') + '/api');

      // School Manager family: schmgr-{school}.azurewebsites.net/api
      try {
        const host = location.hostname.replace(/^www\./i, '');
        const core = host.replace(/^(portal|studentportal|students|myportal)\./i, '');
        const school = core.split('.')[0];
        if (school && school.length >= 2) {
          bases.add('https://schmgr-' + school + '.azurewebsites.net/api');
        }
      } catch (e) {}


      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;

      const asList = (j) => {
        if (!j) return [];
        if (Array.isArray(j)) return j;
        if (Array.isArray(j.data)) return j.data;
        if (Array.isArray(j.result)) return j.result;
        if (Array.isArray(j.items)) return j.items;
        if (j.data && Array.isArray(j.data.items)) return j.data.items;
        if (j.data && Array.isArray(j.data.courses)) return j.data.courses;
        if (Array.isArray(j.courses)) return j.courses;
        return [];
      };

      const walkCourses = (node, depth) => {
        if (!node || depth > 8) return;
        if (Array.isArray(node)) { node.forEach((x) => walkCourses(x, depth + 1)); return; }
        if (typeof node !== 'object') return;
        const code = node.courseCode || node.CourseCode || node.code || node.Code || node.course_code;
        const title = node.courseTitle || node.CourseTitle || node.title || node.Title || node.courseName || node.CourseName || node.name;
        if (typeof title === 'string' && title.trim().length > 2) {
          if (code || title.trim().length > 5) add(code, title);
        }
        Object.values(node).forEach((v) => {
          if (v && typeof v === 'object') walkCourses(v, depth + 1);
        });
      };

      for (const base of Array.from(bases)) {
        const b = String(base).replace(/\\/$/, '');
        // Dashboard payload sometimes embeds course summaries.
        for (const path of ['/Dashboard/getstudentdashboard', '/dashboard/getstudentdashboard']) {
          try {
            const r = await fetch(b + path, { headers: headers, credentials: 'include' });
            if (r.ok) walkCourses(await r.json(), 0);
          } catch (e) {}
        }

        let history = [];
        for (const path of [
          '/CourseRegistration/registeredcourseshistory',
          '/courseRegistration/registeredcourseshistory',
        ]) {
          try {
            const r = await fetch(b + path, { headers: headers, credentials: 'include' });
            if (!r.ok) continue;
            history = asList(await r.json());
            if (history.length) break;
          } catch (e) {}
        }

        for (const row of history) {
          if (!row || typeof row !== 'object') continue;
          const sessionId = row.sessionId || row.SessionId || row.sessionID;
          const semester = row.semester != null ? row.semester : row.Semester;
          const yearOfStudyId = row.yearOfStudyId || row.YearOfStudyId || row.levelId || row.LevelId || '';
          if (sessionId == null || semester == null) continue;
          const qs = 'SessionId=' + encodeURIComponent(sessionId)
            + '&Semester=' + encodeURIComponent(semester)
            + '&YearOfStudyId=' + encodeURIComponent(yearOfStudyId);
          for (const path of [
            '/courseRegistration/registeredcourses?' + qs,
            '/CourseRegistration/registeredcourses?' + qs,
          ]) {
            try {
              const r = await fetch(b + path, { headers: headers, credentials: 'include' });
              if (!r.ok) continue;
              walkCourses(await r.json(), 0);
              break;
            } catch (e) {}
          }
        }
      }
      return out;
    })()`) as Promise<LmsCourse[]>;
  }

  /** Close chat widgets / modals that block clicks on SPA portals. */
  private async dismissBlockingOverlays(page: Page): Promise<void> {
    const selectors = [
      'button[aria-label*="close" i]',
      'button[aria-label*="dismiss" i]',
      '.modal.show [data-dismiss="modal"]',
      '.modal.show .close',
      '.modal.show button.close',
      '[role="dialog"] button[aria-label*="close" i]',
    ];
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        await loc.click({ timeout: 1_500, force: true }).catch(() => undefined);
      }
    }
    await page
      .evaluate(`(() => {
        const hide = (el) => { try { el.style.setProperty('display','none','important'); el.style.setProperty('pointer-events','none','important'); } catch (e) {} };
        document.querySelectorAll('iframe[src*="zoho"], iframe[src*="chat"], #zohohc-asap-web-launcher-frame, .zh-chat, [class*="chat-widget"]').forEach(hide);
        document.querySelectorAll('.modal-backdrop').forEach(hide);
      })()`)
      .catch(() => undefined);
  }

  /** Open hamburger / side drawer when academic links are not yet in the DOM. */
  private async openSideNavIfPresent(page: Page): Promise<void> {
    const candidates = [
      'button.navbar-toggler',
      'button[aria-label*="menu" i]',
      'button[aria-label*="navigation" i]',
      '[class*="hamburger"]',
      'header button',
      'nav button',
    ];
    for (const sel of candidates) {
      const btn = page.locator(sel).first();
      if ((await btn.count().catch(() => 0)) === 0) continue;
      await btn.click({ timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(600);
      const hrefs = await this.collectAcademicNavHrefs(page).catch(() => [] as string[]);
      if (hrefs.length > 0) return;
    }
  }

  /**
   * On registration history pages (Session/Semester/Level + View), open each
   * detail View and harvest courses.
   */
  private async drillIntoDetailViews(
    page: Page,
    pushCourse: (c: LmsCourse) => void,
  ): Promise<number> {
    const body = ((await page.locator('body').innerText().catch(() => '')) || '').toLowerCase();
    const looksLikeHistory =
      (/session/.test(body) && /semester/.test(body)) ||
      /registered courses history|course registration/i.test(body);
    if (!looksLikeHistory) return 0;

    const viewLocator = page.locator(
      'table a:has-text("View"), table button:has-text("View"), table a:has-text("Details"), table button:has-text("Details"), a:has-text("View"), button:has-text("View")',
    );
    const count = Math.min(await viewLocator.count().catch(() => 0), 10);
    if (count === 0) return 0;

    let opened = 0;
    for (let i = 0; i < count; i++) {
      try {
        await this.dismissBlockingOverlays(page);
        const before = page.url();
        const el = viewLocator.nth(i);
        const href = await el.getAttribute('href').catch(() => null);
        if (href && href !== '#' && !href.startsWith('javascript:')) {
          await page.goto(new URL(href, page.url()).toString(), {
            waitUntil: 'domcontentloaded',
            timeout: 20_000,
          });
        } else {
          await el.click({ timeout: 5_000 });
          await page.waitForTimeout(1_500);
        }
        await this.dismissBlockingOverlays(page);
        for (const c of await this.extractCoursesFromTables(page)) pushCourse(c);
        opened += 1;

        if (page.url() !== before) {
          await page
            .goto(before, { waitUntil: 'domcontentloaded', timeout: 20_000 })
            .catch(() => undefined);
          await page.waitForTimeout(800);
        } else {
          await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
          await page.waitForTimeout(800);
        }
      } catch {
        // continue other rows
      }
    }
    return opened;
  }

  /**
   * Listen for XHR/fetch JSON that looks like enrolled courses (code + title).
   */
  private startCourseNetworkHarvest(
    page: Page,
    pushCourse: (c: LmsCourse) => void,
  ): () => void {
    const handler = async (res: Response) => {
      try {
        if (!res.ok()) return;
        const url = res.url();
        if (!/course|regist|academic|enroll/i.test(url)) return;
        const ct = res.headers()['content-type'] || '';
        if (ct && !/json|javascript|text\/plain/i.test(ct)) return;
        const data = await res.json().catch(() => null);
        if (!data) return;
        for (const c of this.coursesFromUnknownJson(data)) pushCourse(c);
      } catch {
        // ignore
      }
    };
    page.on('response', handler);
    return () => page.off('response', handler);
  }

  private coursesFromUnknownJson(data: unknown): LmsCourse[] {
    const out: LmsCourse[] = [];
    const visit = (node: unknown, depth: number) => {
      if (depth > 6 || node == null) return;
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      if (typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      const codeRaw =
        obj.courseCode ?? obj.CourseCode ?? obj.code ?? obj.Code ?? obj.course_code;
      const titleRaw =
        obj.courseTitle ??
        obj.CourseTitle ??
        obj.title ??
        obj.Title ??
        obj.courseName ??
        obj.CourseName ??
        obj.name;
      const code = typeof codeRaw === 'string' ? codeRaw.trim() : undefined;
      const title = typeof titleRaw === 'string' ? titleRaw.trim() : undefined;
      if (title && (code || title.length > 5)) {
        out.push({
          externalId: code ? `course:${code}` : `course:${title.slice(0, 40)}`,
          title,
          code,
        });
      }
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') visit(v, depth + 1);
      }
    };
    visit(data, 0);
    return out;
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
