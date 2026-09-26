/**
 * Mapping tests: domain entity → application DTO.
 *
 * Every mapper must be explicit, typed, deterministic, and side-effect free:
 * required fields survive, internal/audit structures never leak, and
 * provenance source kinds survive the boundary verbatim.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DiagnosticOrder } from '../../src/domain/ordering/diagnostic-order';
import type { Specimen } from '../../src/domain/specimen/specimen';
import type { Observation } from '../../src/domain/results/observation';
import type { Interpretation } from '../../src/domain/results/interpretation';
import type { DiagnosticReport } from '../../src/domain/results/report';
import {
  toInterpretationDTO,
  toObservationDTO,
  toOrderDTO,
  toReportDTO,
  toSpecimenDTO,
} from '../../src/app/dto';
import { toBrandedId } from '../../src/types/ids';
import { ENCOUNTER_ID, FACILITY, PATIENT_ID } from './helpers';

const ORDER_ID = toBrandedId('00000000-0000-4000-8000-0000000000a1');
const ITEM_ID = toBrandedId('00000000-0000-4000-8000-0000000000a2');
const SPECIMEN_ID = toBrandedId('00000000-0000-4000-8000-0000000000a3');
const OBSERVATION_ID = toBrandedId('00000000-0000-4000-8000-0000000000a4');
const INTERPRETATION_ID = toBrandedId('00000000-0000-4000-8000-0000000000a5');
const REPORT_ID = toBrandedId('00000000-0000-4000-8000-0000000000a6');
const VERSION_ID = toBrandedId('00000000-0000-4000-8000-0000000000a7');

describe('mapping: order → DTO', () => {
  it('preserves required fields and exposes no audit internals', () => {
    const order: DiagnosticOrder = {
      id: ORDER_ID,
      patientId: PATIENT_ID,
      encounterId: ENCOUNTER_ID,
      facilityId: FACILITY,
      priority: 'ROUTINE',
      modality: 'LAB',
      status: 'ORDERED',
      orderedAt: '2026-09-20T08:00:00.000Z',
      orderedByRef: 'user-tech-1',
      version: 1,
      items: [{ id: ITEM_ID, orderId: ORDER_ID, testCode: 'CBC', codeSystem: 'sdis' }],
    };
    const dto = toOrderDTO(order);
    assert.equal(dto.id, ORDER_ID);
    assert.equal(dto.patientId, PATIENT_ID);
    assert.equal(dto.encounterId, ENCOUNTER_ID);
    assert.equal(dto.facilityId, FACILITY);
    assert.equal(dto.modality, 'LAB');
    assert.equal(dto.status, 'ORDERED');
    assert.equal(dto.orderedAt, '2026-09-20T08:00:00.000Z');
    assert.equal(dto.orderedByRef, 'user-tech-1');
    assert.deepEqual(dto.items, [{ id: ITEM_ID, testCode: 'CBC', codeSystem: 'sdis' }]);
    assert.ok(!('audit' in dto) && !('provenance' in dto));
  });
});

describe('mapping: specimen → DTO', () => {
  it('preserves identity, kind, and status', () => {
    const specimen: Specimen = {
      id: SPECIMEN_ID,
      orderItemId: ITEM_ID,
      patientId: PATIENT_ID,
      kind: 'BLOOD',
      collectedAt: '2026-09-20T08:01:00.000Z',
      collectedByRef: 'user-tech-1',
      status: 'COLLECTED',
      version: 1,
    };
    const dto = toSpecimenDTO(specimen);
    assert.equal(dto.id, SPECIMEN_ID);
    assert.equal(dto.orderItemId, ITEM_ID);
    assert.equal(dto.patientId, PATIENT_ID);
    assert.equal(dto.kind, 'BLOOD');
    assert.equal(dto.status, 'COLLECTED');
    assert.equal(dto.collectedAt, '2026-09-20T08:01:00.000Z');
    assert.equal(dto.collectedByRef, 'user-tech-1');
  });
});

describe('mapping: observation → DTO', () => {
  it('preserves the value union and the provenance source verbatim', () => {
    const observation: Observation = {
      id: OBSERVATION_ID,
      orderItemId: ITEM_ID,
      patientId: PATIENT_ID,
      code: 'HB',
      codeSystem: 'sdis',
      value: { kind: 'QUANTITATIVE', value: 13.2 },
      unit: 'g/dL',
      issuedBy: { kind: 'DEVICE', label: 'analyzer-x1', ref: 'dev-1' },
      at: '2026-09-20T08:06:00.000Z',
    };
    const dto = toObservationDTO(observation);
    assert.deepEqual(dto.value, { kind: 'QUANTITATIVE', value: 13.2 });
    assert.equal(dto.unit, 'g/dL');
    assert.equal(dto.issuedByKind, 'DEVICE');
    assert.equal(dto.issuedByLabel, 'analyzer-x1');
    assert.equal(dto.issuedByRef, 'dev-1');
    assert.equal(dto.at, '2026-09-20T08:06:00.000Z');
  });

  it('omits optional fields when absent (nullability preserved)', () => {
    const observation: Observation = {
      id: OBSERVATION_ID,
      orderItemId: ITEM_ID,
      patientId: PATIENT_ID,
      code: 'NOTE',
      codeSystem: 'sdis',
      value: { kind: 'TEXT', text: 'hemolyzed' },
      issuedBy: { kind: 'HUMAN', label: 'manual entry' },
      at: '2026-09-20T08:06:00.000Z',
    };
    const dto = toObservationDTO(observation);
    assert.ok(!('unit' in dto));
    assert.ok(!('issuedByRef' in dto));
    assert.equal(dto.issuedByKind, 'HUMAN');
  });
});

describe('mapping: interpretation → DTO', () => {
  it('keeps a machine source machine-identifiable', () => {
    const interpretation: Interpretation = {
      id: INTERPRETATION_ID,
      orderItemId: ITEM_ID,
      source: { kind: 'ALGORITHM', label: 'rules-v3' },
      text: 'within expected pattern',
      at: '2026-09-20T08:07:00.000Z',
    };
    const dto = toInterpretationDTO(interpretation);
    assert.equal(dto.sourceKind, 'ALGORITHM');
    assert.equal(dto.sourceLabel, 'rules-v3');
    assert.equal(dto.text, 'within expected pattern');
    assert.ok(!('sourceRef' in dto));
  });
});

describe('mapping: report → DTO', () => {
  it('exposes versions with status and supersession, never internals', () => {
    const report: DiagnosticReport = {
      id: REPORT_ID,
      orderId: ORDER_ID,
      patientId: PATIENT_ID,
      facilityId: FACILITY,
      versions: [
        {
          id: VERSION_ID,
          reportId: REPORT_ID,
          version: 1,
          status: 'FINALIZED',
          content: 'CBC normal',
          authoredByRef: 'path-1',
          authoredAt: '2026-09-20T08:10:00.000Z',
          finalizedAt: '2026-09-20T08:11:00.000Z',
        },
      ],
    };
    const dto = toReportDTO(report);
    assert.equal(dto.id, REPORT_ID);
    assert.equal(dto.orderId, ORDER_ID);
    assert.equal(dto.patientId, PATIENT_ID);
    assert.equal(dto.facilityId, FACILITY);
    assert.equal(dto.latestStatus, 'FINALIZED');
    assert.equal(dto.latestVersion, 1);
    assert.equal(dto.versions.length, 1);
    assert.equal(dto.versions[0]?.status, 'FINALIZED');
    assert.equal(dto.versions[0]?.finalizedAt, '2026-09-20T08:11:00.000Z');
    assert.ok(!('audit' in dto));
  });
});
