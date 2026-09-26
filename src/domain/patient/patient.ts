/**
 * SDIS patient identity contract — SINGLE source of identity.
 *
 * There is NO laboratory-specific patient table and NO second identity source.
 * External identifiers (hospital MRN, national ID where legally applicable,
 * enterprise identifiers) attach to the canonical patient as EXTERNAL REFERENCES;
 * they never become independent identities.
 */

import type { FacilityId, PatientId } from '../../types/ids';
import type { ExternalPatientReference } from '../../types/external-reference';

export type {
  ExternalPatientReference,
  ExternalSystemName,
} from '../../types/external-reference';

export interface Patient {
  readonly id: PatientId;
  /** Facility at which the patient was registered (primary affiliation). */
  readonly registeredAtFacilityId: FacilityId;
  readonly fullName: string;
  readonly sex: 'F' | 'M' | 'OTHER' | 'UNKNOWN';
  /** ISO-8601 calendar date, e.g. "1980-04-12". Optional when unknown. */
  readonly birthDate?: string;
  readonly externalReferences: readonly ExternalPatientReference[];
}

/**
 * Maintains patient identity. Duplicate identities are prevented by rejecting a
 * second patient that claims an already-registered external reference in the same
 * facility/system (a future duplicate-detection boundary).
 */
export class PatientIdentityService {
  private readonly patients = new Map<PatientId, Patient>();
  private readonly referenceIndex = new Map<string, PatientId>();

  createPatient(
    input: Omit<Patient, 'externalReferences'> & {
      externalReferences?: readonly ExternalPatientReference[];
    },
  ): Patient {
    for (const ref of input.externalReferences ?? []) {
      this.claimReference(ref, /* patientId */ undefined);
    }
    const patient: Patient = {
      ...input,
      externalReferences: Object.freeze([...(input.externalReferences ?? [])]),
    };
    // caller supplies a validated UUID; type-level branding guarantees shape
    this.patients.set(patient.id, patient);
    for (const ref of patient.externalReferences) {
      this.referenceIndex.set(this.refKey(ref), patient.id);
    }
    return patient;
  }

  /** Read-only lookup by canonical id (identity source remains singular). */
  findById(patientId: PatientId): Patient | undefined {
    return this.patients.get(patientId);
  }

  attachExternalReference(patientId: PatientId, ref: ExternalPatientReference): Patient {
    const patient = this.patients.get(patientId);
    if (!patient) throw new Error('Unknown patient');
    this.claimReference(ref, patientId);
    const updated: Patient = {
      ...patient,
      externalReferences: [...patient.externalReferences, Object.freeze(ref)],
    };
    this.patients.set(patientId, updated);
    this.referenceIndex.set(this.refKey(ref), patientId);
    return updated;
  }

  /** Resolve which patient (if any) already claims a reference. */
  findByExternalReference(ref: ExternalPatientReference): Patient | undefined {
    const id = this.referenceIndex.get(this.refKey(ref));
    return id === undefined ? undefined : this.patients.get(id);
  }

  private claimReference(
    ref: ExternalPatientReference,
    forPatientId: PatientId | undefined,
  ): void {
    const key = this.refKey(ref);
    const existing = this.referenceIndex.get(key);
    if (existing !== undefined && existing !== forPatientId) {
      throw new Error(
        `External reference ${ref.system}:${ref.value} is already claimed by another patient — possible duplicate identity`,
      );
    }
  }

  private refKey(ref: ExternalPatientReference): string {
    return `${ref.system.toUpperCase()}::${ref.facilityId}::${ref.value}`;
  }
}
