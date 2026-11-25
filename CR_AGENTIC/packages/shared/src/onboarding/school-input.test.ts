import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifySchoolInput, universityNameLooksLikeEmail } from './school-input';
import { classifyTestAccount, classifyTestEmail, sessionIsTestAccount } from './test-account';

describe('classifySchoolInput', () => {
  it('flags emails, including the ones pre-launch robots typed', () => {
    for (const v of ['buchi@courserep.ng', 'reviewerapp001@gmail.com', ' ada.obi@gmail.com ', 'ada@unilag']) {
      assert.equal(classifySchoolInput(v), 'email', v);
    }
  });
  it('flags portal links', () => {
    for (const v of ['portal.unilag.edu.ng', 'https://studentportal.unilag.edu.ng/login', 'www.yabatech.edu.ng/portalplus/']) {
      assert.equal(classifySchoolInput(v), 'url', v);
    }
  });
  it('flags phone numbers', () => {
    for (const v of ['+234 803 123 4567', '08031234567', '(0803) 123-4567']) {
      assert.equal(classifySchoolInput(v), 'phone', v);
    }
  });
  it('keeps real school names and acronyms', () => {
    for (const v of ['University of Lagos', 'UNILAG', 'Ho Technical University', "St. John's College", 'U.N.N', 'FUTA']) {
      assert.equal(classifySchoolInput(v), 'name', v);
    }
  });
  it('treats blank as empty', () => {
    assert.equal(classifySchoolInput('   '), 'empty');
    assert.equal(classifySchoolInput(undefined), 'empty');
  });
  it('universityNameLooksLikeEmail only for emails', () => {
    assert.equal(universityNameLooksLikeEmail('ap@courserep.org'), true);
    assert.equal(universityNameLooksLikeEmail('Marmara University'), false);
  });
});

describe('test accounts', () => {
  it('classifies reviewer, staff and example emails', () => {
    assert.equal(classifyTestEmail('reviewerapp001@gmail.com'), 'reviewer');
    assert.equal(classifyTestEmail('appreview@courserep.org'), 'reviewer');
    assert.equal(classifyTestEmail('buchi@courserep.ng'), 'staff');
    assert.equal(classifyTestEmail('crtest@example.com'), 'example_domain');
    assert.equal(classifyTestEmail('student@gmail.com'), null);
    assert.equal(classifyTestEmail('tester@gmail.com', ['Tester@gmail.com']), 'staff');
  });
  it('demo school wins, then email, then a known client hint', () => {
    assert.deepEqual(classifyTestAccount({ isDemoUniversity: true, email: 'student@gmail.com' }), { isTest: true, reason: 'demo_university' });
    assert.deepEqual(classifyTestAccount({ email: 'buchi@courserep.ng', clientHint: 'test_lab' }), { isTest: true, reason: 'staff' });
    assert.deepEqual(classifyTestAccount({ clientHint: 'test_lab' }), { isTest: true, reason: 'test_lab' });
    assert.deepEqual(classifyTestAccount({ clientHint: 'TRUE' }), { isTest: true, reason: 'client_flag' });
  });
  it('ignores unknown hints so a header cannot write arbitrary data', () => {
    assert.equal(classifyTestAccount({ clientHint: '<script>' }), null);
    assert.equal(classifyTestAccount({}), null);
  });
  it('sessionIsTestAccount reads the stored tag', () => {
    assert.equal(sessionIsTestAccount({ testAccount: { isTest: true, reason: 'reviewer' } }), true);
    assert.equal(sessionIsTestAccount({ isGuest: true }), false);
    assert.equal(sessionIsTestAccount(null), false);
  });
});
