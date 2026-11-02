import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateFunnel,
  classifyFunnelError,
  funnelReasonForLoginReason,
  funnelStepForStage,
  isClientFunnelEvent,
  isTestSchoolName,
  sanitizeFunnelMessage,
  sanitizeFunnelMetadata,
} from '@cr-agentic/shared';
import { funnelEventForTransition } from '@cr-agentic/database';
import { funnelStepForRoute } from './funnel-error.interceptor';

test('stage -> step covers the happy path and not failure stages', () => {
  assert.equal(funnelStepForStage('UNIVERSITY_SELECTED'), 'school_picked');
  assert.equal(funnelStepForStage('PORTAL_CONFIRMED'), 'portal_accepted');
  assert.equal(funnelStepForStage('LOGIN_IN_PROGRESS'), 'credentials_submitted');
  assert.equal(funnelStepForStage('ONBOARDING_COMPLETE'), 'completed');
  assert.equal(funnelStepForStage('REAUTH_REQUIRED'), null);
  assert.equal(funnelStepForStage('CANCELLED'), null);
});

test('login reasons map to structured funnel reasons', () => {
  assert.equal(funnelReasonForLoginReason('invalid_credentials'), 'login_rejected');
  assert.equal(funnelReasonForLoginReason('captcha_required'), 'captcha_required');
  assert.equal(funnelReasonForLoginReason('mfa_required'), 'otp_required');
  assert.equal(funnelReasonForLoginReason('login_form_not_found'), 'page_structure_changed');
  assert.equal(funnelReasonForLoginReason('portal_unreachable', 'page.goto: Timeout 60000ms exceeded'), 'timeout');
  assert.equal(funnelReasonForLoginReason('portal_unreachable', 'net::ERR_CONNECTION_RESET'), 'portal_unreachable');
  assert.equal(
    funnelReasonForLoginReason('credential_login_error', 'locator.fill: waiting for locator("#password")'),
    'page_structure_changed',
  );
  assert.equal(funnelReasonForLoginReason('something_new'), 'unknown');
});

test('classifyFunnelError keeps the real class + status and picks a reason', () => {
  class BadGatewayException extends Error {
    getStatus() {
      return 502;
    }
  }
  const c = classifyFunnelError(new BadGatewayException('upstream exploded'));
  assert.equal(c.errorClass, 'BadGatewayException');
  assert.equal(c.httpStatus, 502);
  assert.equal(c.reason, 'server_error');
  const t = classifyFunnelError({ name: 'TimeoutError', message: 'Navigation timeout of 60000 ms exceeded' });
  assert.equal(t.errorClass, 'TimeoutError');
  assert.equal(t.reason, 'timeout');
  assert.equal(classifyFunnelError({ message: 'Too many', status: 429 }).reason, 'rate_limited');
  assert.equal(classifyFunnelError({ message: 'Please solve the reCAPTCHA' }).reason, 'captcha_required');
  assert.equal(classifyFunnelError({ message: 'Enter the OTP sent to your phone' }).reason, 'otp_required');
});

test('sanitizeFunnelMessage strips credentials, OTPs, emails, matric numbers, tokens, queries', () => {
  const raw =
    'login failed for student@unilag.edu.ng password=Hunter2! otp: 482913 matric 190404051 ' +
    'Bearer abc.def.ghi https://portal.unilag.edu.ng/login?user=190404051&pwd=x ' +
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig';
  const s = sanitizeFunnelMessage(raw);
  for (const bad of ['Hunter2', '482913', '190404051', 'student@', 'abc.def.ghi', 'pwd=x', 'eyJhbGci']) {
    assert.ok(!s.includes(bad), `leaked ${bad}: ${s}`);
  }
  assert.ok(s.includes('portal.unilag.edu.ng/login'));
  assert.ok(sanitizeFunnelMessage('x'.repeat(1000)).length <= 300);
});

test('sanitizeFunnelMetadata drops secret-looking keys and non-primitives', () => {
  const m = sanitizeFunnelMetadata({
    password: 'p',
    otpCode: '1234',
    username: 'u',
    portalHost: 'portal.example.edu',
    attempt: 2,
    nested: { a: 1 },
    'bad key': 'x',
  });
  assert.deepEqual(m, { portalHost: 'portal.example.edu', attempt: 2 });
});

