/**
 * Clinical test: finalized reports are immutable; amendments create versions and
 * never silently rewrite prior versions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  amendReport,
  createReport,
  finalizeReport,
} from '../../src/domain/results/report';
import { toBrandedId } from '../../src/types/ids';

const ORDER_ID = toBrandedId('00000000-0000-4000-8000-0000000000a1');
const PATIENT_ID = toBrandedId('00000000-0000-4000-8000-0000000000b1');
const FACILITY_ID = toBrandedId('00000000-0000-4000-8000-0000000000c1');
const REPORT_ID = toBrandedId('00000000-0000-4000-8000-0000000000d1');

describe('clinical: report immutability', () => {
  it('finalization freezes the head version', () => {
    const draft = createReport({
      reportId: REPORT_ID,
      orderId: ORDER_ID,
      patientId: PATIENT_ID,
      facilityId: FACILITY_ID,
      content: 'v1 draft content',
      authoredByRef: 'user-1',
      authoredAt: '2026-09-20T00:00:00.000Z',
    });
    const finalized = finalizeReport(draft, '2026-09-20T01:00:00.000Z', 'pathologist-1');
    const head = finalized.versions[finalized.versions.length - 1];
    assert.equal(head?.status, 'FINALIZED');
    assert.equal(head?.finalizedAt, '2026-09-20T01:00:00.000Z');
    assert.ok(Object.isFrozen(head));
  });

  it('a finalized report cannot be finalized a second time', () => {
    const draft = createReport({
      reportId: REPORT_ID,
      orderId: ORDER_ID,
      patientId: PATIENT_ID,
      facilityId: FACILITY_ID,
      content: 'content',
      authoredByRef: 'user-1',
      authoredAt: '2026-09-20T00:00:00.000Z',
    });
    const finalized = finalizeReport(draft, '2026-09-20T01:00:00.000Z', 'pathologist-1');
    assert.throws(
      () => finalizeReport(finalized, '2026-09-20T02:00:00.000Z', 'user-2'),
      /already finalized/,
    );
  });

  it('amendment creates a new version superseding the old; old content never changes', () => {
    const draft = createReport({
      reportId: REPORT_ID,
      orderId: ORDER_ID,
      patientId: PATIENT_ID,
      facilityId: FACILITY_ID,
      content: 'original final content',
      authoredByRef: 'pathologist-1',
      authoredAt: '2026-09-20T00:00:00.000Z',
    });
    const finalized = finalizeReport(draft, '2026-09-20T01:00:00.000Z', 'pathologist-1');
    const v1 = finalized.versions[finalized.versions.length - 1];

    const amended = amendReport(
      finalized,
      'corrected content',
      'pathologist-2',
      '2026-09-20T03:00:00.000Z',
      toBrandedId('00000000-0000-4000-8000-0000000000d2'),
      'TRANSCRIPTION_CORRECTION',
    );
    assert.equal(amended.versions.length, 2);
    const v2 = amended.versions[amended.versions.length - 1];
    assert.equal(v2?.version, 2);
    assert.equal(v2?.content, 'corrected content');
    assert.equal(v2?.supersedesVersionId, v1?.id);

    // v1 is untouched and still finalized
    const retainedV1 = amended.versions[0];
    assert.equal(retainedV1?.content, 'original final content');
    assert.equal(retainedV1?.status, 'FINALIZED');
    assert.equal(retainedV1?.version, 1);
  });
});
