import type { ComputerSurface, VisionChallengeKind } from './types';
import { DEFAULT_VIEWPORT } from './types';
import { pageChallenge } from './safety';

/**
 * Structural slice of a Playwright page. The package depends on playwright-core
 * types only through this adapter so unit tests can fake the surface.
 */
export interface PlaywrightLikePage {
  url(): string;
  viewportSize(): { width: number; height: number } | null;
  screenshot(options?: { type?: 'png'; clip?: { x: number; y: number; width: number; height: number } }): Promise<Buffer>;
  content(): Promise<string>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  evaluate<T, A = undefined>(pageFunction: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  mouse: {
    click(x: number, y: number, options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }): Promise<void>;
    dblclick(x: number, y: number): Promise<void>;
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  keyboard: {
    type(text: string): Promise<void>;
    press(key: string): Promise<void>;
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
  };
  goto(url: string, options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<unknown>;
  goBack(options?: { timeout?: number }): Promise<unknown>;
  goForward(options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
}

export async function playwrightSurface(page: PlaywrightLikePage): Promise<ComputerSurface> {
  const current = page.viewportSize();
  if (!current) {
    await page.setViewportSize(DEFAULT_VIEWPORT);
  }
  const secrets = new Set<string>();
  return {
    viewport: () => page.viewportSize() ?? DEFAULT_VIEWPORT,
    url: () => page.url(),
    screenshot: () => screenshotMasked(page, secrets),
    htmlExcerpt: async (maxChars) => {
      const text = await page.evaluate(() => document.body?.innerText ?? '');
      return text.slice(0, maxChars);
    },
    elementAt: (x, y) =>
      page.evaluate((point) => {
        const el = document.elementFromPoint(point.x, point.y) as HTMLElement | null;
        if (!el) return null;
        const target = (el.closest('a,button,input,label,[role="button"]') as HTMLElement | null) ?? el;
        return {
          text: (target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180),
          ariaLabel: target.getAttribute('aria-label') || '',
          href: target.getAttribute('href') || '',
          tag: target.tagName.toLowerCase(),
          inputType: (target as HTMLInputElement).type || '',
          role: target.getAttribute('role') || '',
        };
      }, { x, y }),
    passwordFieldVisible: () => page.evaluate(() => document.querySelectorAll('input[type="password"]').length > 0),
    loginFormVisible: () =>
      page.evaluate(() => {
        const password = document.querySelectorAll('input[type="password"]').length > 0;
        const user = document.querySelector(
          'input[type="email"], input[type="text"], input[name*="user" i], input[name*="matric" i], input[id*="user" i]',
        );
        return password && !!user;
      }),
    challengeVisible: async () => {
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? '');
      return pageChallenge(text);
    },
    cropChallenge: () => cropChallenge(page),
    focusChallenge: (kind) => focusChallenge(page, kind),
    noteSecret: (value) => {
      if (value) secrets.add(value);
    },
    click: async (x, y, button = 'left', clickCount = 1) => {
      await page.evaluate(() => {
        document.querySelectorAll('a[target], form[target]').forEach((el) => el.removeAttribute('target'));
      }).catch(() => undefined);
      if (clickCount === 2) {
        await page.mouse.dblclick(x, y);
        return;
      }
      await page.mouse.click(x, y, { button, clickCount });
    },
    move: (x, y) => page.mouse.move(x, y),
    typeText: async (text, pressEnter) => {
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(text);
      if (pressEnter) await page.keyboard.press('Enter');
    },
    scroll: async (x, y, direction, pixels) => {
      await page.mouse.move(x, y);
      const delta = direction === 'up' || direction === 'left' ? -pixels : pixels;
      if (direction === 'left' || direction === 'right') await page.mouse.wheel(delta, 0);
      else await page.mouse.wheel(0, delta);
    },
    navigate: async (url) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    },
    goBack: async () => {
      await page.goBack({ timeout: 15_000 });
    },
    goForward: async () => {
      await page.goForward({ timeout: 15_000 });
    },
    wait: (ms) => page.waitForTimeout(ms),
    pressKey: (key) => page.keyboard.press(key),
  };
}

async function screenshotMasked(page: PlaywrightLikePage, secrets: Set<string>): Promise<Buffer> {
  const secretList = [...secrets];
  await page.evaluate((hidden) => {
    document.querySelectorAll('[data-cr-password-mask]').forEach((node) => node.remove());
    const cover = (el: Element) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const mask = document.createElement('div');
      mask.setAttribute('data-cr-password-mask', '1');
      mask.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:#111;z-index:2147483647;pointer-events:none;`;
      document.documentElement.appendChild(mask);
    };
    document.querySelectorAll('input[type="password"]').forEach(cover);
    if (hidden.length > 0) {
      document.querySelectorAll('input, textarea').forEach((el) => {
        const value = (el as HTMLInputElement).value;
        if (value && hidden.some((secret) => value.includes(secret))) cover(el);
      });
    }
  }, secretList).catch(() => undefined);
  try {
    return await page.screenshot({ type: 'png' });
  } finally {
    await page.evaluate(() => {
      document.querySelectorAll('[data-cr-password-mask]').forEach((node) => node.remove());
    }).catch(() => undefined);
  }
}

async function cropChallenge(page: PlaywrightLikePage): Promise<Buffer | null> {
  const box = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(
      'img, canvas, [class*="captcha" i], [id*="captcha" i], input[autocomplete="one-time-code"]',
    ));
    const el = nodes.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 8 && rect.height > 8;
    });
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }).catch(() => null);
  if (!box) return null;
  const pad = 8;
  return page.screenshot({
    type: 'png',
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.max(1, box.width + pad * 2),
      height: Math.max(1, box.height + pad * 2),
    },
  });
}

async function focusChallenge(page: PlaywrightLikePage, kind: VisionChallengeKind): Promise<boolean> {
  const selector = kind === 'captcha'
    ? 'input[name*="captcha" i], input[id*="captcha" i], input[placeholder*="captcha" i], input[aria-label*="captcha" i]'
    : kind === 'otp'
      ? 'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="code" i], input[id*="code" i]'
      : kind === 'security_question'
        ? 'input[name*="answer" i], input[id*="answer" i], textarea'
        : 'input[type="text"], input:not([type="hidden"]):not([type="password"])';
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    el.focus();
    el.click();
    return true;
  }, selector).catch(() => false);
}

