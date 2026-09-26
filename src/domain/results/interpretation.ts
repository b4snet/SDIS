/**
 * SDIS interpretation contract — a human/device/algorithm reading of observations.
 *
 * The INTERPRETATION SOURCE is preserved and is never collapsed into a generic
 * "verified by" field. A device-generated interpretation is distinct from a human
 * one; both are distinct from human verification (see audit).
 */

import type { InterpretationId, OrderItemId } from '../../types/ids';
import type { DataSource } from '../../types/provenance';

export interface Interpretation {
  readonly id: InterpretationId;
  readonly orderItemId: OrderItemId;
  /** Who/what produced the interpretation: human, device, algorithm, integration. */
  readonly source: DataSource;
  readonly text: string;
  readonly at: string;
}
