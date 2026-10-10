import type { ComputerSurface } from './types';
import { DEFAULT_VIEWPORT } from './types';
import { pageChallenge } from './safety';

/**
 * Structural slice of a Playwright page. The package depends on playwright-core
 * types only through this adapter so unit tests can fake the surface.
 */
export interface PlaywrightLikePage {
  url(): string;
  viewportSize(): { width: number; height: number } | null;
  screenshot(options?: { type?: 'png' }): Promise<Buffer>;
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
  return {
    viewport: () => page.viewportSize() ?? DEFAULT_VIEWPORT,
    url: () => page.url(),
    screenshot: () => screenshotMasked(page),
    htmlExcerpt: async (maxChars) => (await page.content()).slice(0, maxChars),
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
      const html = await page.content();
      return pageChallenge(`${text}\n${html.slice(0, 4000)}`);
    },
    click: async (x, y, button = 'left', clickCount = 1) => {
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

async function screenshotMasked(page: PlaywrightLikePage): Promise<Buffer> {
  await page.evaluate(() => {
    document.querySelectorAll('[data-cr-password-mask]').forEach((node) => node.remove());
    document.querySelectorAll('input[type="password"]').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const mask = document.createElement('div');
      mask.setAttribute('data-cr-password-mask', '1');
      mask.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:#111;z-index:2147483647;pointer-events:none;`;
      document.documentElement.appendChild(mask);
    });
  }).catch(() => undefined);
  try {
    return await page.screenshot({ type: 'png' });
  } finally {
    await page.evaluate(() => {
      document.querySelectorAll('[data-cr-password-mask]').forEach((node) => node.remove());
    }).catch(() => undefined);
  }
}

