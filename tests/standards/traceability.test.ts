/**
 * Standards traceability test.
 *
 * Every entry pairs a documented requirement with a MEANINGFUL behavioral check —
 * never a mere "class exists" assertion. Each requirement maps to its governing
 * source in docs/STANDARDS.md and docs/COMPLIANCE_REGISTER.md.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PROVENANCE_SOURCE_KINDS } from '../../src/types/provenance';
import { ModalityRegistry } from '../../src/domain/modality/modality';
import { finalizeReport, createReport } from '../../src/domain/results/report';
import { PatientIdentityService } from '../../src/domain/patient/patient';
import { ChargeLedger } from '../../src/domain/billing/billing';
import { toBrandedId } from '../../src/types/ids';

const requirement = (id: string, label: string) => ({ id, label });

describe('standards traceability', () => {
  it(`${requirement('R-CLIN-1', 'Finalized results are never silently overwritten').id} → behavior: re-finalization throws`, () => {
    const draft = createReport({
      reportId: toBrandedId('00000000-0000-4000-8000-0000000000d1'),
      orderId: toBrandedId('00000000-0000-4000-8000-0000000000a1'),
      patientId: toBrandedId('00000000-0000-4000-8000-0000000000b1'),
      facilityId: toBrandedId('00000000-0000-4000-8000-0000000000c1'),
      content: 'x',
      authoredByRef: 'user-1',
      authoredAt: '2026-09-20T00:00:00.000Z',
    });
    const finalized = finalizeReport(draft, '2026-09-20T01:00:00.000Z', 'pathologist-1');
    assert.throws(() => finalizeReport(finalized, '2026-09-20T02:00:00.000Z', 'user-2'));
  });

  it(`${requirement('R-PROV-1', 'Device/algorithm/human provenance stay distinct').id} → behavior: five kinds exist`, () => {
    assert.deepEqual(PROVENANCE_SOURCE_KINDS, [
      'HUMAN',
      'DEVICE',
      'ALGORITHM',
      'INTEGRATION',
      'SYSTEM',
    ]);
  });

  it(`${requirement('R-MOD-1', 'Laboratory is one modality among many').id} → behavior: non-LAB modalities register`, () => {
    const registry = new ModalityRegistry();
    registry.register({ name: 'LAB', displayName: 'Laboratory', capabilities: [] });
    registry.register({ name: 'ECG', displayName: 'ECG', capabilities: [] });
    registry.register({ name: 'EEG', displayName: 'EEG', capabilities: [] });
    assert.ok(registry.has('ECG'));
    assert.ok(registry.has('EEG'));
  });

  it(`${requirement('R-PAT-1', 'Centralized patient identity, no duplicates').id} → behavior: duplicate external ref rejected`, () => {
    const service = new PatientIdentityService();
    const facility = toBrandedId('00000000-0000-4000-8000-000000000011');
    const mrn = {
      system: 'HOSPITAL_MRN' as const,
      value: 'MRN-777',
      facilityId: facility,
    };
    service.createPatient({
      id: toBrandedId('00000000-0000-4000-8000-0000000000e1'),
      registeredAtFacilityId: facility,
      fullName: 'A',
      sex: 'UNKNOWN',
      externalReferences: [mrn],
    });
    assert.throws(
      () =>
        service.createPatient({
          id: toBrandedId('00000000-0000-4000-8000-0000000000e2'),
          registeredAtFacilityId: facility,
          fullName: 'B',
          sex: 'UNKNOWN',
          externalReferences: [mrn],
        }),
      /already claimed/,
    );
  });

  it(`${requirement('R-FIN-1', 'Billing retries cannot duplicate irreversible effects').id} → behavior: idempotent charge`, () => {
    const ledger = new ChargeLedger();
    const input = {
      orderItemId: toBrandedId('00000000-0000-4000-8000-0000000000f1'),
      serviceId: toBrandedId('00000000-0000-4000-8000-0000000000f2'),
      amount: 500,
      currency: 'NPR',
      idempotencyKey: 'req-1000',
    };
    const a = ledger.addCharge(input);
    const b = ledger.addCharge(input);
    assert.equal(a.id, b.id);
  });
});
