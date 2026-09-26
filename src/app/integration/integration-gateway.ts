/**
 * SDIS integration gateway — the boundary for external systems (Step 17).
 *
 * Flow, and ONLY this flow:
 *
 *   external system → IntegrationAdapter (normalization) → CanonicalCommand
 *                   → IntegrationGateway → EXISTING application services
 *                   → canonical response → IntegrationAdapter (acknowledgement)
 *
 * External systems never reach the database, never bypass patient identity,
 * tenant/facility scope, RBAC, provenance, audit, idempotency, or the clinical
 * lifecycle rules — every mutation goes through the SAME application services
 * that serve the SDIS UI, with the ONE authorization engine and the ONE
 * idempotency engine.
 *
 * Provenance: externally initiated mutations are recorded with the existing
 * `INTEGRATION` provenance source kind (never collapsed into HUMAN/SYSTEM).
 * An adapter that declares any other source kind is rejected — the gateway
 * cannot be used to forge human or device authorship.
 *
 * Audit: inbound mutations emit `IMPORTED` and outbound clinical retrieval
 * emits `EXPORTED`, both through the existing append-only recorder, on the
 * existing `integration-request` object type. Audit detail carries the
 * external SYSTEM name and the correlation id — never payloads, never
 * external reference VALUES (PHI-adjacent by the repository's own convention).
 *
 * Standards: this is a standards-READY boundary only. No FHIR, HL7 v2,
 * DICOM/DICOMweb, IHE, or ATNA message schema is defined or claimed here.
 */

import type { DataSource, ProvenanceSourceKind } from '../../types/provenance';
import type { OrderDTO, ObservationDTO, InterpretationDTO, SpecimenDTO } from '../dto';
import type { ReportDTO } from '../dto';
import { AuditRecorder } from '../audit';
import {
  assertSessionFacility,
  requireSession,
  type ApplicationSession,
} from '../context';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import type { AuditPort, IdempotencyStore } from '../ports';
import type { ExternalPatientReference } from '../../types/external-reference';
import type {
  EncounterId,
  FacilityId,
  DiagnosticOrderId,
  OrderItemId,
  PatientId,
  ReportId,
} from '../../types/ids';
import type { ObservationValue } from '../../domain/results/observation';

/** Operations this gateway foundation supports (nothing more). */
export const INTEGRATION_OPERATIONS = [
  'RESOLVE_PATIENT',
  'REGISTER_PATIENT',
  'ATTACH_PATIENT_REFERENCE',
  'SUBMIT_ORDER',
  'ORDER_STATUS',
  'FETCH_REPORT',
  /** Step 20: canonical inbound result (external result → observation). */
  'INBOUND_RESULT',
  /** Step 21: operational priority change through the SAME order service. */
  'CHANGE_ORDER_PRIORITY',
  /** Step 20: outbound correlation lookup (external order id → canonical). */
  'ORDER_EXISTS',
] as const;

export type IntegrationOperation = (typeof INTEGRATION_OPERATIONS)[number];

/** Raw external payload — shape is the ADAPTER's concern, never the gateway's. */
export type IntegrationPayload = Record<string, unknown>;

/**
 * Formal identity of a registered external system (Step 20). An external
 * system is NEITHER a human principal NOR an SDIS patient: it is an
 * integration counterpart. `configRef` is a NON-SECRET configuration
 * reference only — credentials are out of scope (documented future
 * dependency), so no secret value may ever be placed here.
 */
export interface ExternalSystemRecord {
  /** Stable public key used in integration envelopes, e.g. `HMS-SYNTHETIC`. */
  readonly systemKey: string;
  /** Human-readable name (audit/metadata only). */
  readonly name: string;
  /** Coarse system class. */
  readonly systemType: 'HMS' | 'LABORATORY' | 'STANDARDS' | 'TEST' | 'OTHER';
  /** Owning organization (tenant scope). */
  readonly organizationId?: string;
  /** Primary facility when the system is facility-bound. */
  readonly facilityId?: string;
  /** Operational switch: the gateway refuses non-ACTIVE systems. */
  readonly status: 'ACTIVE' | 'DISABLED';
  /** Non-secret configuration reference (e.g. a setup-config id). */
  readonly configRef?: string;
}

