import { createHash } from 'crypto';
import type { Frame, Page } from 'playwright';
import { createLogger } from '@cr-agentic/observability';
import type { LlmCompletionClient } from '@cr-agentic/portal-discovery';

const logger = createLogger('deep-scrape-processor');

export type AgentGoalName = 'courses' | 'assignments' | 'timetable';

export interface AgentElement {
  index: number;
  tag: string;
  kind: 'link' | 'button' | 'select' | 'submit' | 'clickable';
  label: string;
  href?: string;
  options?: Array<{ value: string; label: string; selected: boolean }>;
  hidden: boolean;
  frameIndex: number;
}

export interface PageObservation {
  url: string;
  title: string;
  text: string;
  tables: string[];
  elements: AgentElement[];
  hasPasswordField: boolean;
  /** Visible checkboxes; many unchecked ones usually mean a selection/registration form. */
  checkboxCount: number;
  checkedCount: number;
}

export interface ExtractOutcome<T> {
  items: T[];
  accepted: boolean;
  reason?: string;
  /** The extractor itself failed (e.g. model error); don't blacklist the page. */
  retryable?: boolean;
}

export interface AgentGoal<T> {
  name: AgentGoalName;
  description: string;
  maxSteps: number;
  timeBudgetMs: number;
  extract(observation: PageObservation): Promise<ExtractOutcome<T>>;
}

export type LearnedStep =
  | { action: 'goto'; url: string }
  | { action: 'back' }
  | { action: 'click'; tag: string; label: string; href?: string }
  | { action: 'select'; label: string; value: string };

export interface LearnedPath {
  finalUrl: string;
  steps: LearnedStep[];
  updatedAt: string;
}

export interface TraceEntry {
  step: number;
  url: string;
  action: string;
  target?: string;
  reason?: string;
  result?: string;
}

export interface AgentRunResult<T> {
  items: T[];
  via: 'learned' | 'agent' | 'none';
  learned?: LearnedPath;
  trace: TraceEntry[];
  durationMs: number;
}

type Decision = {
  action: 'click' | 'select' | 'goto' | 'back' | 'extract' | 'give_up';
  index?: number;
  value?: string;
  url?: string;
  reason: string;
};

type ActResult = {
  ok: boolean;
  error?: string;
  urlChanged?: boolean;
  learned?: LearnedStep;
  target?: AgentElement;
};

type HistoryEntry = { action: string; target?: string; result: string };

const LLM_TIMEOUT_MS = 45_000;
const MAX_ELEMENT_LINES = 150;

/**
 * Runs inside each frame. Tags interactive elements with data-cr-idx so the
 * agent can target them later, and drops anything that could log out, pay,
 * or change data (e.g. forms with checkboxes, which are how portals register
 * courses).
 */
