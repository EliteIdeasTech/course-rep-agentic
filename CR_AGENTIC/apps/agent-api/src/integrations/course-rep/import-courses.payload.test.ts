import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  annotateOffered,
  toAgentImportCourses,
  type DiscoveredCourseForImport,
} from './import-courses.payload';

function course(
  partial: Partial<DiscoveredCourseForImport> & Pick<DiscoveredCourseForImport, 'title' | 'selected'>,
): DiscoveredCourseForImport {
  return {
    code: null,
    externalId: null,
    units: null,
    instructor: null,
    ...partial,
  };
}

describe('toAgentImportCourses', () => {
  it('sends every scraped course and marks only the selection offered', () => {
    const scraped = [
      course({ code: 'CSC301', title: 'Algorithms', units: 3, instructor: 'Ada', selected: true }),
      course({ code: 'MTH101', title: 'Calculus', units: 2, selected: false }),
      course({ code: 'GST111', title: 'Use of English', selected: true }),
    ];

    const payload = toAgentImportCourses(scraped);

    assert.equal(payload.length, scraped.length);
    assert.deepEqual(
      payload.map((row) => ({ code: row.code, offered: row.offered })),
      [
        { code: 'CSC301', offered: true },
        { code: 'MTH101', offered: false },
        { code: 'GST111', offered: true },
      ],
    );
    assert.equal(payload.filter((row) => row.offered).length, 2);
    assert.equal(payload[0].units, 3);
    assert.equal(payload[0].instructor, 'Ada');
    assert.equal(payload[1].instructor, undefined);
    assert.equal(payload[2].units, undefined);
  });

  it('keeps a stable code so a later sync updates the same departmental course', () => {
    const first = toAgentImportCourses([
      course({
        code: '  CSC301 ',
        externalId: 'portal-9',
        title: 'Algorithms',
        units: 3,
        selected: true,
      }),
    ]);
    const resync = toAgentImportCourses([
      course({
        code: 'CSC301',
        externalId: 'portal-9',
        title: 'Algorithms I',
        units: 4,
        instructor: 'Grace',
        selected: false,
      }),
    ]);

    assert.equal(first[0].code, resync[0].code);
    assert.equal(resync[0].title, 'Algorithms I');
    assert.equal(resync[0].units, 4);
    assert.equal(resync[0].instructor, 'Grace');
    assert.equal(resync[0].offered, false);
  });

  it('falls back to external id, then title, when the portal has no course code', () => {
    const payload = toAgentImportCourses([
      course({ code: '   ', externalId: 'ext-42', title: 'Untitled lab', selected: false }),
      course({ title: 'Seminar', selected: true }),
    ]);

    assert.deepEqual(
      payload.map((row) => row.code),
      ['ext-42', 'Seminar'],
    );
    assert.equal(payload[0].offered, false);
    assert.equal(payload[1].offered, true);
  });

  it('does not embed a school identity in the import payload', () => {
    const payload = toAgentImportCourses([
      course({ code: 'PHY201', title: 'Waves', selected: true }),
    ]);
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes('university'), false);
    assert.equal(serialized.includes('portal'), false);
  });
});

describe('annotateOffered', () => {
  it('keeps the full discovery row and mirrors selected as offered', () => {
    const row = annotateOffered({
      id: 'course-1',
      code: 'CSC301',
      title: 'Algorithms',
      selected: false,
    });

    assert.equal(row.id, 'course-1');
    assert.equal(row.selected, false);
    assert.equal(row.offered, false);
  });
});
