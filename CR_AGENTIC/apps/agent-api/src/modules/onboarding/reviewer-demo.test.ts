import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INVALID_CREDENTIALS_MESSAGE,
  REVIEWER_DEMO_PROVISION_PATH,
  REVIEWER_DEMO_USERNAME,
  consumeReviewerDemoAttempt,
  coursesToImportFromProvision,
  internalUniversityPath,
  publicUniversityPath,
  resolveOnboardingUniversityName,
  reviewerDemoCredentialsMatch,
  sessionIsDemo,
  shouldFallbackUniversityLookup,
  timingSafeStringEqual,
  universityDisplayName,
  universityIsDemo,
  universityNameMustBeValidated,
} from './reviewer-demo';

const demoId = '52dda19f-870e-4ef5-9e92-4cb0d12643da';

/** Live `GET /api/universities/:id` shape from api.courserep.ng. */
function mainApiEnvelope(university: Record<string, unknown>) {
  return {
    success: true,
    message: 'Success',
    data: university,
    meta: {},
    timestamp: '2026-10-07T00:00:00.000Z',
    path: `/api/universities/${demoId}`,
    method: 'GET',
    statusCode: 200,
    requestId: 'req-1',
  };
}

describe('universityIsDemo', () => {
  it('is true for boolean isDemo on the university row', () => {
    assert.equal(
      universityIsDemo({
        id: '11111111-1111-4111-8111-111111111111',
        name: 'North State University',
        isDemo: true,
      }),
      true,
    );
  });

  it('reads isDemo from the main API success envelope', () => {
    const body = mainApiEnvelope({
      id: demoId,
      name: 'Course Rep Demo University',
      code: 'CRDEMO',
      isDemo: true,
      status: 'active',
    });
    assert.equal(universityIsDemo(body), true);
    assert.equal(Object.hasOwn(body, 'isDemo'), false);
    assert.equal(universityDisplayName(body), 'Course Rep Demo University');
  });

  it('accepts tinyint 1 on the row or inside data', () => {
    assert.equal(universityIsDemo({ isDemo: 1 }), true);
    assert.equal(universityIsDemo(mainApiEnvelope({ name: 'Demo', isDemo: 1 })), true);
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
    assert.equal(
      universityIsDemo(mainApiEnvelope({ name: 'Course Rep Demo University', isDemo: false })),
      false,
    );
    assert.equal(universityIsDemo(mainApiEnvelope({ name: 'Course Rep Demo University' })), false);
    assert.equal(universityIsDemo({ name: 'Demo University', isDemo: 'true' }), false);
    assert.equal(universityIsDemo({ success: true, data: { isDemo: 'true' } }), false);
    assert.equal(universityIsDemo(null), false);
    assert.equal(universityIsDemo(undefined), false);
  });
});

describe('university lookup', () => {
  it('calls the internal by-id route and falls back only on 404', () => {
    assert.equal(
      internalUniversityPath(demoId),
      `/internal/universities/${demoId}`,
    );
    assert.equal(publicUniversityPath(demoId), `/universities/${demoId}`);
    assert.equal(
      `https://api.courserep.ng/api${internalUniversityPath(demoId)}`,
      `https://api.courserep.ng/api/internal/universities/${demoId}`,
    );
    assert.equal(shouldFallbackUniversityLookup(404), true);
    assert.equal(shouldFallbackUniversityLookup(401), false);
    assert.equal(shouldFallbackUniversityLookup(500), false);
    assert.equal(shouldFallbackUniversityLookup(undefined), false);
  });

  it('keeps a client-supplied name and fills a missing one from the row', () => {
    const loaded = mainApiEnvelope({ name: '  Course Rep Demo University  ', isDemo: true });
    assert.equal(
      resolveOnboardingUniversityName('University of Lagos', loaded),
      'University of Lagos',
    );
    assert.equal(
      resolveOnboardingUniversityName('  ', loaded),
      'Course Rep Demo University',
    );
    assert.equal(resolveOnboardingUniversityName(undefined, loaded), 'Course Rep Demo University');
    assert.equal(resolveOnboardingUniversityName(null, undefined), undefined);
    assert.equal(universityDisplayName({ success: true, data: { name: '   ' } }), undefined);
  });

  it('requires universityName only when universityId is absent or a name was sent', () => {
    assert.equal(
      universityNameMustBeValidated({
        universityId: demoId,
      }),
      false,
    );
    assert.equal(
      universityNameMustBeValidated({
        universityId: demoId,
        universityName: null,
      }),
      false,
    );
    assert.equal(
      universityNameMustBeValidated({
        universityId: demoId,
        universityName: 'Course Rep Demo University',
      }),
      true,
    );
    assert.equal(universityNameMustBeValidated({ universityName: 'University of Lagos' }), true);
    assert.equal(universityNameMustBeValidated({}), true);
    assert.equal(universityNameMustBeValidated({ universityId: '' }), true);
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