const OBSERVE_SCRIPT = String.raw`(start) => {
  const DANGER = /\b(log\s*-?\s*out|sign\s*-?\s*out|log\s*off|pay|payment|payments|remita|checkout|fees?|delete|remove|drop|withdraw|deactivate|password|apply|register\s+now|save|confirm|upload|add\s+course|add\/drop)\b/i;
  const READONLY = /\b(view|print|show|search|filter|go|load|display|fetch|check|preview|continue|proceed|ok|submit|get|open)\b/i;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const parts = location.hostname.split('.');
  const root = parts.length >= 3 && parts[parts.length - 2].length <= 3
    ? parts.slice(-3).join('.')
    : parts.slice(-2).join('.');
  const sameSite = (href) => {
    try {
      const u = new URL(href, location.href);
      if (u.protocol === 'javascript:') return true;
      if (!/^https?:$/.test(u.protocol)) return false;
      return u.hostname === root || u.hostname.endsWith('.' + root);
    } catch (e) {
      return false;
    }
  };
  const isHidden = (el) => !(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const labelFor = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      let l = '';
      if (el.id) {
        const lab = document.querySelector('label[for="' + el.id + '"]');
        if (lab) l = clean(lab.innerText);
      }
      return clean(l || el.getAttribute('aria-label') || el.name || el.id || 'select');
    }
    if (tag === 'input') return clean(el.value || el.getAttribute('aria-label') || el.name || el.alt || '');
    let t = clean(el.innerText || el.textContent || '');
    if (!t) t = clean(el.getAttribute('aria-label') || el.getAttribute('title') || '');
    if (!t) {
      const img = el.querySelector('img[alt]');
      if (img) t = clean(img.getAttribute('alt'));
    }
    return t;
  };

  document.querySelectorAll('[data-cr-idx]').forEach((el) => el.removeAttribute('data-cr-idx'));
  const out = [];
  const seen = new Set();
  let idx = start;
  const nodes = Array.from(document.querySelectorAll(
    'a[href], button, input[type=submit], input[type=button], input[type=image], select, [onclick], [role=button], [role=menuitem], [role=tab], [role=link], summary'
  ));
  for (const el of nodes) {
    if (out.length >= 120) break;
    const tag = el.tagName.toLowerCase();
    const label = labelFor(el).slice(0, 80);
    const rawHref = tag === 'a' ? (el.getAttribute('href') || '') : '';
    const href = tag === 'a' ? el.href : '';
    if (/^(mailto|tel):/i.test(rawHref)) continue;
    if (tag === 'a' && rawHref && rawHref !== '#' && !sameSite(href)) continue;
    if (!label && tag !== 'select') continue;
    if (DANGER.test(label)) continue;
    if (href && DANGER.test(href.replace(location.origin, ''))) continue;

    let kind = 'clickable';
    if (tag === 'a') kind = 'link';
    else if (tag === 'select') kind = 'select';
    else if (
      (tag === 'button' && (el.getAttribute('type') || 'submit') === 'submit' && el.form) ||
      (tag === 'input' && (el.type === 'submit' || el.type === 'image'))
    ) kind = 'submit';
    else if (tag === 'button' || tag === 'input') kind = 'button';

    if (kind === 'submit') {
      if (!READONLY.test(label)) continue;
      const form = el.form;
      if (form && form.querySelector('input[type=password], input[type=file], input[type=checkbox], textarea')) continue;
    }

    const key = tag + '|' + label.toLowerCase() + '|' + href;
    if (seen.has(key)) continue;
    seen.add(key);

    const item = { index: idx, tag, kind, label, hidden: isHidden(el) };
    if (href && rawHref && !rawHref.startsWith('#')) item.href = href.slice(0, 200);
    if (tag === 'select') {
      item.options = Array.from(el.options).slice(0, 25).map((o) => ({
        value: o.value,
        label: clean(o.text).slice(0, 60),
        selected: o.selected,
      }));
    }
    el.setAttribute('data-cr-idx', String(idx));
    out.push(item);
    idx++;
  }

  const tables = [];
  for (const t of Array.from(document.querySelectorAll('table'))) {
    if (tables.length >= 8) break;
    if (t.querySelector('table')) continue;
    const rows = Array.from(t.rows)
      .slice(0, 80)
      .map((r) => Array.from(r.cells).map((c) => clean(c.innerText)).join('\t'))
      .filter((r) => r.replace(/\t/g, '').length > 0);
    if (rows.length < 2) continue;
    tables.push(rows.join('\n').slice(0, 4000));
  }

  const text = (document.body ? document.body.innerText : '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, 6000);
  const hasPasswordField = Array.from(document.querySelectorAll('input[type=password]')).some((el) => !isHidden(el));
  const boxes = Array.from(document.querySelectorAll('input[type=checkbox]')).filter((el) => !isHidden(el));
  const checkedCount = boxes.filter((el) => el.checked).length;
  return {
    title: document.title || '',
    text,
    tables,
    elements: out,
    hasPasswordField,
    checkboxCount: boxes.length,
    checkedCount,
  };
}`;

const DECIDE_PROMPT = [
  "You are an autonomous browsing agent inside a student's logged-in school portal.",
  'Each turn you see the current page: URL, title, data tables (TSV), a visible-text excerpt,',
  'and a numbered list of interactive elements. Choose exactly ONE next action to reach the goal.',
  '',
  'Actions:',
  '- extract: the current page already shows the goal data (in tables or text).',
  '- click {index}: open a link, menu item, tab or button. Hidden elements live in collapsed menus; clicking them is fine.',
  '- select {index, value}: choose an option (by its label) in a dropdown, e.g. the current session or semester. Usually followed by clicking a View/Submit button.',
  '- goto {url}: visit a URL on the same portal that you saw referenced.',
  '- back: return to the previous page.',
  '- give_up: the portal clearly has no such data, or this is a login page / the session has expired.',
  '',
  'Rules:',
  '- Never try to log in or enter credentials. Never pick payment, fees, logout, hostel, or anything that changes data.',
  '- For session/semester dropdowns pick the most recent / current one.',
  '- Pages for registering / adding courses (checkbox lists of offered courses) show what can be registered, not what the student registered.',
  '  Prefer "Print Course Form", "View Course Form", "Registered Courses", "Course Form" or "My Courses".',
  '- Do not repeat an action that already failed or had no effect (see history).',
  '- Only choose extract when the goal data is actually visible; a dashboard summary is not enough.',
  '',
  'Return STRICT JSON: {"action": "click|select|goto|back|extract|give_up", "index": number|null, "value": string|null, "url": string|null, "reason": string (max 20 words)}.',
].join('\n');

