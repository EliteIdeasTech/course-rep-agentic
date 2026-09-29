const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCourseRepApiUrl } = require('../dist/course-rep-api-url');

describe('normalizeCourseRepApiUrl', () => {
  it('appends /api when the origin has no path', () => {
    assert.equal(
      normalizeCourseRepApiUrl('https://api.courserep.ng'),
      'https://api.courserep.ng/api',
    );
  });

  it('appends /api after stripping a trailing slash', () => {
    assert.equal(
      normalizeCourseRepApiUrl('https://api.courserep.ng/'),
      'https://api.courserep.ng/api',
    );
    assert.equal(
      normalizeCourseRepApiUrl('http://localhost:3000/'),
      'http://localhost:3000/api',
    );
  });

  it('keeps an existing /api suffix (no /api/api)', () => {
    assert.equal(
      normalizeCourseRepApiUrl('https://api.courserep.ng/api'),
      'https://api.courserep.ng/api',
    );
    assert.equal(
      normalizeCourseRepApiUrl('https://api.courserep.ng/api/'),
      'https://api.courserep.ng/api',
    );
    assert.equal(
      normalizeCourseRepApiUrl('http://localhost:3000/api'),
      'http://localhost:3000/api',
    );
  });

  it('normalizes local and docker host URLs that omit /api', () => {
    assert.equal(
      normalizeCourseRepApiUrl('http://localhost:3000'),
      'http://localhost:3000/api',
    );
    assert.equal(
      normalizeCourseRepApiUrl('http://host.docker.internal:3000'),
      'http://host.docker.internal:3000/api',
    );
  });

  it('builds the Nest internal import path CourseRepClient uses', () => {
    const base = normalizeCourseRepApiUrl('https://api.courserep.ng');
    assert.equal(
      `${base}/internal/courses/import-from-agent`,
      'https://api.courserep.ng/api/internal/courses/import-from-agent',
    );
  });
});
