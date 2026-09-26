/**
 * SDIS terminology contracts.
 *
 * Internal canonical codes are mapped to external terminologies (LOINC, SNOMED CT,
 * UCUM, ICD, local codes). No licensed terminology data is bundled.
 *
 *   Internal canonical code  ↕  External terminology mapping
 */

import type { FacilityId, TerminologyMappingId } from '../../types/ids';

export interface CodeRef {
  readonly system: string;
  readonly code: string;
}

export const INTERNAL_CODE_SYSTEM = 'sdis';

export const KNOWN_EXTERNAL_SYSTEMS: readonly string[] = [
  'loinc',
  'snomed',
  'ucum',
  'icd10',
  'atc',
  'local',
] as const;

export interface TerminologyMapping {
  readonly id: TerminologyMappingId;
  readonly canonical: CodeRef;
  readonly external: CodeRef;
  /** Optional facility-specific override. */
  readonly facilityId?: FacilityId;
  /** Provenance of the mapping decision. */
  readonly validated: boolean;
}

export class TerminologyService {
  private readonly mappings: TerminologyMapping[] = [];

  addMapping(mapping: TerminologyMapping): void {
    if (mapping.canonical.system !== INTERNAL_CODE_SYSTEM) {
      throw new Error('Canonical code system must be the SDIS internal system');
    }
    if (!this.isKnownExternalSystem(mapping.external.system)) {
      throw new Error(`Unknown external code system "${mapping.external.system}"`);
    }
    this.mappings.push(mapping);
  }

  /** Resolve a canonical code to an external system; facility override wins. */
  resolveToExternal(
    canonical: CodeRef,
    targetSystem: string,
    facilityId?: FacilityId,
  ): CodeRef | undefined {
    const facilityMatch = this.mappings.find(
      (m) =>
        m.canonical.code === canonical.code &&
        m.external.system === targetSystem &&
        m.facilityId === facilityId,
    );
    if (facilityMatch) return facilityMatch.external;
    const globalMatch = this.mappings.find(
      (m) =>
        m.canonical.code === canonical.code &&
        m.external.system === targetSystem &&
        m.facilityId === undefined,
    );
    return globalMatch?.external;
  }

  private isKnownExternalSystem(system: string): boolean {
    return (KNOWN_EXTERNAL_SYSTEMS as readonly string[]).includes(system);
  }
}