/**
 * Portal-agnostic browsing agent: observes the page, asks the navigation LLM
 * for the next action, and executes it with Playwright until the goal's
 * extractor accepts what it sees.
 */
export class PortalAgent {
  private frames: Frame[] = [];

  constructor(
    private page: Page,
    private readonly navLlms: LlmCompletionClient[],
  ) {}

  get currentPage(): Page {
    return this.page;
  }

  async run<T>(goal: AgentGoal<T>, startUrl: string): Promise<AgentRunResult<T>> {
    const started = Date.now();
    const trace: TraceEntry[] = [];
    const history: HistoryEntry[] = [];
    const steps: LearnedStep[] = [];
    const rejected = new Set<string>();

    if (!(await this.goto(startUrl))) {
      return { items: [], via: 'none', trace, durationMs: Date.now() - started };
    }

    let lastObservation: PageObservation | null = null;
    let pending: PageObservation | null = null;
    const noEffect = new Map<string, number>();
    const blocked = new Set<string>();

    for (let step = 1; step <= goal.maxSteps; step++) {
      if (Date.now() - started > goal.timeBudgetMs) break;

      const observed = pending ?? (await this.observe());
      pending = null;
      const obs: PageObservation = {
        ...observed,
        elements: observed.elements.filter((e) => !blocked.has(elementKey(e))),
      };
      lastObservation = obs;
      const decision = await this.decide(goal, obs, history, step);
      const target = decision.index !== undefined
        ? obs.elements.find((e) => e.index === decision.index)
        : undefined;

      if (decision.action === 'give_up') {
        this.record(goal.name, trace, step, obs.url, decision, target, 'give_up');
        break;
      }

      if (decision.action === 'extract') {
        const fp = fingerprint(obs);
        if (rejected.has(fp)) {
          history.push({ action: 'extract', result: 'already rejected on this page; navigate elsewhere' });
          this.record(goal.name, trace, step, obs.url, decision, target, 'repeat_rejected');
          continue;
        }
        const outcome = await goal.extract(obs);
        if (outcome.accepted) {
          this.record(goal.name, trace, step, obs.url, decision, target, `accepted:${outcome.items.length}`);
          return {
            items: outcome.items,
            via: 'agent',
            learned: { finalUrl: obs.url, steps, updatedAt: new Date().toISOString() },
            trace,
            durationMs: Date.now() - started,
          };
        }
        if (outcome.retryable) {
          history.push({ action: 'extract', result: 'extraction failed temporarily; you may try extract again' });
          this.record(goal.name, trace, step, obs.url, decision, target, 'extract_error');
          continue;
        }
        rejected.add(fp);
        history.push({ action: 'extract', result: `rejected: ${outcome.reason ?? 'not the goal data'}` });
        this.record(goal.name, trace, step, obs.url, decision, target, 'rejected');
        continue;
      }

      const res = await this.act(decision, obs, startUrl);
      pending = await this.observe().catch(() => null);
      // Choosing a dropdown option rarely changes page text but is still progress.
      const changed =
        (res.ok && decision.action === 'select') ||
        !pending ||
        fingerprint(pending) !== fingerprint(obs);
      const key = res.target ? elementKey(res.target) : `${decision.action}:${decision.url ?? ''}`;

      let result: string;
      if (!res.ok) {
        result = `failed: ${res.error ?? 'unknown'}`;
      } else if (changed) {
        result = res.urlChanged
          ? `ok, now at ${shortHref(this.page.url())}`
          : decision.action === 'select'
            ? `ok, selected "${decision.value ?? ''}"`
            : 'ok, page content changed';
      } else {
        const count = (noEffect.get(key) ?? 0) + 1;
        noEffect.set(key, count);
        if (count >= 2 && res.target) blocked.add(key);
        result = 'no visible effect; choose a different element or action';
      }
      history.push({ action: decision.action, target: res.target?.label ?? decision.url, result });
      this.record(
        goal.name,
        trace,
        step,
        obs.url,
        decision,
        res.target,
        !res.ok ? 'failed' : changed ? 'ok' : 'no_effect',
      );
      if (res.ok && changed && res.learned) steps.push(res.learned);
    }

    // Budget exhausted: give the last page one extraction attempt.
    const finalObs = await this.observe().catch(() => lastObservation);
    if (finalObs && !rejected.has(fingerprint(finalObs))) {
      const outcome = await goal.extract(finalObs);
      if (outcome.accepted) {
        return {
          items: outcome.items,
          via: 'agent',
          learned: { finalUrl: finalObs.url, steps, updatedAt: new Date().toISOString() },
          trace,
          durationMs: Date.now() - started,
        };
      }
    }

    return { items: [], via: 'none', trace, durationMs: Date.now() - started };
  }

