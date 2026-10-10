import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideAction } from './decide';
import { executeAction } from './executor';
import { PASSWORD_PLACEHOLDER, type ComputerSurface, type ElementSnapshot } from './types';

const portal = 'https://portal.example.edu/login';

function ctx(overrides: Partial<Parameters<typeof decideAction>[1]> = {}) {
  return {
    portalUrl: portal,
    currentUrl: portal,
    viewport: { width: 1000, height: 1000 },
    password: 's3cret-portal-pass',
    allowTyping: true,
    passwordVisible: true,
    element: null as ElementSnapshot | null,
    ...overrides,
  };
}

describe('action executor', () => {
  it('denormalizes clicks and types the local password instead of the placeholder', async () => {
    const typed: string[] = [];
    const clicks: Array<{ x: number; y: number }> = [];
    const surface = fakeSurface({ typed, clicks });
    const typeResult = await executeAction(
      { id: '1', name: 'type', arguments: { text: PASSWORD_PLACEHOLDER, intent: 'Type the password placeholder' } },
      surface,
      { portalUrl: portal, password: 's3cret-portal-pass', allowTyping: true, passwordVisible: true },
    );
    assert.equal(typeResult.plan.kind, 'execute');
    assert.deepEqual(typed, ['s3cret-portal-pass']);

    const click = await executeAction(
      { id: '2', name: 'click', arguments: { x: 500, y: 250, intent: 'Click Sign in' } },
      surface,
      { portalUrl: portal, password: 's3cret-portal-pass', allowTyping: true, passwordVisible: true },
    );
    assert.equal(click.plan.kind, 'execute');
    assert.deepEqual(clicks, [{ x: 500, y: 250 }]);
  });

  it('refuses pay, course registration, delete, and non-login submit', () => {
    const pay = decideAction(
      { id: '1', name: 'click', arguments: { x: 1, y: 1, intent: 'Click Pay fees' } },
      ctx({ element: { text: 'Pay fees', ariaLabel: '', href: '/pay', tag: 'a', inputType: '', role: '' } }),
    );
    assert.equal(pay.kind, 'refuse');

    const register = decideAction(
      { id: '2', name: 'click', arguments: { x: 1, y: 1, intent: 'Register courses' } },
      ctx({ element: { text: 'Register courses', ariaLabel: '', href: '', tag: 'button', inputType: 'submit', role: '' } }),
    );
    assert.equal(register.kind, 'refuse');

    const del = decideAction(
      { id: '3', name: 'click', arguments: { x: 1, y: 1, intent: 'Delete' } },
      ctx({ element: { text: 'Delete', ariaLabel: '', href: '', tag: 'button', inputType: '', role: '' } }),
    );
    assert.equal(del.kind, 'refuse');

    const submit = decideAction(
      { id: '4', name: 'click', arguments: { x: 1, y: 1, intent: 'Submit assignment' } },
      ctx({ element: { text: 'Submit', ariaLabel: '', href: '', tag: 'button', inputType: 'submit', role: '' } }),
    );
    assert.equal(submit.kind, 'refuse');

    const enter = decideAction(
      { id: '6', name: 'press_key', arguments: { key: 'Enter', intent: 'Submit the form' } },
      ctx({ passwordVisible: false, allowTyping: true }),
    );
    assert.equal(enter.kind, 'refuse');

    const login = decideAction(
      { id: '5', name: 'click', arguments: { x: 10, y: 10, intent: 'Click Sign in' } },
      ctx({ element: { text: 'Sign in', ariaLabel: '', href: '', tag: 'button', inputType: 'submit', role: '' } }),
    );
    assert.equal(login.kind, 'execute');
  });

  it('pauses on captcha and OTP instead of solving them, and refuses navigation off the portal domain', () => {
    const captcha = decideAction(
      { id: '1', name: 'click', arguments: { x: 1, y: 1, intent: 'Solve the CAPTCHA' } },
      ctx(),
    );
    assert.equal(captcha.kind, 'pause');
    if (captcha.kind === 'pause') assert.equal(captcha.challengeKind, 'captcha');

    const otp = decideAction(
      { id: '2', name: 'type', arguments: { text: '123456', intent: 'Enter the OTP' } },
      ctx(),
    );
    assert.equal(otp.kind, 'pause');
    if (otp.kind === 'pause') assert.equal(otp.challengeKind, 'otp');

    const nav = decideAction(
      { id: '3', name: 'navigate', arguments: { url: 'https://payments.example.com/checkout', intent: 'Open checkout' } },
      ctx(),
    );
    assert.equal(nav.kind, 'refuse');
  });

  it('types a stored challenge answer in place of the placeholder', () => {
    const typed = decideAction(
      { id: '1', name: 'type', arguments: { text: '{{CR_CHALLENGE_ANSWER}}', intent: 'Type the code field' } },
      ctx({ challengeAnswer: '482913' }),
    );
    assert.equal(typed.kind, 'execute');
    if (typed.kind === 'execute' && typed.action.kind === 'type') {
      assert.equal(typed.action.text, '482913');
    }
    const echoed = decideAction(
      { id: '2', name: 'type', arguments: { text: '482913', intent: 'Type the code' } },
      ctx({ challengeAnswer: '482913', element: null }),
    );
    assert.equal(echoed.kind, 'refuse');
  });

  it('refuses a model that echoes the raw password', () => {
    const refused = decideAction(
      { id: '1', name: 'type', arguments: { text: 's3cret-portal-pass', intent: 'Type password' } },
      ctx(),
    );
    assert.equal(refused.kind, 'refuse');
  });
});

function fakeSurface(sink: { typed: string[]; clicks: Array<{ x: number; y: number }> }): ComputerSurface {
  return {
    viewport: () => ({ width: 1000, height: 1000 }),
    url: () => portal,
    screenshot: async () => Buffer.from('png'),
    htmlExcerpt: async () => '<form></form>',
    elementAt: async () => ({ text: 'Sign in', ariaLabel: '', href: '', tag: 'button', inputType: 'submit', role: '' }),
    passwordFieldVisible: async () => true,
    loginFormVisible: async () => true,
    challengeVisible: async () => null,
    click: async (x, y) => {
      sink.clicks.push({ x, y });
    },
    move: async () => undefined,
    typeText: async (text) => {
      sink.typed.push(text);
    },
    scroll: async () => undefined,
    navigate: async () => undefined,
    goBack: async () => undefined,
    goForward: async () => undefined,
    wait: async () => undefined,
    pressKey: async () => undefined,
  };
}
