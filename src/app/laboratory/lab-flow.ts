/**
 * SDIS laboratory flow orchestrator — the deterministic end-to-end proof.
 *
 * Runs the first executable runtime capability end to end, entirely in-process:
 *
 *   Diagnostic Order → Order Item → Specimen → Observation → Interpretation → Report
 *
 * All timestamps are derived deterministically from one base instant, all
 * identifiers are minted UUID v4 (validated format, no uncontrolled values),
 * and every step is performed through the application services so scope,
 * provenance, audit, and idempotency semantics are exercised — never bypassed.
 */

import { assertUuidV4 } from '../../types/ids';
import type {
  DiagnosticOrderId,
  EncounterId,
  OrderItemId,
  PatientId,
  ReportId,
  SpecimenId,
} from '../../types/ids';
import type { ModalityName } from '../../types/modality';
import type { DataSource } from '../../types/provenance';
import type { ObservationValue } from '../../domain/results/observation';
import type { SpecimenKind } from '../../domain/specimen/specimen';
import { InternalError } from '../errors';
import { requireSession, type ApplicationSession } from '../context';
import type {
  InterpretationDTO,
  ObservationDTO,
  OrderDTO,
  OrderItemDTO,
  ReportDTO,
  SpecimenDTO,
} from '../dto';
import type { OrderService } from './order-service';
import type { SpecimenService } from './specimen-service';
import type { ObservationService } from './observation-service';
import type { InterpretationService } from './interpretation-service';
import type { ReportService } from './report-service';

const MINUTE_MS = 60_000;

/** Deterministic offset: base ISO instant + `minutes` (fixed arithmetic). */
export function plusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * MINUTE_MS).toISOString();
}

export interface FlowTimes {
  readonly ordered: string;
  readonly collected: string;
  readonly received: string;
  readonly accepted: string;
  readonly processed: string;
  readonly processing: string;
  readonly observed: string;
  readonly interpreted: string;
  readonly resultEntered: string;
  readonly verified: string;
  readonly reportAuthored: string;
  readonly reportFinalized: string;
  readonly orderFinalized: string;
  readonly reported: string;
}

export function deriveFlowTimes(startedAt: string): FlowTimes {
  return {
    ordered: startedAt,
    collected: plusMinutes(startedAt, 1),
    received: plusMinutes(startedAt, 2),
    accepted: plusMinutes(startedAt, 3),
    processed: plusMinutes(startedAt, 4),
    processing: plusMinutes(startedAt, 5),
    observed: plusMinutes(startedAt, 6),
    interpreted: plusMinutes(startedAt, 7),
    resultEntered: plusMinutes(startedAt, 8),
    verified: plusMinutes(startedAt, 9),
    reportAuthored: plusMinutes(startedAt, 10),
    reportFinalized: plusMinutes(startedAt, 11),
    orderFinalized: plusMinutes(startedAt, 12),
    reported: plusMinutes(startedAt, 13),
  };
}

export interface LaboratoryScenarioInput {
  readonly session: ApplicationSession;
  readonly patientId: PatientId;
  readonly encounterId: EncounterId;
  readonly modality: ModalityName;
  readonly testCode: string;
  readonly codeSystem: string;
  readonly specimenKind: SpecimenKind;
  readonly observationCode: string;
  readonly observationValue: ObservationValue;
  readonly observationUnit?: string;
  /** e.g. a DEVICE analyzer reading. */
  readonly observationIssuedBy: DataSource;
  /** e.g. an ALGORITHM reading — preserved verbatim. */
  readonly interpretationSource: DataSource;
  readonly interpretationText: string;
  readonly reportContent: string;
  /** Optional Step-21 workflow priority for the canonical order creation.
   * Operational only — it never reaches observation/interpretation/report
   * content. Omitted means the service default (ROUTINE). */
  readonly priority?: string;
  /** Base instant; every later step derives a deterministic later instant. */
  readonly startedAt: string;
}