  /** Replays a previously learned path. Returns null when the path no longer works. */
  async replay<T>(
    goal: AgentGoal<T>,
    learned: LearnedPath,
    startUrl: string,
  ): Promise<AgentRunResult<T> | null> {
    const started = Date.now();
    const trace: TraceEntry[] = [];

    if (await this.goto(learned.finalUrl)) {
      const outcome = await goal.extract(await this.observe());
      if (outcome.accepted) {
        trace.push({ step: 0, url: sanitizeUrl(learned.finalUrl), action: 'replay_direct', result: 'accepted' });
        return { items: outcome.items, via: 'learned', learned, trace, durationMs: Date.now() - started };
      }
    }

    if (learned.steps.length === 0 || !(await this.goto(startUrl))) return null;

    for (let i = 0; i < learned.steps.length; i++) {
      const step = learned.steps[i];
      let ok = false;
      if (step.action === 'goto') {
        ok = await this.goto(step.url);
      } else if (step.action === 'back') {
        ok = await this.page.goBack({ timeout: 15_000 }).then(() => true).catch(() => false);
        await this.settle();
      } else {
        const obs = await this.observe();
        const el = findLearnedTarget(obs, step);
        if (el) {
          const res = await this.act(
            step.action === 'select'
              ? { action: 'select', index: el.index, value: step.value, reason: 'replay' }
              : { action: 'click', index: el.index, reason: 'replay' },
            obs,
            startUrl,
          );
          ok = res.ok;
        }
      }
      trace.push({ step: i + 1, url: sanitizeUrl(this.page.url()), action: `replay_${step.action}`, result: ok ? 'ok' : 'failed' });
      if (!ok) return null;
    }

    const outcome = await goal.extract(await this.observe());
    if (!outcome.accepted) return null;
    return {
      items: outcome.items,
      via: 'learned',
      learned: { ...learned, finalUrl: this.page.url(), updatedAt: new Date().toISOString() },
      trace,
      durationMs: Date.now() - started,
    };
  }

  async observe(): Promise<PageObservation> {
    const frames = this.page.frames();
    const kept: Frame[] = [];
    const obs: PageObservation = {
      url: this.page.url(),
      title: '',
      text: '',
      tables: [],
      elements: [],
      hasPasswordField: false,
      checkboxCount: 0,
      checkedCount: 0,
    };

    let nextIndex = 0;
    for (const frame of frames) {
      const isMain = frame === this.page.mainFrame();
      if (!isMain && (!frame.url() || frame.url() === 'about:blank')) continue;
      try {
        const raw = (await frame.evaluate(`(${OBSERVE_SCRIPT})(${nextIndex})`)) as {
          title: string;
          text: string;
          tables: string[];
          elements: Array<Omit<AgentElement, 'frameIndex'>>;
          hasPasswordField: boolean;
          checkboxCount: number;
          checkedCount: number;
        };
        const frameIndex = kept.length;
        kept.push(frame);
        if (isMain) obs.title = raw.title;
        obs.text += (isMain ? '' : `\n[frame ${frameIndex}]\n`) + raw.text;
        obs.tables.push(...raw.tables);
        obs.hasPasswordField = obs.hasPasswordField || raw.hasPasswordField;
        obs.checkboxCount += raw.checkboxCount ?? 0;
        obs.checkedCount += raw.checkedCount ?? 0;
        for (const el of raw.elements) {
          obs.elements.push({ ...el, frameIndex });
          nextIndex = Math.max(nextIndex, el.index + 1);
        }
      } catch {
        continue;
      }
    }
    this.frames = kept;
    return obs;
  }

