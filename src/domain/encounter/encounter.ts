/**
 * SDIS encounter / visit contract.
 *
 * Standalone mode: Patient → SDIS Registration → Encounter → Investigation.
 * Hospital-integrated mode: HMS Patient → Encounter → Diagnostic Order → SDIS.
 * An HMS reference attaches here as an external reference; the patient record is
 * never duplicated.
 */

import type { EncounterId, FacilityId, PatientId } from '../../types/ids';
import type { ExternalPatientReference } from '../../types/external-reference';

export interface Encounter {
  readonly id: EncounterId;
  readonly patientId: PatientId;
  readonly facilityId: FacilityId;
  /** When the patient arrived / the encounter began. */
  readonly startedAt: string;
  readonly endedAt?: string;
  /** Optional linkage to an external HMS encounter — never a duplicated identity. */
  readonly externalRef?: ExternalPatientReference;
}