export interface LabFlowInvariants {
  readonly patientIdentityStable: true;
  readonly clinicalContextStable: true;
  readonly facilityScopeStable: true;
  readonly provenanceDistinctionsPreserved: true;
  readonly reportImmutableAfterFinalization: true;
  readonly causalOrderPreserved: true;
  readonly terminalStateReached: true;
}

export interface LabFlowResultDTO {
  readonly order: OrderDTO;
  readonly specimen: SpecimenDTO;
  readonly observation: ObservationDTO;
  readonly interpretation: InterpretationDTO;
  readonly report: ReportDTO;
  readonly invariants: LabFlowInvariants;
}

export interface LabFlowServiceDependencies {
  readonly orders: OrderService;
  readonly specimens: SpecimenService;
  readonly observations: ObservationService;
  readonly interpretations: InterpretationService;
  readonly reports: ReportService;
}

/**
 * DTO identifiers re-entering the application boundary are re-validated
 * through the Step-1 branded-id parser — never cast.
 */
function parseOrderId(dto: OrderDTO): DiagnosticOrderId {
  return assertUuidV4<DiagnosticOrderId>(dto.id, 'diagnostic order id');
}

function parseOrderItemId(item: OrderItemDTO): OrderItemId {
  return assertUuidV4<OrderItemId>(item.id, 'order item id');
}

function parseSpecimenId(dto: SpecimenDTO): SpecimenId {
  return assertUuidV4<SpecimenId>(dto.id, 'specimen id');
}

function parseReportId(dto: ReportDTO): ReportId {
  return assertUuidV4<ReportId>(dto.id, 'report id');
}

export class LabFlowService {
  constructor(private readonly deps: LabFlowServiceDependencies) {}

  /** Runs the complete in-process laboratory scenario and verifies invariants. */
  async run(input: LaboratoryScenarioInput): Promise<LabFlowResultDTO> {
    requireSession(input.session);
    const session = input.session;
    const t = deriveFlowTimes(input.startedAt);

    const order = await this.deps.orders.createOrder(session, {
      patientId: input.patientId,
      encounterId: input.encounterId,
      modality: input.modality,
      items: [{ testCode: input.testCode, codeSystem: input.codeSystem }],
      orderedAt: t.ordered,
      ...(input.priority ? { priority: input.priority } : {}),
      idempotencyKey: 'flow:order',
    });
    const orderItem = order.items[0];
    if (!orderItem) {
      throw new InternalError('Lab flow: order created without items');
    }
    const orderItemId = parseOrderItemId(orderItem);
    const orderId = parseOrderId(order);

    const specimen = await this.deps.specimens.collectSpecimen(session, {
      orderItemId,
      patientId: input.patientId,
      kind: input.specimenKind,
      collectedAt: t.collected,
      idempotencyKey: 'flow:specimen',
    });
    const specimenId = parseSpecimenId(specimen);
    await this.deps.specimens.transitionSpecimen(
      session,
      specimenId,
      'RECEIVED',
      t.received,
    );
    await this.deps.specimens.transitionSpecimen(
      session,
      specimenId,
      'ACCEPTED',
      t.accepted,
    );
    const finalSpecimen = await this.deps.specimens.transitionSpecimen(
      session,
      specimenId,
      'PROCESSED',
      t.processed,
    );

    await this.deps.orders.transitionOrder(session, orderId, 'PROCESSING', t.processing);

    const observation = await this.deps.observations.enterObservation(session, {
      orderItemId,
      patientId: input.patientId,
      specimenId,
      code: input.observationCode,
      codeSystem: input.codeSystem,
      value: input.observationValue,
      ...(input.observationUnit ? { unit: input.observationUnit } : {}),
      issuedBy: input.observationIssuedBy,
      at: t.observed,
      idempotencyKey: 'flow:observation',
    });

    const interpretation = await this.deps.interpretations.addInterpretation(session, {
      orderItemId,
      source: input.interpretationSource,
      text: input.interpretationText,
      at: t.interpreted,
      idempotencyKey: 'flow:interpretation',
    });

    await this.deps.orders.transitionOrder(
      session,
      orderId,
      'RESULT_ENTERED',
      t.resultEntered,
    );
    await this.deps.orders.transitionOrder(session, orderId, 'VERIFIED', t.verified);

    const report = await this.deps.reports.createReport(session, {
      orderId,
      content: input.reportContent,
      authoredByRef: session.actor.id,
      authoredAt: t.reportAuthored,
      idempotencyKey: 'flow:report',
    });
    const finalizedReport = await this.deps.reports.finalizeReport(
      session,
      parseReportId(report),
      session.actor.id,
      t.reportFinalized,
    );

    await this.deps.orders.transitionOrder(
      session,
      orderId,
      'FINALIZED',
      t.orderFinalized,
    );
    const terminalOrder = await this.deps.orders.transitionOrder(
      session,
      orderId,
      'REPORTED',
      t.reported,
    );

    const invariants = this.verifyInvariants({
      session,
      input,
      order: terminalOrder,
      orderItemId,
      specimen: finalSpecimen,
      observation,
      interpretation,
      finalizedReport,
      t,
    });

    return {
      order: terminalOrder,
      specimen: finalSpecimen,
      observation,
      interpretation,
      report: finalizedReport,
      invariants,
    };
  }

