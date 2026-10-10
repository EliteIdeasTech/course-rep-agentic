import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isNavigationAllowed, registrableDomain } from './domain';

describe('domain guard', () => {
  it('allows subdomains of the portal registrable domain', () => {
    assert.equal(registrableDomain('student.unilag.edu.ng'), 'unilag.edu.ng');
    assert.equal(registrableDomain('portal.university.ac.uk'), 'university.ac.uk');
    const ok = isNavigationAllowed(
      'https://portal.unilag.edu.ng/courses',
      'https://student.unilag.edu.ng/login',
    );
    assert.equal(ok.ok, true);
  });

  it('refuses other sites and non-http schemes', () => {
    const other = isNavigationAllowed('https://accounts.google.com/signin', 'https://portal.example.edu/login');
    assert.equal(other.ok, false);
    const script = isNavigationAllowed('javascript:alert(1)', 'https://portal.example.edu/login');
    assert.equal(script.ok, false);
    const relative = isNavigationAllowed('/results', 'https://portal.example.edu/login', 'https://portal.example.edu/home');
    assert.equal(relative.ok, true);
    assert.equal(relative.resolved, 'https://portal.example.edu/results');
  });
});
