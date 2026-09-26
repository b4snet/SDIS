/**
 * Patient identity test: single identity source; external references never become
 * a second identity; duplicate external references are rejected.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PatientIdentityService } from '../../src/domain/patient/patient';
import { assertSpecimenPatientMatches } from '../../src/domain/specimen/specimen';
import { toBrandedId } from '../../src/types/ids';

const FACILITY = toBrandedId('00000000-0000-4000-8000-000000000011');
const OTHER_FACILITY = toBrandedId('00000000-0000-4000-8000-000000000012');

function patientInput(id: string, name: string) {
  return {
    id: toBrandedId(id),
    registeredAtFacilityId: FACILITY,
    fullName: name,
    sex: 'UNKNOWN' as const,
  };
}

describe('patient: single identity source', () => {
  it('creates one canonical patient with external references attached', () => {
    const service = new PatientIdentityService();
    const patient = service.createPatient({
      ...patientInput('00000000-0000-4000-8000-0000000000e1', 'Alice'),
      externalReferences: [
        { system: 'HOSPITAL_MRN', value: 'MRN-1001', facilityId: FACILITY },
      ],
    });
    assert.equal(patient.externalReferences.length, 1);
    const ref = { system: 'HOSPITAL_MRN', value: 'MRN-1001', facilityId: FACILITY };
    assert.equal(service.findByExternalReference(ref)?.id, patient.id);
  });

  it('hospital MRN and national ID coexist as references to the same patient', () => {
    const service = new PatientIdentityService();
    let patient = service.createPatient(
      patientInput('00000000-0000-4000-8000-0000000000e2', 'Bob'),
    );
    patient = service.attachExternalReference(patient.id, {
      system: 'HOSPITAL_MRN',
      value: 'MRN-2002',
      facilityId: FACILITY,
    });
    patient = service.attachExternalReference(patient.id, {
      system: 'NATIONAL_ID',
      value: 'NID-900',
      facilityId: FACILITY,
    });
    assert.equal(patient.externalReferences.length, 2);
    const byMrn = service.findByExternalReference({
      system: 'HOSPITAL_MRN',
      value: 'MRN-2002',
      facilityId: FACILITY,
    });
    assert.equal(byMrn?.id, patient.id);
  });

  it('rejects a second patient claiming the same reference (duplicate prevention)', () => {
    const service = new PatientIdentityService();
    service.createPatient({
      ...patientInput('00000000-0000-4000-8000-0000000000e3', 'Carol'),
      externalReferences: [
        { system: 'HOSPITAL_MRN', value: 'MRN-3003', facilityId: FACILITY },
      ],
    });
    assert.throws(
      () =>
        service.createPatient({
          ...patientInput('00000000-0000-4000-8000-0000000000e4', 'Eve'),
          externalReferences: [
            { system: 'HOSPITAL_MRN', value: 'MRN-3003', facilityId: FACILITY },
          ],
        }),
      /already claimed/,
    );
  });

  it('the same MRN in a different facility is a distinct reference (facility scope)', () => {
    const service = new PatientIdentityService();
    const a = service.createPatient({
      ...patientInput('00000000-0000-4000-8000-0000000000e5', 'Frank'),
      externalReferences: [
        { system: 'HOSPITAL_MRN', value: 'MRN-5005', facilityId: FACILITY },
      ],
    });
    const b = service.createPatient({
      ...patientInput('00000000-0000-4000-8000-0000000000e6', 'Grace'),
      externalReferences: [
        { system: 'HOSPITAL_MRN', value: 'MRN-5005', facilityId: OTHER_FACILITY },
      ],
    });
    assert.notEqual(a.id, b.id);
  });
});

describe('specimen: patient identity cannot be silently changed', () => {
  it('rejects a specimen patient that differs from the order item patient', () => {
    assert.throws(
      () =>
        assertSpecimenPatientMatches(
          toBrandedId('00000000-0000-4000-8000-0000000000e1'),
          toBrandedId('00000000-0000-4000-8000-0000000000e2'),
        ),
      /identity mismatch/,
    );
  });

  it('accepts a match', () => {
    assert.doesNotThrow(() =>
      assertSpecimenPatientMatches(
        toBrandedId('00000000-0000-4000-8000-0000000000e1'),
        toBrandedId('00000000-0000-4000-8000-0000000000e1'),
      ),
    );
  });
});