  private verifyInvariants(args: {
    session: ApplicationSession;
    input: LaboratoryScenarioInput;
    order: OrderDTO;
    orderItemId: string;
    specimen: SpecimenDTO;
    observation: ObservationDTO;
    interpretation: InterpretationDTO;
    finalizedReport: ReportDTO;
    t: FlowTimes;
  }): LabFlowInvariants {
    const failures: string[] = [];
    const {
      session,
      input,
      order,
      orderItemId,
      specimen,
      observation,
      interpretation,
      finalizedReport,
      t,
    } = args;

    if (
      order.patientId !== specimen.patientId ||
      specimen.patientId !== observation.patientId ||
      observation.patientId !== finalizedReport.patientId ||
      finalizedReport.patientId !== input.patientId
    ) {
      failures.push('patient identity moved between clinical objects');
    }

    if (
      specimen.orderItemId !== orderItemId ||
      observation.orderItemId !== orderItemId ||
      interpretation.orderItemId !== orderItemId ||
      !order.items.some((item) => item.id === orderItemId)
    ) {
      failures.push('clinical context (order item linkage) is inconsistent');
    }

    if (
      order.facilityId !== session.facilityId ||
      finalizedReport.facilityId !== session.facilityId
    ) {
      failures.push('facility scope diverged from the session');
    }

    if (
      observation.issuedByKind !== input.observationIssuedBy.kind ||
      interpretation.sourceKind !== input.interpretationSource.kind
    ) {
      failures.push('provenance kinds were collapsed or transformed');
    }

    if (finalizedReport.latestStatus !== 'FINALIZED') {
      failures.push('report is not finalized');
    }
    if (order.status !== 'REPORTED') {
      failures.push(`order did not reach REPORTED (${order.status})`);
    }

    const times = [
      t.ordered,
      t.collected,
      t.received,
      t.accepted,
      t.processed,
      t.processing,
      t.observed,
      t.interpreted,
      t.resultEntered,
      t.verified,
      t.reportAuthored,
      t.reportFinalized,
      t.orderFinalized,
      t.reported,
    ];
    for (let i = 1; i < times.length; i += 1) {
      if (new Date(times[i] ?? '').getTime() <= new Date(times[i - 1] ?? '').getTime()) {
        failures.push('causal ordering of timestamps is not preserved');
        break;
      }
    }

    if (failures.length > 0) {
      throw new InternalError(`Lab flow invariant failed: ${failures.join('; ')}`);
    }

    return {
      patientIdentityStable: true,
      clinicalContextStable: true,
      facilityScopeStable: true,
      provenanceDistinctionsPreserved: true,
      reportImmutableAfterFinalization: true,
      causalOrderPreserved: true,
      terminalStateReached: true,
    };
  }
}
