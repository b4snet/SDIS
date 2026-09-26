/**
 * SDIS application DTO boundary.
 *
 * Services return DTOs — never raw domain entities, repository records, or
 * internal audit structures. A DTO exposes exactly the fields required by the
 * application contract (docs/API_CONTRACTS.md §5) and intentionally omits
 * internal/audit/hidden identifiers.
 *
 * The provenance SOURCE KIND is always carried on observations and
 * interpretations so device/algorithm/human distinctions survive the boundary.
 */

import type { DiagnosticOrder, OrderItem } from '../domain/ordering/diagnostic-order';
import type { PatientId } from '../types/ids';
import type { ProvenanceSourceKind, DataSource } from '../types/provenance';
import type {
  DiagnosticReport,
  ReportStatus,
  ReportVersion,
} from '../domain/results/report';
import type { Specimen } from '../domain/specimen/specimen';
import type { Observation, ObservationValue } from '../domain/results/observation';
import type { Interpretation } from '../domain/results/interpretation';

export interface OrderItemDTO {
  readonly id: string;
  readonly testCode: string;
  readonly codeSystem: string;
}

export interface OrderDTO {
  readonly id: string;
  readonly patientId: PatientId;
  readonly encounterId: string;
  readonly facilityId: string;
  readonly modality: string;
  readonly status: string;
  /** Operational workflow priority (Step 21) — never a clinical attribute. */
  readonly priority: string;
  readonly orderedAt: string;
  readonly orderedByRef: string;
  readonly items: readonly OrderItemDTO[];
  /**
   * Verification attribution (Step 28): who verified the diagnostic content
   * and when — the server-resolved session actor, never a client field.
   */
  readonly verifiedByRef?: string;
  readonly verifiedAt?: string;
}

export interface SpecimenDTO {
  readonly id: string;
  readonly orderItemId: string;
  readonly patientId: PatientId;
  readonly kind: string;
  readonly status: string;
  readonly collectedAt: string;
  readonly collectedByRef: string;
  /** Laboratory accession number (Step 27), assigned at RECEIVED. */
  readonly accessionNumber?: string;
  /** Explicit exception reason when REJECTED (Step 27). */
  readonly rejectionReason?: string;
}

export interface ObservationDTO {
  readonly id: string;
  readonly orderItemId: string;
  readonly patientId: PatientId;
  readonly code: string;
  readonly codeSystem: string;
  readonly value: ObservationValue;
  readonly unit?: string;
  /** Provenance source preserved verbatim — never collapsed in the boundary. */
  readonly issuedByKind: ProvenanceSourceKind;
  readonly issuedByLabel: string;
  readonly issuedByRef?: string;
  readonly at: string;
}

export interface InterpretationDTO {
  readonly id: string;
  readonly orderItemId: string;
  /** Explicit source kind — a machine interpretation stays machine-identifiable. */
  readonly sourceKind: ProvenanceSourceKind;
  readonly sourceLabel: string;
  readonly sourceRef?: string;
  readonly text: string;
  readonly at: string;
}

export interface ReportVersionDTO {
  readonly id: string;
  readonly version: number;
  readonly status: ReportStatus;
  readonly content: string;
  readonly authoredByRef: string;
  readonly authoredAt: string;
  readonly finalizedAt?: string;
  readonly supersedesVersionId?: string;
  /** Bounded amendment vocabulary value (Step 28); present on amendments. */
  readonly amendmentReason?: string;
}

export interface ReportDTO {
  readonly id: string;
  readonly orderId: string;
  readonly patientId: PatientId;
  readonly facilityId: string;
  readonly latestStatus: ReportStatus;
  readonly latestVersion: number;
  readonly versions: readonly ReportVersionDTO[];
}

function sourceFields(source: DataSource): {
  issuedByKind: ProvenanceSourceKind;
  issuedByLabel: string;
  issuedByRef?: string;
} {
  return {
    issuedByKind: source.kind,
    issuedByLabel: source.label,
    ...(source.ref ? { issuedByRef: source.ref } : {}),
  };
}

export function toOrderItemDTO(item: OrderItem): OrderItemDTO {
  return { id: item.id, testCode: item.testCode, codeSystem: item.codeSystem };
}

export function toOrderDTO(order: DiagnosticOrder): OrderDTO {
  return {
    id: order.id,
    patientId: order.patientId,
    encounterId: order.encounterId,
    facilityId: order.facilityId,
    modality: order.modality,
    status: order.status,
    priority: order.priority,
    orderedAt: order.orderedAt,
    orderedByRef: order.orderedByRef,
    items: order.items.map(toOrderItemDTO),
    ...(order.verifiedByRef !== undefined ? { verifiedByRef: order.verifiedByRef } : {}),
    ...(order.verifiedAt !== undefined ? { verifiedAt: order.verifiedAt } : {}),
  };
}

export function toSpecimenDTO(specimen: Specimen): SpecimenDTO {
  return {
    id: specimen.id,
    orderItemId: specimen.orderItemId,
    patientId: specimen.patientId,
    kind: specimen.kind,
    status: specimen.status,
    collectedAt: specimen.collectedAt,
    collectedByRef: specimen.collectedByRef,
    ...(specimen.accessionNumber ? { accessionNumber: specimen.accessionNumber } : {}),
    ...(specimen.rejectionReason ? { rejectionReason: specimen.rejectionReason } : {}),
  };
}

export function toObservationDTO(observation: Observation): ObservationDTO {
  return {
    id: observation.id,
    orderItemId: observation.orderItemId,
    patientId: observation.patientId,
    code: observation.code,
    codeSystem: observation.codeSystem,
    value: observation.value,
    ...(observation.unit ? { unit: observation.unit } : {}),
    ...sourceFields(observation.issuedBy),
    at: observation.at,
  };
}

export function toInterpretationDTO(interpretation: Interpretation): InterpretationDTO {
  return {
    id: interpretation.id,
    orderItemId: interpretation.orderItemId,
    sourceKind: interpretation.source.kind,
    sourceLabel: interpretation.source.label,
    ...(interpretation.source.ref ? { sourceRef: interpretation.source.ref } : {}),
    text: interpretation.text,
    at: interpretation.at,
  };
}

function toReportVersionDTO(version: ReportVersion): ReportVersionDTO {
  return {
    id: version.id,
    version: version.version,
    status: version.status,
    content: version.content,
    authoredByRef: version.authoredByRef,
    authoredAt: version.authoredAt,
    ...(version.finalizedAt ? { finalizedAt: version.finalizedAt } : {}),
    ...(version.supersedesVersionId
      ? { supersedesVersionId: version.supersedesVersionId }
      : {}),
    ...(version.amendmentReason ? { amendmentReason: version.amendmentReason } : {}),
  };
}

export function toReportDTO(report: DiagnosticReport): ReportDTO {
  const head = report.versions[report.versions.length - 1];
  return {
    id: report.id,
    orderId: report.orderId,
    patientId: report.patientId,
    facilityId: report.facilityId,
    latestStatus: head?.status ?? 'DRAFT',
    latestVersion: head?.version ?? 0,
    versions: report.versions.map(toReportVersionDTO),
  };
}