/**
 * Registration port the gateway consults BEFORE any payload is normalized.
 * Fail-closed: an unknown or disabled system must resolve to `undefined` /
 * `DISABLED` and the gateway then refuses the request without disclosing
 * which systems are registered.
 */
export interface ExternalSystemRegistry {
  find(systemKey: string): Promise<ExternalSystemRecord | undefined>;
}

/**
 * An external reference as supplied by a connector: system + value ONLY. The
 * facility that scopes the reference is always derived from the authenticated
 * session — an adapter can never assert its own scope.
 */
export interface ExternalReferenceInput {
  readonly system: string;
  readonly value: string;
}

/**
 * Canonical SDIS commands. External payloads never become the domain model:
 * an adapter normalizes into exactly one of these.
 */
export type CanonicalCommand =
  | { readonly command: 'RESOLVE_PATIENT'; readonly reference: ExternalReferenceInput }
  | {
      readonly command: 'REGISTER_PATIENT';
      readonly fullName: string;
      readonly sex: string;
      readonly birthDate?: string;
      readonly externalReferences: readonly {
        readonly system: string;
        readonly value: string;
      }[];
    }
  | {
      readonly command: 'ATTACH_PATIENT_REFERENCE';
      readonly patientId: PatientId;
      readonly reference: ExternalReferenceInput;
    }
  | {
      readonly command: 'SUBMIT_ORDER';
      readonly patientId: PatientId;
      readonly encounterId: EncounterId;
      readonly modality: string;
      readonly items: readonly {
        readonly testCode: string;
        readonly codeSystem: string;
      }[];
      readonly orderedAt: string;
      /** Caller's own order identity — echoed back, never a second order id. */
      readonly externalOrderRef?: string;
    }
  | { readonly command: 'ORDER_STATUS'; readonly orderId: string }
  /**
   * Outbound correlation lookup (Step 20): resolve an external system's own
   * order identifier to the canonical SDIS order. The external value is the
   * LOOKUP KEY only — canonical identity is never replaced.
   */
  | { readonly command: 'ORDER_EXISTS'; readonly externalOrderRef: string }
  /**
   * Operational priority change (Step 21): expedited handling through the
   * EXISTING order service — vocabulary, scope, audit, and idempotency are
   * enforced there. Never a clinical determination.
   */
  | {
      readonly command: 'CHANGE_ORDER_PRIORITY';
      readonly orderId: string;
      readonly priority: string;
      readonly at: string;
    }
  | { readonly command: 'FETCH_REPORT'; readonly reportId: ReportId }
  /**
   * Inbound result boundary (Step 20): a mapped external result becomes a
   * canonical OBSERVATION through the existing observation service. The
   * observation service retains full lifecycle/scope/provenance control —
   * the gateway only normalizes the payload and records INTEGRATION
   * provenance. Never a second result model; never report interpretation.
   */
  | {
      readonly command: 'INBOUND_RESULT';
      readonly orderItemId: string;
      readonly patientId: string;
      readonly specimenId?: string;
      readonly code: string;
      readonly codeSystem: string;
      readonly value: ObservationValue;
      readonly unit?: string;
      readonly at: string;
    };

export type IntegrationOutcome = 'RESOLVED' | 'CREATED' | 'RETRIEVED';

/** Canonical response + external-facing acknowledgement. */
export interface IntegrationAcknowledgement {
  readonly system: string;
  readonly operation: IntegrationOperation;
  readonly outcome: IntegrationOutcome;
  readonly correlationId?: string;
  /** Echoed external reference for correlation (never a clinical identifier). */
  readonly externalReference?: string;
  /** Canonical SDIS DTO — never a database row or domain internal. */
  readonly resource: unknown;
}

export interface IntegrationEnvelope {
  /** External system identity (must be registered with the gateway). */
  readonly system: string;
  readonly operation: IntegrationOperation;
  readonly payload: IntegrationPayload;
  /** Optional correlation identifier supplied by the external system. */
  readonly correlationId?: string;
  /** Optional keyed retry identity for the whole external request. */
  readonly idempotencyKey?: string;
}

/**
 * Adapter port: one implementation per external system. Adapters normalize
 * inbound payloads and shape acknowledgements; they hold NO business rules and
 * never touch repositories or the database.
 */
