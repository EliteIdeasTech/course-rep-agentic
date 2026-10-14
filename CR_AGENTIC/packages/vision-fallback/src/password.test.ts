import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PASSWORD_PLACEHOLDER } from './types';
import { assertNoPassword, redactSecrets, substitutePassword } from './password';
import { buildGoalPrompt } from './prompt';

describe('password redaction', () => {
  const password = 's3cret-portal-pass';

  it('substitutes the placeholder locally and nowhere else', () => {
    const swapped = substitutePassword(`pw ${PASSWORD_PLACEHOLDER} end`, password);
    assert.equal(swapped.substituted, true);
    assert.equal(swapped.text, `pw ${password} end`);
    assert.equal(substitutePassword('student', password).substituted, false);
  });

  it('strips the password and the placeholder from logs', () => {
    const logged = redactSecrets(
      `typed ${PASSWORD_PLACEHOLDER} and ${password}`,
      [password],
    );
    assert.equal(logged.includes(password), false);
    assert.equal(logged.includes(PASSWORD_PLACEHOLDER), false);
    assert.match(logged, /\[redacted\]/);
  });

  it('keeps the password out of the model prompt', () => {
    const prompt = buildGoalPrompt('login_and_extract', 'https://portal.example.edu/login', 'student');
    assert.equal(assertNoPassword(prompt, password), true);
    assert.equal(prompt.includes(PASSWORD_PLACEHOLDER), true);
    assert.equal(prompt.includes('student'), true);
    const find = buildGoalPrompt('find_login_form', 'https://portal.example.edu/login');
    assert.equal(find.includes(PASSWORD_PLACEHOLDER), false);
    assert.match(find, /Do not type/);
  });
});
