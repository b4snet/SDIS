/**
 * SDIS external-reference boundary — shared vocabulary.
 *
 * Hospital/interoperability identities (HMS MRN, national ID where legally
 * applicable, enterprise identifiers) attach to SDIS entities as EXTERNAL
 * REFERENCES. They never become a second identity source and no HMS database is
 * embedded in SDIS.
 */

import type { FacilityId } from './ids';

export type ExternalSystemName =
  'HOSPITAL_MRN' | 'NATIONAL_ID' | 'ENTERPRISE' | 'EXTERNAL' | (string & {});

export interface ExternalPatientReference {
  readonly system: ExternalSystemName;
  readonly value: string;
  /** The facility that issued the reference (scope for uniqueness). */
  readonly facilityId: FacilityId;
}
