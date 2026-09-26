/**
 * SDIS observation contract — a measured or observed data point.
 *
 * Observation ≠ Interpretation ≠ Report. These aggregates are distinct.
 * An observation records what was measured and which source produced it.
 */

import type { ObservationId, OrderItemId, PatientId, SpecimenId } from '../../types/ids';
import type { DataSource } from '../../types/provenance';

export type ObservationValue =
  | { readonly kind: 'QUANTITATIVE'; readonly value: number }
  | { readonly kind: 'QUALITATIVE'; readonly text: string }
  | { readonly kind: 'CODED'; readonly code: string; readonly codeSystem: string }
  | { readonly kind: 'TEXT'; readonly text: string };

export interface Observation {
  readonly id: ObservationId;
  readonly orderItemId: OrderItemId;
  readonly patientId: PatientId;
  readonly specimenId?: SpecimenId;
  /** Canonical observation code (e.g. LOINC when mapped). */
  readonly code: string;
  readonly codeSystem: string;
  readonly value: ObservationValue;
  /** UCUM code when quantitative, e.g. "mg/dL". */
  readonly unit?: string;
  /** Which source produced the reading (device/human/integration...). */
  readonly issuedBy: DataSource;
  readonly at: string;
}

export function assertObservationBelongsToPatient(
  o: Observation,
  patientId: PatientId,
): void {
  if (o.patientId !== patientId) {
    throw new Error('Observation patient mismatch');
  }
}