test('client events are allow-listed', () => {
  assert.ok(isClientFunnelEvent('start_failed'));
  assert.ok(isClientFunnelEvent('credentials_submitted'));
  assert.ok(!isClientFunnelEvent('password_typed'));
});

test('test/demo school names are excluded', () => {
  assert.ok(isTestSchoolName('buchi@courserep.ng'));
  assert.ok(isTestSchoolName('Course Rep Demo University'));
  assert.ok(isTestSchoolName('ZZ Diagnostic Test (delete me)'));
  assert.ok(!isTestSchoolName('University of Lagos'));
});

test('transition events: cancel keeps step, failure maps reason, success is a step', () => {
  const c = funnelEventForTransition('s1', 'PORTAL_SUGGESTED', 'CANCELLED', { clientReason: 'cancel_button' }, 'server');
  assert.equal(c.event, 'cancelled');
  assert.equal(c.step, 'portal_suggested');
  assert.equal(c.reason, 'user_cancelled');
  const f = funnelEventForTransition(
    's1',
    'LOGIN_IN_PROGRESS',
    'REAUTH_REQUIRED',
    { reason: 'invalid_credentials', portalHost: 'p.edu' },
    'browser_worker',
  );
  assert.equal(f.event, 'failed');
  assert.equal(f.reason, 'login_rejected');
  assert.equal(f.step, 'credentials_submitted');
  const e = funnelEventForTransition(
    's1',
    'LOGIN_IN_PROGRESS',
    'REAUTH_REQUIRED',
    { reason: 'credential_login_error', errorClass: 'TimeoutError', message: 'page.goto: Timeout 60000ms' },
    'browser_worker',
  );
  assert.equal(e.errorClass, 'TimeoutError');
  assert.equal(e.reason, 'timeout');
  const ok = funnelEventForTransition('s1', 'PORTAL_SUGGESTED', 'PORTAL_CONFIRMED', undefined, 'server');
  assert.deepEqual([ok.event, ok.step, ok.fromStep], ['step', 'portal_accepted', 'portal_suggested']);
});

test('route -> step for request errors', () => {
  assert.equal(funnelStepForRoute('/api/onboarding/x/login/credentials'), 'credentials_submitted');
  assert.equal(funnelStepForRoute('/onboarding/x/confirm-portal-manual'), 'portal_accepted');
  assert.equal(funnelStepForRoute('/onboarding/x/sync-to-course-rep'), 'importing');
  assert.equal(funnelStepForRoute('/onboarding/x'), null);
});

test('aggregateFunnel: per school/day counts, reached is cumulative, reasons per session', () => {
  const rows = aggregateFunnel([
    { sessionId: 'a', school: 'University of Lagos', day: '2026-11-01', furthestStep: 'completed', completed: true, reasons: [] },
    { sessionId: 'b', school: 'university of lagos', day: '2026-11-01', furthestStep: 'credentials_submitted', completed: false, reasons: ['login_rejected', 'login_rejected'] },
    { sessionId: 'c', school: 'University of Lagos', day: '2026-11-01', furthestStep: 'portal_suggested', completed: false, reasons: ['user_cancelled'], cancelledAtStep: 'portal_suggested' },
    { sessionId: 'd', school: 'COOU', day: '2026-11-02', furthestStep: 'school_picked', completed: false, reasons: [] },
  ]);
  const unilag = rows.find((r) => r.school === 'University of Lagos')!;
  assert.equal(unilag.started, 3);
  assert.equal(unilag.reached.portal_suggested, 3);
  assert.equal(unilag.reached.credentials_submitted, 2);
  assert.equal(unilag.completed, 1);
  assert.equal(unilag.successRate, 0.333);
  assert.equal(unilag.cancelled, 1);
  assert.deepEqual(unilag.cancelledAtStep, { portal_suggested: 1 });
  assert.deepEqual(unilag.topFailureReasons, [
    { reason: 'login_rejected', sessions: 1 },
    { reason: 'user_cancelled', sessions: 1 },
  ]);
  assert.equal(rows[0].day, '2026-11-02');
  const all = aggregateFunnel(rows.length ? [{ sessionId: 'x', school: 'A', day: 'd1', furthestStep: null, completed: false, reasons: [] }] : [], { byDay: false });
  assert.equal(all[0].reached.school_picked, 0);
});
