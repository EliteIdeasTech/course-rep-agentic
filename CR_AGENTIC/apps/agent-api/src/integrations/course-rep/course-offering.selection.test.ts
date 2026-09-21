import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  orderDiscoveredCourses,
  planCourseOffering,
  type ExistingDiscoveredCourse,
} from './course-offering.selection';

function rows(count: number): ExistingDiscoveredCourse[] {
  return Array.from({ length: count }, (_, index) => {
    const n = String(index + 1).padStart(2, '0');
    return { id: `00000000-0000-4000-8000-${n.padStart(12, '0')}`, code: `CSC${n}` };
  });
}

describe('planCourseOffering', () => {
  it('keeps every course id and offers only the checked subset', () => {
    const existing = rows(40);
    const plan = planCourseOffering(existing, {
      courseIds: existing.map((course) => course.id),
      offeredCourseIds: existing.slice(0, 10).map((course) => course.id),
      offeredCodes: existing.slice(0, 10).map((course) => course.code!),
    });

    assert.equal(plan.apply, true);
    assert.deepEqual(plan.missingIds, []);
    assert.equal(plan.updates.length, 40);
    assert.equal(plan.updates.filter((row) => row.selected).length, 10);
    assert.equal(plan.updates[10].selected, false);
    assert.equal(plan.updates[39].id, existing[39].id);
  });

  it('offers a checked course that has no code by id', () => {
    const existing = [
      { id: '00000000-0000-4000-8000-000000000001', code: 'CSC01' },
      { id: '00000000-0000-4000-8000-000000000002', code: '   ' },
      { id: '00000000-0000-4000-8000-000000000003', code: null },
    ];
    const plan = planCourseOffering(existing, {
      courseIds: existing.map((course) => course.id),
      offeredCourseIds: [existing[1].id, existing[2].id],
      offeredCodes: [],
    });

    assert.deepEqual(
      plan.updates.map((row) => row.selected),
      [false, true, true],
    );
  });

  it('matches offered codes case-insensitively when the id list is incomplete', () => {
    const existing = rows(2);
    const plan = planCourseOffering(existing, {
      courseIds: existing.map((course) => course.id),
      offeredCourseIds: [],
      offeredCodes: ['  csc02  '],
    });

    assert.deepEqual(
      plan.updates.map((row) => row.selected),
      [false, true],
    );
  });

  it('persists a course id that is not already stored', () => {
    const existing = rows(1);
    const missing = '00000000-0000-4000-8000-000000000099';
    const plan = planCourseOffering(existing, {
      courseIds: [existing[0].id, missing],
      offeredCourseIds: [missing],
      offeredCodes: ['CSC01'],
    });

    assert.deepEqual(plan.missingIds, [missing]);
    assert.equal(plan.updates.find((row) => row.id === missing)?.selected, true);
    assert.equal(plan.updates.find((row) => row.id === existing[0].id)?.selected, true);
  });

  it('treats courseIds as the offered subset when offered fields are omitted', () => {
    const existing = rows(3);
    const plan = planCourseOffering(existing, {
      courseIds: [existing[1].id],
    });

    assert.deepEqual(
      plan.updates.map((row) => row.selected),
      [false, true, false],
    );
    assert.deepEqual(plan.missingIds, []);
  });

  it('leaves stored flags alone when no course selection is sent', () => {
    const plan = planCourseOffering(rows(2), {});
    assert.equal(plan.apply, false);
    assert.deepEqual(plan.updates, []);
  });

  it('stores the full list unoffered when the student checks nothing', () => {
    const existing = rows(3);
    const plan = planCourseOffering(existing, {
      courseIds: existing.map((course) => course.id),
      offeredCourseIds: [],
      offeredCodes: [],
    });

    assert.equal(plan.updates.every((row) => !row.selected), true);
    assert.equal(plan.missingIds.length, 0);
  });
});

describe('orderDiscoveredCourses', () => {
  it('follows discovery order and keeps rows the client did not list', () => {
    const existing = rows(3);
    const ordered = orderDiscoveredCourses(existing, [existing[2].id, existing[0].id]);
    assert.deepEqual(
      ordered.map((course) => course.id),
      [existing[2].id, existing[0].id, existing[1].id],
    );
  });
});
