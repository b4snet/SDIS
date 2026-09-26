/**
 * SDIS provenance contracts.
 *
 * Provenance is the record of WHO (actor), WHERE the data came from (source),
 * WHEN it occurred (timestamp), and IN WHAT CONTEXT (organization/facility).
 *
 * Critical rule: HUMAN, DEVICE, ALGORITHM, INTEGRATION and SYSTEM sources are
 * distinct kinds and are NEVER collapsed into a single "verified by" concept.
 */

import type { FacilityContext } from './tenant';

/** Where data originated. Never collapse device/algorithm/human/integration/system. */
export type ProvenanceSourceKind =
  'HUMAN' | 'DEVICE' | 'ALGORITHM' | 'INTEGRATION' | 'SYSTEM';

export const PROVENANCE_SOURCE_KINDS: readonly ProvenanceSourceKind[] = [
  'HUMAN',
  'DEVICE',
  'ALGORITHM',
  'INTEGRATION',
  'SYSTEM',
] as const;

/**
 * Provenance/principal actor kinds. `PATIENT` (Step 22) is a first-class
 * principal for patient-facing ACCESS to records — it never authors clinical
 * content and is recorded in provenance/audit exactly like the other kinds,
 * never collapsed into SYSTEM.
 */
export interface Actor {
  readonly kind: 'USER' | 'PRACTITIONER' | 'SERVICE' | 'SYSTEM' | 'PATIENT';
  readonly id: string;
  readonly displayName?: string;
}

export interface DataSource {
  readonly kind: ProvenanceSourceKind;
  /** Free-form but non-empty label, e.g. "analyzer-model-XY", "web form", "FHIR feed v1". */
  readonly label: string;
  /** Optional reference (device id, integration id, URL). */
  readonly ref?: string;
}

export interface Provenance {
  readonly actor: Actor;
  readonly source: DataSource;
  /** ISO-8601 UTC timestamp of the action. */
  readonly timestamp: string;
  /** Organization/facility/department in which the action occurred. */
  readonly context: FacilityContext;
}

/** Provenance is only meaningful when all four facets are present. */
export function assertProvenanceComplete(p: Provenance): void {
  if (!p.actor || !p.actor.id) throw new Error('Provenance: actor is required');
  if (!p.source || !p.source.kind) throw new Error('Provenance: source is required');
  if (!p.timestamp) throw new Error('Provenance: timestamp is required');
  if (!p.context || !p.context.organizationId)
    throw new Error('Provenance: context is required');
}
