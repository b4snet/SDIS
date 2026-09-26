/**
 * SDIS interpretation application service.
 *
 * An interpretation is a reading of observations produced by an EXPLICIT,
 * preserved source: human, device, algorithm, integration, or system
 * (docs/AUDIT_PROVENANCE.md §2). A machine-generated interpretation is never
 * relabeled as human, and this service never implies human verification.
 */

import { randomUUID } from 'node:crypto';
import type { Interpretation } from '../../domain/results/interpretation';
import { PROVENANCE_SOURCE_KINDS } from '../../types/provenance';
import type { InterpretationId, OrderItemId } from '../../types/ids';
import type { DataSource } from '../../types/provenance';
import { AuditRecorder } from '../audit';
import { requireSession, type ApplicationSession } from '../context';
import { toInterpretationDTO, type InterpretationDTO } from '../dto';
import { ValidationError } from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import type { AuditPort, IdempotencyStore, InterpretationRepository } from '../ports';
import { type OrderService } from './order-service';

export interface AddInterpretationInput {
  readonly orderItemId: OrderItemId;
  /** Explicit source — never inferred, never collapsed. */
  readonly source: DataSource;
  readonly text: string;
  readonly at: string;
  readonly idempotencyKey?: string;
}

export interface InterpretationServiceDependencies {
  readonly orders: OrderService;
  readonly interpretations: InterpretationRepository;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  /** The ONE authorization engine (fail-closed when absent). */
  readonly authz?: AuthorizationService;
}

export class InterpretationService {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: InterpretationServiceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /**
   * Attaches a reading of observations to an order item, preserving the exact
   * source. Structural checks only — no clinical interpretation rules exist in
   * SDIS (REQUIRES AUTHORITATIVE CLINICAL DEFINITION, docs/CLINICAL_SAFETY.md).
   */
  async addInterpretation(
    session: ApplicationSession | undefined,
    input: AddInterpretationInput,
  ): Promise<InterpretationDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.OBSERVATION_CREATE);
    if (!input.source || !PROVENANCE_SOURCE_KINDS.includes(input.source.kind)) {
      throw new ValidationError(
        `Invalid interpretation source kind "${input.source?.kind}"`,
      );
    }
    if (!input.text || !input.text.trim()) {
      throw new ValidationError('An interpretation requires text');
    }
    if (!input.at) {
      throw new ValidationError('An interpretation requires a timestamp');
    }
    await this.deps.orders.requireScopedOrderByItem(session, input.orderItemId);

    const interpretation = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.INTERPRETATION_CREATE,
      input.idempotencyKey,
      () => this.addWithAudit(session, input),
      session,
    );
    return toInterpretationDTO(interpretation);
  }

  private async addWithAudit(
    session: ApplicationSession,
    input: AddInterpretationInput,
  ): Promise<Interpretation> {
    const interpretation: Interpretation = {
      id: randomUUID() as InterpretationId,
      orderItemId: input.orderItemId,
      source: input.source,
      text: input.text,
      at: input.at,
    };
    await this.deps.interpretations.save(interpretation);
    await this.audit.record(session, {
      action: 'CREATED',
      objectType: 'interpretation',
      objectId: interpretation.id,
      at: input.at,
      source: input.source,
    });
    return interpretation;
  }

  /** Read view for the caller scope (IDOR-resistant). */
  async listForOrderItem(
    session: ApplicationSession | undefined,
    orderItemId: OrderItemId,
  ): Promise<readonly InterpretationDTO[]> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.OBSERVATION_READ);
    await this.deps.orders.requireScopedOrderByItem(session, orderItemId);
    const interpretations = await this.deps.interpretations.listByOrderItem(orderItemId);
    return interpretations.map(toInterpretationDTO);
  }
}
