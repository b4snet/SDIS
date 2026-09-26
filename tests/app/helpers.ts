/**
 * Shared deterministic fixtures for the application-layer tests.
 *
 * Every test builds a FRESH fixture (fresh stores, fresh identity service, no
 * shared state) so tests are isolated and order-independent. All timestamps
 * derive from one fixed base instant; all identifiers are fixed UUID v4.
 */

import { InMemoryAuditStore } from '../../src/core/audit/audit';
import { PatientIdentityService } from '../../src/domain/patient/patient';
import { assertUuidV4, toBrandedId } from '../../src/types/ids';
import type {
  DiagnosticOrderId,
  EncounterId,
  FacilityId,
  OrganizationId,
  PatientId,
  ReportId,
  SpecimenId,
} from '../../src/types/ids';
import {
  AuditLogPort,
  InMemoryEncounterDirectory,
  InMemoryFacilityDirectory,
  InMemoryIdempotencyStore,
  InMemoryInterpretationRepository,
  InMemoryObservationRepository,
  InMemoryOrderRepository,
  InMemoryPatientDirectory,
  InMemoryReportRepository,
  InMemorySpecimenRepository,
  StaticModalityDirectory,
} from '../../src/app/in-memory';
import { AuthorizationService, claimedRoleResolver } from '../../src/app/authz/rbac';
import { InterpretationService } from '../../src/app/laboratory/interpretation-service';
import { LabFlowService, plusMinutes } from '../../src/app/laboratory/lab-flow';
import { ObservationService } from '../../src/app/laboratory/observation-service';
import { OrderService } from '../../src/app/laboratory/order-service';
import { ReportService } from '../../src/app/laboratory/report-service';
import { SpecimenService } from '../../src/app/laboratory/specimen-service';
import { WorklistService } from '../../src/app/laboratory/worklist-service';
import { InMemoryQualityRepository } from '../../src/app/in-memory-quality';
import { QualityService } from '../../src/app/quality/quality-service';
import type { ApplicationSession } from '../../src/app/context';

export const ORG: OrganizationId = toBrandedId('00000000-0000-4000-8000-000000000001');
export const OTHER_ORG: OrganizationId = toBrandedId(
  '00000000-0000-4000-8000-000000000009',
);
export const FACILITY: FacilityId = toBrandedId('00000000-0000-4000-8000-000000000011');
export const OTHER_FACILITY: FacilityId = toBrandedId(
  '00000000-0000-4000-8000-000000000012',
);
export const PATIENT_ID: PatientId = toBrandedId('00000000-0000-4000-8000-0000000000e1');
export const OTHER_PATIENT_ID: PatientId = toBrandedId(
  '00000000-0000-4000-8000-0000000000e2',
);
export const ENCOUNTER_ID: EncounterId = toBrandedId(
  '00000000-0000-4000-8000-0000000000c1',
);
export const OTHER_ENCOUNTER_ID: EncounterId = toBrandedId(
  '00000000-0000-4000-8000-0000000000c2',
);

export const T0 = '2026-09-20T08:00:00.000Z';
export const at = (minutes: number): string => plusMinutes(T0, minutes);

export function sessionFor(
  facilityId: FacilityId = FACILITY,
  organizationId: OrganizationId = ORG,
  actorId = 'user-tech-1',
): ApplicationSession {
  return {
    actor: { kind: 'USER', id: actorId },
    userId: 'user-tech-1',
    organizationId,
    facilityId,
  };
}

export interface LabFixture {
  readonly session: ApplicationSession;
  readonly audit: AuditLogPort;
  readonly orders: OrderService;
  readonly specimens: SpecimenService;
  readonly observations: ObservationService;
  readonly interpretations: InterpretationService;
  readonly reports: ReportService;
  readonly flow: LabFlowService;
  readonly worklist: WorklistService;
  readonly quality: QualityService;
  readonly patientId: PatientId;
  readonly encounterId: EncounterId;
}

