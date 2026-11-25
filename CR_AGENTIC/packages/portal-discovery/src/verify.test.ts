import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { LmsType } from '@cr-agentic/shared';
import type { PageMetadata } from './types';
import {
  baseDomain,
  hostMatchesSchool,
  ownershipProblem,
  portalLabel,
  verifyCandidate,
} from './verify';
import { PortalDiscoveryService } from './portal-discovery.service';
import { classifyFetchError } from './tools/page-metadata';

function page(url: string, extra: Partial<PageMetadata> = {}): PageMetadata {
  return {
    url,
    finalUrl: url,
    title: 'Student Portal',
    hasLoginForm: false,
    htmlSample: '<html><title>Student Portal</title><div id="app"></div></html>',
    status: 200,
    ...extra,
  };
}

const HTU = { universityName: 'Ho Technical University', country: 'Ghana' };
const UNILAG = { universityName: 'University of Lagos', country: 'Nigeria' };
const MARMARA = { universityName: 'Marmara University', country: 'Turkey' };

describe('verifyCandidate', () => {
  it('hides a dead DNS host the AI invented (htu.app.edu)', () => {
    const r = verifyCandidate(page('https://htu.app.edu/', { fetchError: 'dns', status: undefined, htmlSample: '', title: undefined }), LmsType.GENERIC, HTU);
    assert.equal(r.verified, false);
    assert.equal(r.hiddenReason, 'unreachable');
  });

  it("hides another country's portal for a Ghanaian school (sis.htu.edu.jo)", () => {
    const r = verifyCandidate(page('https://sis.htu.edu.jo/', { hasLoginForm: true }), LmsType.GENERIC, HTU);
    assert.equal(r.verified, false);
    assert.equal(r.hiddenReason, 'other_country');
  });

  it('accepts a JS-rendered Nigerian portal host without a password field', () => {
    const r = verifyCandidate(page('https://studentportal.unilag.edu.ng/login'), LmsType.GENERIC, UNILAG);
    assert.equal(r.verified, true);
    assert.ok(r.evidence.includes('portal host page'));
  });

  it('accepts a password form on the school ccTLD', () => {
    const r = verifyCandidate(page('https://bys.marmara.edu.tr/', { hasLoginForm: true, title: 'BYS' }), LmsType.GENERIC, MARMARA);
    assert.equal(r.verified, true);
  });

  it('keeps a school portal that blocks our servers, flagged for on-phone sign-in', () => {
    const r = verifyCandidate(page('https://portal.marmara.edu.tr/', { status: 403, title: 'Forbidden' }), LmsType.GENERIC, MARMARA);
    assert.equal(r.verified, true);
    assert.equal(r.blockedFromServer, true);
  });

  it('hides 404s and pages with no sign-in signal', () => {
    assert.equal(verifyCandidate(page('https://portal.unilag.edu.ng/x', { status: 404 }), LmsType.GENERIC, UNILAG).hiddenReason, 'http_error');
    assert.equal(
      verifyCandidate(page('https://unilag.edu.ng/news/today', { title: 'News', htmlSample: '<p>news</p>' }), LmsType.GENERIC, UNILAG).hiddenReason,
      'no_login_signal',
    );
  });

  it('hides WordPress admin logins', () => {
    assert.equal(verifyCandidate(page('https://unilag.edu.ng/wp-login.php', { hasLoginForm: true }), LmsType.GENERIC, UNILAG).hiddenReason, 'cms_login');
  });

  it('hides a generic-TLD host without the school name', () => {
    const r = verifyCandidate(page('https://jones.campusgroups.com/login', { hasLoginForm: true }), LmsType.GENERIC, UNILAG);
    assert.equal(r.hiddenReason, 'other_school');
  });

  it('accepts LMS fingerprints on a hosted LMS with the school name', () => {
    const r = verifyCandidate(page('https://unilag.instructure.com/login'), LmsType.CANVAS, UNILAG);
    assert.equal(r.verified, true);
  });
});

describe('ownership helpers', () => {
  it('baseDomain keeps edu.ng / ac.uk suffixes', () => {
    assert.equal(baseDomain('studentportal.unilag.edu.ng'), 'unilag.edu.ng');
    assert.equal(baseDomain('portal.courtauld.ac.uk'), 'courtauld.ac.uk');
    assert.equal(baseDomain('canvas.example.com'), 'example.com');
  });
  it('matches acronyms and uniXXX short names', () => {
    assert.equal(hostMatchesSchool('htuedu.gh', 'Ho Technical University'), true);
    assert.equal(hostMatchesSchool('unilag.edu.ng', 'University of Lagos'), true);
    assert.equal(hostMatchesSchool('portal.marmara.edu.tr', 'Marmara University'), true);
    assert.equal(hostMatchesSchool('sc.edu', 'University of Lagos'), false);
  });
  it("treats the school's own website domain as owned even on a generic TLD", () => {
    assert.equal(ownershipProblem('https://portal.someschool.com/', { universityName: 'Zed College', website: 'https://www.someschool.com' }), null);
  });
});