export interface IntegrationAdapter {
  /** Stable external system identity, e.g. `HMS-SYNTHETIC`. */
  readonly system: string;
  /** Provenance label recorded for this system's actions. */
  readonly label: string;
  /** Provenance reference (integration id/URL) recorded when present. */
  readonly ref?: string;
  /**
   * The provenance source kind this adapter may claim. MUST be `INTEGRATION`;
   * anything else is refused by the gateway.
   */
  readonly sourceKind: ProvenanceSourceKind;
  /** Normalizes one operation payload into a canonical command. */
  normalize(
    operation: IntegrationOperation,
    payload: IntegrationPayload,
  ): CanonicalCommand;
  /** Maps a canonical response onto the external acknowledgement. */
  acknowledge(params: {
    readonly operation: IntegrationOperation;
    readonly outcome: IntegrationOutcome;
    readonly command: CanonicalCommand;
    readonly resource: unknown;
    readonly correlationId?: string;
  }): IntegrationAcknowledgement;
}

/** Registry of known external systems (fail-closed when absent). */
export interface IntegrationAdapterRegistry {
  find(system: string): IntegrationAdapter | undefined;
}

/**
 * Static registry: only explicitly registered systems are reachable. Kept in
 * the application layer (like the repository's other in-memory adapters) so
 * that composition can wire the gateway without importing a concrete
 * connector; real connectors live at the infrastructure edge.
 */
export class StaticIntegrationRegistry implements IntegrationAdapterRegistry {
  private readonly adapters = new Map<string, IntegrationAdapter>();

  constructor(adapters: readonly IntegrationAdapter[] = []) {
    for (const adapter of adapters) this.adapters.set(adapter.system, adapter);
  }

  register(adapter: IntegrationAdapter): void {
    this.adapters.set(adapter.system, adapter);
  }

  find(system: string): IntegrationAdapter | undefined {
    return this.adapters.get(system);
  }
}

/**
 * The production default: NO external system is registered, so the gateway
 * refuses every request until an authorized integration is wired in.
 */
export function emptyIntegrationRegistry(): StaticIntegrationRegistry {
  return new StaticIntegrationRegistry([]);
}

export interface IntegrationGatewayDependencies {
  readonly adapters: IntegrationAdapterRegistry;
  /** The EXISTING application services — no business rules are re-implemented. */
  readonly patients: import('../patients/patient-service').PatientService;
  readonly orders: import('../laboratory/order-service').OrderService;
  readonly observations: import('../laboratory/observation-service').ObservationService;
  readonly interpretations: import('../laboratory/interpretation-service').InterpretationService;
  readonly reports: import('../laboratory/report-service').ReportService;
  readonly specimens: {
    listByOrderItem(orderItemId: OrderItemId): Promise<readonly SpecimenDTO[]>;
  };
  /** External-reference lookup (patient identity stays canonical). */
  readonly patientReferences: {
    findPatientIdByExternalReference(
      ref: ExternalPatientReference,
    ): Promise<PatientId | undefined>;
  };
  /**
   * Registered external systems (Step 20). Fail-closed: an unknown or
   * disabled system is refused before any payload is normalized.
   */
  readonly systemRegistry: ExternalSystemRegistry;
  /**
   * External order-reference correlation store. A missing store means order
   * external references are echoed but not persisted (the Step-17 shape).
   */
  readonly orderReferences?: {
    record(params: {
      systemKey: string;
      externalRef: string;
      orderId: DiagnosticOrderId;
      facilityId: FacilityId;
      correlationId?: string;
    }): Promise<void>;
    findOrderId(
      systemKey: string,
      externalRef: string,
    ): Promise<DiagnosticOrderId | undefined>;
  };
  readonly facilities: import('../ports').FacilityDirectory;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
}

/** The outbound payload for report retrieval — nothing is flattened. */
export interface IntegrationReportBundle {
  readonly order: OrderDTO;
  readonly specimens: readonly SpecimenDTO[];
  readonly observations: readonly ObservationDTO[];
  readonly interpretations: readonly InterpretationDTO[];
  /** Report versioning and amendments are preserved verbatim. */
  readonly report: ReportDTO;
}

const MAX_CORRELATION_LENGTH = 128;