/** Fresh, fully-wired laboratory application stack with one patient+encounter. */
export function createFixture(session?: ApplicationSession): LabFixture {
  const active = session ?? sessionFor();
  // Laboratory fixtures act as staff (operator tier) by default: the lab
  // services enforce RBAC (Step 27), so raw role-less sessions would be
  // denied. A caller-supplied session keeps its own claims.
  if (!(active as { roles?: readonly string[] }).roles) {
    (active as { roles?: readonly string[] }).roles = ['operator'] as never;
  }
  const identity = new PatientIdentityService();
  identity.createPatient({
    id: PATIENT_ID,
    registeredAtFacilityId: FACILITY,
    fullName: 'Synthetic Patient',
    sex: 'UNKNOWN',
  });
  identity.createPatient({
    id: OTHER_PATIENT_ID,
    registeredAtFacilityId: FACILITY,
    fullName: 'Other Synthetic Patient',
    sex: 'UNKNOWN',
  });

  const encounters = new InMemoryEncounterDirectory();
  encounters.register({
    id: ENCOUNTER_ID,
    patientId: PATIENT_ID,
    facilityId: FACILITY,
    startedAt: T0,
  });
  encounters.register({
    id: OTHER_ENCOUNTER_ID,
    patientId: OTHER_PATIENT_ID,
    facilityId: FACILITY,
    startedAt: T0,
  });

  const facilities = new InMemoryFacilityDirectory();
  facilities.register({
    id: FACILITY,
    organizationId: ORG,
    name: 'Synthetic Lab Facility',
    code: 'SYN-LAB-1',
    timezone: 'Asia/Kathmandu',
  });
  facilities.register({
    id: OTHER_FACILITY,
    organizationId: ORG,
    name: 'Other Facility',
    code: 'SYN-LAB-2',
    timezone: 'Asia/Kathmandu',
  });

  const audit = new AuditLogPort(new InMemoryAuditStore());
  const idempotency = new InMemoryIdempotencyStore();
  const ordersRepo = new InMemoryOrderRepository();
  const specimensRepo = new InMemorySpecimenRepository();
  const observationsRepo = new InMemoryObservationRepository();
  const interpretationsRepo = new InMemoryInterpretationRepository();
  const reportsRepo = new InMemoryReportRepository();
  const authz = new AuthorizationService({ roleResolver: claimedRoleResolver() });

  const orders = new OrderService({
    patients: InMemoryPatientDirectory.fromIdentityService(identity),
    encounters,
    facilities,
    modalities: new StaticModalityDirectory(['LAB', 'ECG']),
    orders: ordersRepo,
    audit,
    idempotency,
    authz,
  });
  const specimens = new SpecimenService({
    orders,
    specimens: specimensRepo,
    audit,
    idempotency,
    authz,
  });
  const observations = new ObservationService({
    orders,
    observations: observationsRepo,
    specimens: specimensRepo,
    audit,
    idempotency,
    authz,
  });
  const interpretations = new InterpretationService({
    orders,
    interpretations: interpretationsRepo,
    audit,
    idempotency,
    authz,
  });
  const reports = new ReportService({
    orders,
    facilities,
    reports: reportsRepo,
    audit,
    idempotency,
    authz,
    // QC hold boundary (Step 27): finalization pauses while an analytical
    // hold is active — same wiring as the PostgreSQL runtime.
    qualityHoldProbe: async () => {
      const hold = await qualityRepo.findActiveHold(active.facilityId);
      return hold ? hold.id : undefined;
    },
  });
  const flow = new LabFlowService({
    orders,
    specimens,
    observations,
    interpretations,
    reports,
  });
  // Step 27/24 operational surfaces consumed by the transport routes.
  const qualityRepo = new InMemoryQualityRepository();
  const quality = new QualityService({
    quality: qualityRepo,
    facilities,
    audit,
    idempotency,
    authz,
  });
  const worklist = new WorklistService({
    orders: ordersRepo,
    facilities,
    authz,
    specimens: specimensRepo,
    quality: qualityRepo,
  });

  return {
    session: active,
    audit,
    orders,
    specimens,
    observations,
    interpretations,
    reports,
    flow,
    worklist,
    quality,
    patientId: PATIENT_ID,
    encounterId: ENCOUNTER_ID,
  };
}

/** Counts audit events for one object (proves emission / non-duplication). */
export function auditCountFor(
  fixture: LabFixture,
  objectId: string,
  action?: string,
): number {
  return fixture.audit
    .list()
    .filter(
      (event) =>
        event.objectId === objectId && (action === undefined || event.action === action),
    ).length;
}

/**
 * Tests cross the DTO boundary the same safe way production code does:
 * DTO identifiers are re-validated through the Step-1 branded-id parser.
 */
export function orderIdOf(dto: { readonly id: string }): DiagnosticOrderId {
  return assertUuidV4<DiagnosticOrderId>(dto.id, 'diagnostic order id');
}

export function specimenIdOf(dto: { readonly id: string }): SpecimenId {
  return assertUuidV4<SpecimenId>(dto.id, 'specimen id');
}

export function reportIdOf(dto: { readonly id: string }): ReportId {
  return assertUuidV4<ReportId>(dto.id, 'report id');
}
