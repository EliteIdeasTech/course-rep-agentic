import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { candidateView, hiddenPortalsFrom } from './portal-views';

describe('candidateView', () => {
  it('adds label, host and blockedFromServer from candidate metadata', () => {
    const view = candidateView({
      id: 'c1',
      loginUrl: 'https://www.studentportal.unilag.edu.ng/login',
      lmsType: 'GENERIC',
      portalName: 'UNILAG Student Portal',
      confidence: 0.8,
      evidence: ['opens'],
      source: 'WEB_SEARCH',
      metadata: { label: 'Student portal', blockedFromServer: true },
    });
    assert.equal(view.label, 'Student portal');
    assert.equal(view.host, 'studentportal.unilag.edu.ng');
    assert.equal(view.blockedFromServer, true);
  });

  it('works for old rows without metadata', () => {
    const view = candidateView({
      id: 'c2',
      loginUrl: 'not a url',
      lmsType: 'GENERIC',
      portalName: null,
      confidence: 0.3,
      evidence: [],
      source: 'MANUAL',
    });
    assert.equal(view.label, undefined);
    assert.equal(view.host, undefined);
    assert.equal(view.blockedFromServer, undefined);
    assert.equal(view.portalName, undefined);
  });
});

describe('hiddenPortalsFrom', () => {
  it('returns validated hidden entries only', () => {
    const hidden = hiddenPortalsFrom({
      portalDiscovery: {
        hidden: [
          { host: 'sis.htu.edu.jo', reason: 'other_country', message: 'This portal belongs to a school in another country.' },
          { host: 1, reason: 'x' },
          null,
        ],
      },
    });
    assert.deepEqual(hidden, [
      { host: 'sis.htu.edu.jo', reason: 'other_country', message: 'This portal belongs to a school in another country.' },
    ]);
  });

  it('is empty for sessions discovered before this change', () => {
    assert.deepEqual(hiddenPortalsFrom({ isGuest: true }), []);
    assert.deepEqual(hiddenPortalsFrom(null), []);
  });
});