export class IntegrationGateway {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: IntegrationGatewayDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /**
   * Single entry point for an external request. Fail-closed: unauthenticated,
   * unregistered system, forged scope, or an adapter claiming non-integration
   * provenance all refuse before touching any SDIS data.
   *
   * The whole keyed request is idempotent at this level as well, so a retry
   * cannot emit a duplicate audit event.
   */
  async handle(
    session: ApplicationSession | undefined,
    envelope: IntegrationEnvelope,
  ): Promise<IntegrationAcknowledgement> {
    requireSession(session);
    await assertSessionFacility(session, this.deps.facilities);
    if (
      !envelope ||
      typeof envelope.system !== 'string' ||
      envelope.system.length === 0
    ) {
      throw new ValidationError('An integration request requires an external system');
    }
    if (!INTEGRATION_OPERATIONS.includes(envelope.operation)) {
      throw new ValidationError('Unsupported integration operation');
    }
    // Registered-system enforcement (Step 20): the adapter list alone is no
    // longer the authority — a system must ALSO be registered, and active,
    // before any payload is normalized. Fail-closed and non-disclosing.
    const registered = await this.deps.systemRegistry.find(envelope.system);
    if (!registered || registered.status !== 'ACTIVE') {
      throw new ForbiddenError('External system is not registered for integration');
    }
    if (!envelope.payload || typeof envelope.payload !== 'object') {
      throw new ValidationError('An integration request requires a payload object');
    }
    if (
      envelope.correlationId !== undefined &&
      (typeof envelope.correlationId !== 'string' ||
        envelope.correlationId.length === 0 ||
        envelope.correlationId.length > MAX_CORRELATION_LENGTH)
    ) {
      throw new ValidationError('correlationId must be 1-128 characters when provided');
    }
    const adapter = this.deps.adapters.find(envelope.system);
    if (!adapter) {
      // Fail closed without disclosing which systems are registered.
      throw new ForbiddenError('External system is not registered for integration');
    }
    if (adapter.sourceKind !== 'INTEGRATION') {
      throw new ValidationError(
        'An integration adapter must record INTEGRATION provenance',
      );
    }
    // Normalization belongs to the adapter; failures surface as 422.
    const command = adapter.normalize(envelope.operation, envelope.payload);
    if (command.command !== envelope.operation) {
      throw new ValidationError(
        'Adapter normalized the request to a different operation',
      );
    }

    const mutate = async (): Promise<IntegrationAcknowledgement> =>
      adapter.acknowledge({
        operation: envelope.operation,
        ...(await this.execute(session, adapter, command, envelope)),
      });
    const acknowledgement =
      command.command === 'RESOLVE_PATIENT' ||
      command.command === 'ORDER_STATUS' ||
      command.command === 'ORDER_EXISTS'
        ? await mutate()
        : await runIdempotent(
            this.deps.idempotency,
            IDEMPOTENCY_SCOPES.INTEGRATION_REQUEST,
            envelope.idempotencyKey,
            mutate,
            session,
          );
    return acknowledgement;
  }