  private async decide<T>(
    goal: AgentGoal<T>,
    obs: PageObservation,
    history: HistoryEntry[],
    step: number,
  ): Promise<Decision> {
    const payload = {
      goal: goal.description,
      step,
      maxSteps: goal.maxSteps,
      history: history.slice(-8),
      page: {
        url: obs.url,
        title: obs.title,
        looksLikeLoginPage: obs.hasPasswordField,
        checkboxes: obs.checkboxCount > 0 ? `${obs.checkedCount}/${obs.checkboxCount} checked` : 'none',
        tables: obs.tables.join('\n---\n').slice(0, 5000),
        text: obs.text.slice(0, 3000),
        elements: obs.elements.slice(0, MAX_ELEMENT_LINES).map(describeElement).join('\n'),
      },
    };
    const user = JSON.stringify(payload);

    for (const llm of this.navLlms) {
      try {
        const raw = await withTimeout(llm.completeJson(DECIDE_PROMPT, user), LLM_TIMEOUT_MS);
        return parseDecision(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        logger.warn(
          { goal: goal.name, step, err: err instanceof Error ? err.message : String(err) },
          'Portal agent decision failed',
        );
      }
    }
    return { action: 'give_up', reason: 'navigation model unavailable' };
  }

  private async act(decision: Decision, obs: PageObservation, startUrl: string): Promise<ActResult> {
    const before = this.page.url();

    if (decision.action === 'back') {
      const ok = await this.page.goBack({ timeout: 15_000 }).then(() => true).catch(() => false);
      await this.settle();
      return { ok, urlChanged: this.page.url() !== before, learned: ok ? { action: 'back' } : undefined };
    }

    if (decision.action === 'goto') {
      const url = decision.url ? safeResolve(decision.url, before) : null;
      if (!url || !isSameSite(url, startUrl)) {
        return { ok: false, error: 'goto target is not on this portal' };
      }
      const ok = await this.goto(url);
      return { ok, urlChanged: this.page.url() !== before, learned: ok ? { action: 'goto', url } : undefined };
    }

    const el = obs.elements.find((e) => e.index === decision.index);
    if (!el) return { ok: false, error: `no element with index ${decision.index}` };
    const frame = this.frames[el.frameIndex];
    if (!frame) return { ok: false, error: 'element frame is gone', target: el };
    const locator = frame.locator(`[data-cr-idx="${el.index}"]`).first();

    if (decision.action === 'select') {
      if (el.kind !== 'select') return { ok: false, error: 'element is not a dropdown', target: el };
      const wanted = (decision.value ?? '').trim();
      const option =
        el.options?.find((o) => o.label.toLowerCase() === wanted.toLowerCase()) ??
        el.options?.find((o) => o.value === wanted) ??
        el.options?.find((o) => wanted && o.label.toLowerCase().includes(wanted.toLowerCase()));
      if (!option) return { ok: false, error: `option "${wanted}" not found`, target: el };
      try {
        await locator.selectOption(option.value, { timeout: 5_000 });
      } catch (err) {
        return { ok: false, error: errMessage(err), target: el };
      }
      await this.settle();
      return {
        ok: true,
        urlChanged: this.page.url() !== before,
        learned: { action: 'select', label: el.label, value: option.label },
        target: el,
      };
    }

    // click
    const learned: LearnedStep = { action: 'click', tag: el.tag, label: el.label, href: el.href };
    const directHref =
      el.href && /^https?:/i.test(el.href) && isSameSite(el.href, startUrl) ? el.href : undefined;

    // Collapsed-menu links can't be clicked without hover; open them directly.
    if (el.hidden && directHref) {
      const ok = await this.goto(directHref);
      return ok
        ? { ok, urlChanged: this.page.url() !== before, learned, target: el }
        : { ok, error: 'navigation failed', target: el };
    }

    const ctx = this.page.context();
    const popup: { page: Page | null } = { page: null };
    const onPage = (p: Page) => {
      popup.page = p;
    };
    ctx.on('page', onPage);
    try {
      try {
        await locator.click({ timeout: 5_000 });
      } catch {
        try {
          await frame.evaluate(
            `(() => { const el = document.querySelector('[data-cr-idx="${el.index}"]'); ` +
              `if (!el) throw new Error('element is gone'); el.click(); })()`,
          );
        } catch (err) {
          const navigated = /context was destroyed|navigat/i.test(errMessage(err));
          if (!navigated) {
            if (!directHref || !(await this.goto(directHref))) {
              return { ok: false, error: errMessage(err), target: el };
            }
          }
        }
      }
      await this.settle();
    } finally {
      ctx.off('page', onPage);
    }

    if (popup.page) {
      await popup.page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
      this.page = popup.page;
      await this.settle();
    } else if (directHref && this.page.url() === before && directHref !== before) {
      // The click was swallowed (overlay, JS handler); follow the link itself.
      await this.goto(directHref);
    }

    return { ok: true, urlChanged: this.page.url() !== before, learned, target: el };
  }

  private async goto(url: string): Promise<boolean> {
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await this.settle();
      return true;
    } catch {
      return false;
    }
  }

