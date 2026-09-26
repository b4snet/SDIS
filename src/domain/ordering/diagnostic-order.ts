/**
 * SDIS diagnostic ordering contract.
 *
 * Lifecycle: ORDERED → ACQUIRED → PROCESSING → RESULT ENTERED → VERIFIED →
 * FINALIZED → REPORTED. Transitions are enforced; finalized results are never
 * silently overwritten (see results/report.ts for versioning).
 *
 * An order requires the patient and an explicit facility context.
 */

import type {
  DiagnosticOrderId,
  EncounterId,
  FacilityId,
  OrderItemId,
  PatientId,
} from '../../types/ids';
import type { ModalityName } from '../../types/modality';

export type DiagnosticOrderStatus =
  | 'ORDERED'
  | 'ACQUIRED'
  | 'PROCESSING'
  | 'RESULT_ENTERED'
  | 'VERIFIED'
  | 'FINALIZED'
  | 'REPORTED'
  | 'CANCELLED';

export const ORDER_LIFECYCLE: readonly DiagnosticOrderStatus[] = [
  'ORDERED',
  'ACQUIRED',
  'PROCESSING',
  'RESULT_ENTERED',
  'VERIFIED',
  'FINALIZED',
  'REPORTED',
] as const;

const ALLOWED_TRANSITIONS: Readonly<
  Record<DiagnosticOrderStatus, readonly DiagnosticOrderStatus[]>
> = {
  ORDERED: ['ACQUIRED', 'CANCELLED'],
  ACQUIRED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['RESULT_ENTERED', 'CANCELLED'],
  RESULT_ENTERED: ['VERIFIED'],
  VERIFIED: ['FINALIZED'],
  FINALIZED: ['REPORTED'],
  REPORTED: [],
  CANCELLED: [],
};

export class InvalidOrderTransitionError extends Error {
  constructor(from: DiagnosticOrderStatus, to: DiagnosticOrderStatus) {
    super(`Invalid diagnostic-order transition: ${from} → ${to}`);
    this.name = 'InvalidOrderTransitionError';
  }
}

export function transitionOrderStatus(
  from: DiagnosticOrderStatus,
  to: DiagnosticOrderStatus,
): DiagnosticOrderStatus {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new InvalidOrderTransitionError(from, to);
  }
  return to;
}

/**
 * Workflow priority vocabulary (Step 21) — OPERATIONAL urgency only.
 *
 * Priority describes how the WORK is expedited; it is never a clinical
 * concept: not a diagnosis, not a result, not a critical-value determination,
 * and not a recommendation. An emergency-priority order produces observations,
 * interpretations, and reports with exactly the same clinical meaning as a
 * routine one. Critical RESULTS are a separate, clinically-defined policy
 * domain and are deliberately NOT modeled here.
 */
export type DiagnosticOrderPriority = 'ROUTINE' | 'URGENT' | 'EMERGENCY';

export const ORDER_PRIORITIES: readonly DiagnosticOrderPriority[] = [
  'ROUTINE',
  'URGENT',
  'EMERGENCY',
] as const;

/** Every order has a priority; unstated means routine. */
export const DEFAULT_ORDER_PRIORITY: DiagnosticOrderPriority = 'ROUTINE';

/** Operational queue weight: lower sorts first (deterministic worklist order). */
export const PRIORITY_RANK: Readonly<Record<DiagnosticOrderPriority, number>> = {
  EMERGENCY: 0,
  URGENT: 1,
  ROUTINE: 2,
};

/** Validates client-supplied priority against the bounded vocabulary. */
export function assertOrderPriority(value: string): DiagnosticOrderPriority {
  if (!(ORDER_PRIORITIES as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown order priority "${value}" (expected ROUTINE, URGENT, or EMERGENCY)`,
    );
  }
  return value as DiagnosticOrderPriority;
}

/**
 * Priority changes are unconstrained operationally EXCEPT that a cancelled
 * order is closed — its workflow is over and its priority is historical.
 */
export function canChangePriority(order: DiagnosticOrder): boolean {
  return order.status !== 'CANCELLED';
}

export interface OrderItem {
  readonly id: OrderItemId;
  readonly orderId: DiagnosticOrderId;
  /** Canonical test/procedure code (see terminology contracts). */
  readonly testCode: string;
  readonly codeSystem: string;
}

export interface DiagnosticOrder {
  readonly id: DiagnosticOrderId;
  readonly patientId: PatientId;
  readonly encounterId: EncounterId;
  readonly facilityId: FacilityId;
  readonly modality: ModalityName;
  readonly status: DiagnosticOrderStatus;
  /** Operational workflow priority (Step 21) — never a clinical attribute. */
  readonly priority: DiagnosticOrderPriority;
  readonly orderedAt: string;
  readonly orderedByRef: string;
  readonly items: readonly OrderItem[];
  /**
   * Verification attribution (Step 28): who verified the diagnostic content
   * (RESULT_ENTERED → VERIFIED). Present once verified; immutable afterwards
   * (later transitions never rewrite it).
   */
  readonly verifiedByRef?: string;
  readonly verifiedAt?: string;
  /**
   * Optimistic-concurrency version (LAB-02): the version the caller read. The
   * PG repository refuses a save whose version does not match the persisted
   * row (`UPDATE … WHERE version = $prev`) — a concurrent transition loses
   * with CONFLICT instead of silently overwriting. Created aggregates start at
   * 1; transitions carry the read value forward via object spread.
   */
  readonly version: number;
}