  private async execute(
    session: ApplicationSession,
    adapter: IntegrationAdapter,
    command: CanonicalCommand,
    envelope: IntegrationEnvelope,
  ): Promise<{
    readonly outcome: IntegrationOutcome;
    readonly command: CanonicalCommand;
    readonly resource: unknown;
    readonly correlationId?: string;
  }> {
    const correlationId = envelope.correlationId;
    const source = integrationSource(adapter);
    switch (command.command) {
      case 'RESOLVE_PATIENT': {
        const patientId =
          await this.deps.patientReferences.findPatientIdByExternalReference({
            ...command.reference,
            // Scope is server-derived: never accepted from the external system.
            facilityId: session.facilityId,
          });
        if (patientId === undefined) {
          throw new NotFoundError('No patient matches the external reference');
        }
        // Scope is enforced by the owning service (IDOR-resistant).
        const patient = await this.deps.patients.getPatient(session, patientId);
        return {
          outcome: 'RESOLVED',
          command,
          resource: patient,
          ...(correlationId ? { correlationId } : {}),
        };
      }
      case 'REGISTER_PATIENT': {
        const patient = await this.deps.patients.registerPatient(session, {
          fullName: command.fullName,
          sex: command.sex as never,
          ...(command.birthDate ? { birthDate: command.birthDate } : {}),
          externalReferences: command.externalReferences,
          source,
          ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
        });
        await this.recordIntegrationEvent(
          session,
          'IMPORTED',
          adapter,
          command,
          patient.id,
          correlationId,
        );
        return {
          outcome: 'CREATED',
          command,
          resource: patient,
          ...(correlationId ? { correlationId } : {}),
        };
      }
      case 'ATTACH_PATIENT_REFERENCE': {
        const patient = await this.deps.patients.attachExternalIdentifier(session, {
          patientId: command.patientId,
          system: command.reference.system,
          value: command.reference.value,
          source,
          ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
        });
        await this.recordIntegrationEvent(
          session,
          'IMPORTED',
          adapter,
          command,
          patient.id,
          correlationId,
        );
        return {
          outcome: 'CREATED',
          command,
          resource: patient,
          ...(correlationId ? { correlationId } : {}),
        };
      }
      case 'SUBMIT_ORDER': {
        // The order service enforces patient/encounter scope, modality
        // validity, and the order lifecycle — nothing is bypassed here.
        const order = await this.deps.orders.createOrder(session, {
          patientId: command.patientId,
          encounterId: command.encounterId,
          modality: command.modality as never,
          items: command.items,
          orderedAt: command.orderedAt,
          source,
          ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
        });
        // External order-reference correlation (Step 20): the caller's own
        // order id is preserved alongside the canonical order — never instead
        // of it. A CONFLICTING mapping (same external ref under this system
        // already pointing at a DIFFERENT order) fails safely; the identical
        // mapping (idempotent replay) is accepted silently.
        if (command.externalOrderRef && this.deps.orderReferences) {
          const existing = await this.deps.orderReferences.findOrderId(
            adapter.system,
            command.externalOrderRef,
          );
          if (existing !== undefined && existing !== order.id) {
            throw new ConflictError(
              'External order reference is already mapped to a different order',
            );
          }
          if (existing === undefined) {
            await this.deps.orderReferences.record({
              systemKey: adapter.system,
              externalRef: command.externalOrderRef,
              orderId: order.id as DiagnosticOrderId,
              facilityId: session.facilityId,
              ...(correlationId ? { correlationId } : {}),
            });
          }
        }
        await this.recordIntegrationEvent(
          session,
          'IMPORTED',
          adapter,
          command,
          order.id,
          correlationId,
        );
        return {
          outcome: 'CREATED',
          command,
          resource: order,
          ...(correlationId ? { correlationId } : {}),
        };
      }
      case 'ORDER_STATUS': {
        const order = await this.deps.orders.getOrder(session, command.orderId as never);
        return {
          outcome: 'RESOLVED',
          command,
          resource: order,
          ...(correlationId ? { correlationId } : {}),
        };
      }
      case 'ORDER_EXISTS': {
        // Outbound correlation: external order id → canonical order id under
        // the caller's facility scope. Unknown reference → 404; the external
        // value never becomes an SDIS identity.
        if (!this.deps.orderReferences) {
          throw new ValidationError(
            'External order-reference correlation is not configured for this runtime',
          );
        }
        const orderId = await this.deps.orderReferences.findOrderId(
          adapter.system,
          command.externalOrderRef,
        );
        if (orderId === undefined) {
          throw new NotFoundError('No order is mapped to the external order reference');
        }
        const order = await this.deps.orders.getOrder(session, orderId as never);
        return {
          outcome: 'RESOLVED',
          command,
          resource: mapExternalOrder(order, {
            systemKey: adapter.system,
            externalOrderRef: command.externalOrderRef,
          }),
          ...(correlationId ? { correlationId } : {}),
        };
      }
      case 'FETCH_REPORT': {
        const bundle = await this.buildReportBundle(session, command.reportId);
        await this.recordIntegrationEvent(
          session,
          'EXPORTED',
          adapter,
          command,
          bundle.report.id,
          correlationId,
        );
        return {
          outcome: 'RETRIEVED',
          command,
          resource: bundle,
          ...(correlationId ? { correlationId } : {}),
        };
      }
      case 'INBOUND_RESULT': {
        // Inbound result boundary (Step 20): the EXISTING observation service
        // enforces order-item scope, patient consistency, specimen binding,
        // and its own idempotency — the gateway never re-implements those
        // rules and never writes clinical records directly. Provenance is
        // INTEGRATION (the adapter), never a clinical authorship claim.
        const observation = await this.deps.observations.enterObservation(session, {
          orderItemId: command.orderItemId as never,
          patientId: command.patientId as never,
          ...(command.specimenId ? { specimenId: command.specimenId as never } : {}),
          code: command.code,
          codeSystem: command.codeSystem,
          value: command.value,
          ...(command.unit ? { unit: command.unit } : {}),
          issuedBy: source,
          at: command.at,
          ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
        });
        await this.recordIntegrationEvent(
          session,
          'IMPORTED',
          adapter,
          command,
          observation.id,
          correlationId,
        );
        return {
          outcome: 'CREATED',
          command,
          resource: observation,
          ...(correlationId ? { correlationId } : {}),
        };
      }
      case 'CHANGE_ORDER_PRIORITY': {
        // The order service owns the vocabulary, scope, audit detail, and
        // idempotency of a priority change; the gateway only routes. The
        // external envelope key drives idempotent replay of the request.
        const order = await this.deps.orders.changeOrderPriority(
          session,
          command.orderId as never,
          command.priority,
          command.at,
          envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {},
        );
        return {
          outcome: 'RESOLVED',
          command,
          resource: order,
          ...(correlationId ? { correlationId } : {}),
        };
      }
    }
  }