  private async settle(): Promise<void> {
    await this.page.waitForTimeout(800).catch(() => undefined);
    await this.page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
    await this.page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  }

  private record(
    goal: AgentGoalName,
    trace: TraceEntry[],
    step: number,
    url: string,
    decision: Decision,
    target: AgentElement | undefined,
    result: string,
  ): void {
    const entry: TraceEntry = {
      step,
      url: sanitizeUrl(url),
      action: decision.action,
      target: target ? hashTarget(target) : undefined,
      reason: decision.reason.slice(0, 120),
      result,
    };
    trace.push(entry);
    logger.info({ goal, ...entry }, 'Portal agent step');
  }
}

function describeElement(e: AgentElement): string {
  let line = `${e.index} [${e.kind}${e.hidden ? ',hidden' : ''}] ${e.label}`;
  if (e.href) line += ` -> ${shortHref(e.href)}`;
  if (e.options?.length) {
    line += ' options: ' + e.options.map((o) => `${o.selected ? '*' : ''}${o.label}`).join(' | ');
  }
  return line;
}

function parseDecision(raw: Record<string, unknown>): Decision {
  const allowed = ['click', 'select', 'goto', 'back', 'extract', 'give_up'] as const;
  const action = String(raw.action ?? '').toLowerCase().replace(/[\s-]/g, '_');
  const index =
    typeof raw.index === 'number'
      ? raw.index
      : typeof raw.index === 'string' && /^\d+$/.test(raw.index)
        ? Number(raw.index)
        : undefined;
  return {
    action: (allowed as readonly string[]).includes(action) ? (action as Decision['action']) : 'give_up',
    index,
    value: typeof raw.value === 'string' ? raw.value : undefined,
    url: typeof raw.url === 'string' ? raw.url : undefined,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
  };
}

function findLearnedTarget(
  obs: PageObservation,
  step: Extract<LearnedStep, { action: 'click' | 'select' }>,
): AgentElement | undefined {
  const label = step.label.trim().toLowerCase();
  const pool = obs.elements.filter((e) =>
    step.action === 'select' ? e.kind === 'select' : e.tag === step.tag,
  );
  const exact = pool.find((e) => e.label.trim().toLowerCase() === label);
  if (exact) return exact;
  if (step.action === 'click' && step.href) {
    const target = shortHref(step.href);
    const byHref = pool.find((e) => e.href && shortHref(e.href) === target);
    if (byHref) return byHref;
  }
  return label ? pool.find((e) => e.label.toLowerCase().includes(label)) : undefined;
}

function elementKey(el: AgentElement): string {
  return `${el.kind}|${el.label.toLowerCase()}|${el.href ?? ''}`;
}

function fingerprint(obs: PageObservation): string {
  return createHash('sha1')
    .update(`${obs.url}|${obs.tables.length}|${obs.text.slice(0, 2000)}`)
    .digest('hex');
}

function hashTarget(el: AgentElement): string {
  return `${el.kind}:${createHash('sha1').update(`${el.tag}|${el.label}`).digest('hex').slice(0, 10)}`;
}

function shortHref(href: string): string {
  try {
    const u = new URL(href);
    return `${u.pathname}${u.search}`;
  } catch {
    return href;
  }
}

function hostRoot(hostname: string): string {
  const parts = hostname.split('.');
  return parts.length >= 3 && parts[parts.length - 2].length <= 3
    ? parts.slice(-3).join('.')
    : parts.slice(-2).join('.');
}

function isSameSite(url: string, base: string): boolean {
  try {
    const target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) return false;
    const root = hostRoot(new URL(base).hostname);
    return target.hostname === root || target.hostname.endsWith(`.${root}`);
  } catch {
    return false;
  }
}

function safeResolve(url: string, base: string): string | null {
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

/** Strips values that look like session tokens so URLs are safe to log. */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const [key, value] of Array.from(u.searchParams.entries())) {
      if (value.length > 24 || /^[A-Za-z0-9+/=_-]{16,}$/.test(value)) {
        u.searchParams.set(key, '***');
      }
    }
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return 'invalid-url';
  }
}

function errMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 160);
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
