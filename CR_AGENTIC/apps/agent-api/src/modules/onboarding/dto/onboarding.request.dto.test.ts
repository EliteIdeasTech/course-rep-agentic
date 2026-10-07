import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StartOnboardingRequestDto } from './onboarding.request.dto';

const demoId = '52dda19f-870e-4ef5-9e92-4cb0d12643da';

async function messages(body: object): Promise<string[]> {
  const dto = plainToInstance(StartOnboardingRequestDto, body);
  const errors = await validate(dto);
  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('StartOnboardingRequestDto universityName', () => {
  it('accepts the CourseRepMobile body that sends id and name', async () => {
    const found = await messages({
      universityId: demoId,
      universityName: 'Course Rep Demo University',
    });
    assert.deepEqual(found, []);
  });

  it('accepts universityId alone', async () => {
    const found = await messages({ universityId: demoId });
    assert.deepEqual(found, []);
  });

  it('still requires universityName when universityId is omitted', async () => {
    const found = await messages({});
    assert.ok(found.some((message) => message.includes('universityName')));
  });

  it('rejects a non-string universityName even when universityId is set', async () => {
    const found = await messages({ universityId: demoId, universityName: 1 });
    assert.ok(found.some((message) => message.includes('universityName')));
  });
});