  /**
   * Assembles the outbound bundle from EXISTING services only. Retrieval never
   * mutates a clinical record, and Observation → Interpretation → Report stay
   * distinct — they are never flattened into one object.
   */
  private async buildReportBundle(
    session: ApplicationSession,
    reportId: ReportId,
  ): Promise<IntegrationReportBundle> {
    const report = await this.deps.reports.getReport(session, reportId);
    const order = await this.deps.orders.getOrder(session, report.orderId as never);
    const specimens: SpecimenDTO[] = [];
    const observations: ObservationDTO[] = [];
    const interpretations: InterpretationDTO[] = [];
    for (const item of order.items) {
      specimens.push(
        ...(await this.deps.specimens.listByOrderItem(item.id as OrderItemId)),
      );
      observations.push(
        ...(await this.deps.observations.listForOrderItem(
          session,
          item.id as OrderItemId,
        )),
      );
      interpretations.push(
        ...(await this.deps.interpretations.listForOrderItem(
          session,
          item.id as OrderItemId,
        )),
      );
    }
    return { order, specimens, observations, interpretations, report };
  }

  /**
   * One append-only audit event per external request. Detail is non-PHI:
   * system name and correlation id only — never a payload, never an external
   * reference VALUE.
   */
  private async recordIntegrationEvent(
    session: ApplicationSession,
    action: 'IMPORTED' | 'EXPORTED',
    adapter: IntegrationAdapter,
    command: CanonicalCommand,
    objectId: string,
    correlationId: string | undefined,
  ): Promise<void> {
    await this.audit.record(session, {
      action,
      objectType: 'integration-request',
      objectId,
      at: new Date().toISOString(),
      source: integrationSource(adapter),
      detail: `${adapter.system} ${command.command}${
        correlationId ? ` correlation=${correlationId}` : ''
      }`,
    });
  }
}

/** The provenance recorded for external-system actions (never HUMAN/SYSTEM). */
export function integrationSource(adapter: {
  readonly system: string;
  readonly label: string;
  readonly ref?: string;
}): DataSource {
  return {
    kind: 'INTEGRATION',
    label: adapter.label,
    ref: adapter.ref ?? adapter.system,
  };
}

/**
 * Outbound order representation (Step 20): the CANONICAL order DTO preserved
 * verbatim (status/lifecycle/items untouched), annotated with the external
 * system's own order identifier when one has been recorded. The canonical
 * id is never replaced, and nothing is flattened into a generic object.
 */
export function mapExternalOrder(
  order: OrderDTO,
  external?: { readonly systemKey: string; readonly externalOrderRef?: string },
): {
  readonly order: OrderDTO;
  readonly externalSystem?: string;
  readonly externalOrderRef?: string;
} {
  if (!external?.externalOrderRef) return { order };
  return {
    order,
    externalSystem: external.systemKey,
    externalOrderRef: external.externalOrderRef,
  };
}