describe('portalLabel', () => {
  it('uses human labels, not URLs', () => {
    assert.equal(portalLabel('https://studentportal.unilag.edu.ng/login', LmsType.GENERIC), 'Student portal');
    assert.equal(portalLabel('https://uzem.marmara.edu.tr/', LmsType.MOODLE), 'Moodle e-learning');
    assert.equal(portalLabel('https://sis.htu.edu.gh/', LmsType.GENERIC), 'Student information system');
    assert.equal(portalLabel('https://yabatech.edu.ng/portalplus/', LmsType.GENERIC), 'PortalPlus student portal');
    assert.equal(portalLabel('https://bys.marmara.edu.tr/', LmsType.GENERIC, 'BYS - Login'), 'BYS');
    assert.equal(portalLabel('https://x.edu.ng/', LmsType.GENERIC, '404 Not Found'), 'Student portal');
  });
});

describe('classifyFetchError', () => {
  it('maps DNS, timeout and reset', () => {
    assert.equal(classifyFetchError({ cause: { code: 'ENOTFOUND' } }), 'dns');
    assert.equal(classifyFetchError({ name: 'AbortError' }), 'timeout');
    assert.equal(classifyFetchError({ cause: { code: 'ECONNRESET' } }), 'connection');
    assert.equal(classifyFetchError(new Error('x')), 'other');
  });
});

describe('PortalDiscoveryService.discoverDetailed', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(pages: Record<string, { status: number; html: string } | 'dns'>) {
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      const hit = pages[url];
      if (!hit || hit === 'dns') {
        const err = new TypeError('fetch failed') as TypeError & { cause: { code: string } };
        err.cause = { code: 'ENOTFOUND' };
        throw err;
      }
      return {
        url,
        status: hit.status,
        text: async () => hit.html,
      } as unknown as Response;
    }) as typeof fetch;
  }

  it('never suggests unverified AI URLs and reports why they were hidden (Ho Technical University)', async () => {
    stubFetch({
      'https://portal.htu.edu.gh/': { status: 200, html: '<title>HTU Portal | Login</title><form><input name="user"><input type="password"></form>' },
      'https://sis.htu.edu.jo/': { status: 200, html: '<title>SIS</title><form><input type="password"></form>' },
      'https://htu.app.edu/': 'dns',
    });
    const search = { search: async () => [{ title: 'SIS', url: 'https://sis.htu.edu.jo/' }, { title: 'HTU', url: 'https://portal.htu.edu.gh/' }] };
    const llm = {
      completeJson: async () =>
        JSON.stringify({
          candidates: [
            { loginUrl: 'https://htu.app.edu/', confidence: 0.95 },
            { loginUrl: 'https://sis.htu.edu.jo/', confidence: 0.9 },
            { loginUrl: 'https://portal.htu.edu.gh/', confidence: 0.6 },
          ],
        }),
    };
    const svc = new PortalDiscoveryService(search, llm);
    const out = await svc.discoverDetailed({ universityName: 'Ho Technical University', country: 'Ghana' });
    assert.deepEqual(out.candidates.map((c) => c.loginUrl), ['https://portal.htu.edu.gh/']);
    assert.equal(out.candidates[0].label, 'Student portal');
    const reasons = Object.fromEntries(out.hidden.map((h) => [h.host, h.reason]));
    assert.equal(reasons['sis.htu.edu.jo'], 'other_country');
    assert.equal(reasons['htu.app.edu'], 'unreachable');
  });

  it('works without the LLM (heuristics + verification only)', async () => {
    stubFetch({ 'https://studentportal.unilag.edu.ng/login': { status: 200, html: '<title>UNILAG Student Portal</title><div id=root></div>' } });
    const svc = new PortalDiscoveryService(
      { search: async () => [{ title: 'UNILAG', url: 'https://studentportal.unilag.edu.ng/login' }] },
      { completeJson: async () => { throw new Error('llm down'); } },
    );
    const out = await svc.discover({ universityName: 'University of Lagos', country: 'Nigeria' });
    assert.equal(out.length, 1);
    assert.equal(out[0].loginUrl, 'https://studentportal.unilag.edu.ng/login');
  });

  it('returns nothing (not garbage) when no URL verifies', async () => {
    stubFetch({});
    const svc = new PortalDiscoveryService(
      { search: async () => [{ title: 'x', url: 'https://portal.nowhere.example/' }] },
      { completeJson: async () => JSON.stringify({ candidates: [{ loginUrl: 'https://made-up.edu/' }] }) },
    );
    const out = await svc.discoverDetailed({ universityName: 'Nowhere University', country: 'Nigeria' });
    assert.equal(out.candidates.length, 0);
    assert.ok(out.hidden.length >= 1);
  });
});
