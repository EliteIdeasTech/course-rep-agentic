import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INVALID_CREDENTIALS_MESSAGE,
  REVIEWER_DEMO_PROVISION_PATH,
  REVIEWER_DEMO_USERNAME,
  consumeReviewerDemoAttempt,
  coursesToImportFromProvision,
  reviewerDemoCredentialsMatch,
  sessionIsDemo,
  timingSafeStringEqual,
  universityIsDemo,
} from './reviewer-demo';

describe('universityIsDemo', () => {
  it('is true only for boolean isDemo from the main API', () => {
    assert.equal(
      universityIsDemo({
        id: '11111111-1111-4111-8111-111111111111',
        name: 'North State University',
        isDemo: true,
      }),
      true,
    );
  });

  it('ignores name and id when the flag is absent or false', () => {
    assert.equal(
      universityIsDemo({
        id: 'appreview',
        name: 'Apple Review University',
        code: 'APPREVIEW',
      }),
      false,
    );
    assert.equal(
      universityIsDemo({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Google App Review',
        isDemo: false,
      }),
      false,
    );
    assert.equal(universityIsDemo({ name: 'Demo University', isDemo: 'true' }), false);
    assert.equal(universityIsDemo({ isDemo: 1 }), false);
    assert.equal(universityIsDemo(null), false);
    assert.equal(universityIsDemo(undefined), false);
  });
});

describe('sessionIsDemo', () => {
  it('reads the flag stored at start', () => {
    assert.equal(sessionIsDemo({ isDemo: true, guest: false }), true);
    assert.equal(sessionIsDemo({ isDemo: false }), false);
    assert.equal(sessionIsDemo({ universityName: 'Apple Review University' }), false);
    assert.equal(sessionIsDemo(null), false);
  });
});

describe('reviewerDemoCredentialsMatch', () => {
  const password = 'review-secret-value';

  it('accepts appreview and the configured password', () => {
    assert.equal(
      reviewerDemoCredentialsMatch(REVIEWER_DEMO_USERNAME, password, password),
      true,
    );
  });

  it('rejects a wrong username or password without throwing on length mismatch', () => {
    assert.equal(reviewerDemoCredentialsMatch('other', password, password), false);
    assert.equal(reviewerDemoCredentialsMatch('appreview', 'nope', password), false);
    assert.equal(reviewerDemoCredentialsMatch('appreview', 'review-secret-value-extra', password), false);
    assert.equal(reviewerDemoCredentialsMatch('AppReview', password, password), false);
    assert.equal(timingSafeStringEqual('short', 'much-longer-value'), false);
  });

  it('rejects every attempt when the password env is unset or empty', () => {
    assert.equal(reviewerDemoCredentialsMatch('appreview', password, undefined), false);
    assert.equal(reviewerDemoCredentialsMatch('appreview', password, null), false);
    assert.equal(reviewerDemoCredentialsMatch('appreview', password, ''), false);
    assert.equal(reviewerDemoCredentialsMatch('appreview', '', ''), false);
  });

  it('uses the invalid-credentials message for failures', () => {
    assert.equal(INVALID_CREDENTIALS_MESSAGE, 'Invalid credentials');
  });
});

describe('consumeReviewerDemoAttempt', () => {
  it('allows attempts inside the window and blocks the next one', async () => {
    const counts = new Map<string, number>();
    const store = {
      async incr(key: string) {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next;
      },
      async expire() {
        return 1;
      },
    };

    assert.equal(await consumeReviewerDemoAttempt(store, 'user-1', { limit: 2, windowSec: 60 }), true);
    assert.equal(await consumeReviewerDemoAttempt(store, 'user-1', { limit: 2, windowSec: 60 }), true);
    assert.equal(await consumeReviewerDemoAttempt(store, 'user-1', { limit: 2, windowSec: 60 }), false);
    assert.equal(await consumeReviewerDemoAttempt(store, 'user-2', { limit: 2, windowSec: 60 }), true);
  });
});

describe('coursesToImportFromProvision', () => {
  it('imports courses returned by provision and treats omitted offered as true', () => {
    const payload = coursesToImportFromProvision('user-1', {
      courses: [
        { code: 'CSC101', title: 'Intro', units: 3, instructor: 'Ada', offered: true },
        { code: 'MTH101', title: 'Calculus', offered: false },
        { code: '   ', title: 'Skip me' },
      ],
    });

    assert.deepEqual(payload, {
      userId: 'user-1',
      courses: [
        { code: 'CSC101', title: 'Intro', units: 3, instructor: 'Ada', offered: true },
        { code: 'MTH101', title: 'Calculus', offered: false },
      ],
    });
  });

  it('skips import when provision does not return courses', () => {
    assert.equal(coursesToImportFromProvision('user-1', {}), null);
    assert.equal(coursesToImportFromProvision('user-1', null), null);
    assert.equal(coursesToImportFromProvision('user-1', { courses: [] }), null);
  });
});

describe('REVIEWER_DEMO_PROVISION_PATH', () => {
  it('targets the Nest internal route behind /api', () => {
    assert.equal(REVIEWER_DEMO_PROVISION_PATH, '/internal/reviewer-demo/provision');
    const base = 'https://api.courserep.ng/api';
    assert.equal(
      `${base}${REVIEWER_DEMO_PROVISION_PATH}`,
      'https://api.courserep.ng/api/internal/reviewer-demo/provision',
    );
  });
});
