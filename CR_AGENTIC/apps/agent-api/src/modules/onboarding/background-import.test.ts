import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKGROUND_IMPORT_STALL_MS,
  buildBackgroundImportPush,
  decideBackgroundOutcome,
  readBackgroundImportState,
  sessionCanReceivePush,
  type BackgroundImportSnapshot,
} from './background-import';

const now = new Date('2026-10-17T09:00:00Z');
const base: BackgroundImportSnapshot = {
  stage: 'DEEP_DISCOVERY',
  discoveryStatus: 'IN_PROGRESS',
  courseCount: 0,
  requestedAt: new Date(now.getTime() - 60_000),
  expiresAt: new Date(now.getTime() + 3_600_000),
  now,
};

test('still scanning: nothing to tell', () => {
  assert.equal(decideBackgroundOutcome(base), null);
});

test('scan complete before the student imports: ready', () => {
  assert.deepEqual(decideBackgroundOutcome({ ...base, discoveryStatus: 'COMPLETE', courseCount: 11 }), {
    status: 'ready',
  });
});

test('already imported in the app or cancelled: no push', () => {
  assert.equal(decideBackgroundOutcome({ ...base, stage: 'ONBOARDING_COMPLETE', discoveryStatus: 'COMPLETE' }), null);
  assert.equal(decideBackgroundOutcome({ ...base, stage: 'CANCELLED' }), null);
});

test('expired session: no push', () => {
  assert.equal(
    decideBackgroundOutcome({ ...base, discoveryStatus: 'COMPLETE', expiresAt: new Date(now.getTime() - 1) }),
    null,
  );
});

test('reauth required carries the reason', () => {
  assert.deepEqual(decideBackgroundOutcome({ ...base, stage: 'REAUTH_REQUIRED', reason: 'captcha_required' }), {
    status: 'needs_action',
    reason: 'captcha_required',
  });
});

test('failed stage or failed discovery: failed', () => {
  assert.equal(decideBackgroundOutcome({ ...base, stage: 'FAILED' })?.status, 'failed');
  assert.equal(decideBackgroundOutcome({ ...base, discoveryStatus: 'FAILED' })?.status, 'failed');
});

test('scan stalled long after the student left: failed', () => {
  const requestedAt = new Date(now.getTime() - BACKGROUND_IMPORT_STALL_MS - 1);
  assert.deepEqual(decideBackgroundOutcome({ ...base, requestedAt }), { status: 'failed', reason: 'stalled' });
});

test('ready copy uses the course count and school', () => {
  const push = buildBackgroundImportPush({ status: 'ready' }, {
    sessionId: 's1',
    universityName: 'Northfield University',
    courseCount: 11,
  });
  assert.equal(push.title, 'Your courses are ready');
  assert.equal(push.message, 'We found 11 courses on your Northfield University portal. Tap to review and add them.');
  assert.equal(push.dedupeKey, 'onboarding:s1:ready');
  assert.deepEqual(push.data, {
    type: 'portal_import',
    route: '/school-connect',
    sessionId: 's1',
    status: 'ready',
    courseCount: '11',
  });
  for (const v of Object.values(push.data)) assert.equal(typeof v, 'string');
});

test('ready with one course is singular, zero courses says so', () => {
  assert.match(buildBackgroundImportPush({ status: 'ready' }, { sessionId: 's', courseCount: 1 }).message, /1 course on your school portal/);
  assert.equal(buildBackgroundImportPush({ status: 'ready' }, { sessionId: 's', courseCount: 0 }).title, 'Your portal scan is done');
});

test('needs-action copy by reason', () => {
  const captcha = buildBackgroundImportPush({ status: 'needs_action', reason: 'captcha_required' }, {
    sessionId: 's',
    universityName: 'Northfield University',
    courseCount: 7,
  });
  assert.equal(captcha.title, 'Your portal needs you');
  assert.equal(captcha.message, "Northfield University asked for a captcha. Tap to sign in once and we'll finish importing your courses.");
  assert.equal(captcha.data.reason, 'captcha_required');
  const pw = buildBackgroundImportPush({ status: 'needs_action', reason: 'invalid_credentials' }, { sessionId: 's', courseCount: 0 });
  assert.equal(pw.title, "Couldn't sign in to your portal");
  assert.equal(pw.dedupeKey, 'onboarding:s:needs_action');
});

test('failed copy', () => {
  const p = buildBackgroundImportPush({ status: 'failed', reason: 'stalled' }, { sessionId: 's', courseCount: 3 });
  assert.equal(p.title, "We couldn't finish your import");
  assert.equal(p.data.status, 'failed');
});

test('state parsing and guest detection', () => {
  assert.equal(readBackgroundImportState({}), null);
  assert.equal(readBackgroundImportState({ backgroundImport: { notifyOnFinish: false } }), null);
  assert.deepEqual(readBackgroundImportState({ backgroundImport: { notifyOnFinish: true, requestedAt: 'x' } }), {
    notifyOnFinish: true,
    requestedAt: 'x',
    notified: {},
  });
  assert.equal(sessionCanReceivePush({ isGuest: true }), false);
  assert.equal(sessionCanReceivePush({ isGuest: true, previousUserId: 'g', claimedAt: 't' }), true);
  assert.equal(sessionCanReceivePush(null), true);
});
