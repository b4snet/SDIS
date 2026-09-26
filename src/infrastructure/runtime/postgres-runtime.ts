import type { Database } from '../database/database';
import {
  PostgresAuditPort,
  PostgresEncounterDirectory,
  PostgresFacilityDirectory,
  PostgresInterpretationRepository,
  PostgresModalityDirectory,
  PostgresObservationRepository,
  PostgresOrderRepository,
  PostgresPatientDirectory,
  PostgresPatientRegistrationRepository,
  PostgresPatientPrincipalRegistry,
  PostgresReportRepository,
  PostgresSpecimenRepository,
  PostgresIdempotencyStore,
  PostgresExternalSystemRegistry,
  PostgresOrderExternalReferenceStore,
} from '../database/repositories';
import { PatientService } from '../../app/patients/patient-service';
import { WorklistService } from '../../app/laboratory/worklist-service';
import { PatientReportAccessService } from '../../app/patient-access/report-access-service';
import { PatientDocumentAccessService } from '../../app/patient-access/document-access-service';
import {
  DocumentService,
  type DocumentContentStore,
} from '../../app/documents/document-service';
import {
  LocalDocumentContentStore,
  PostgresDocumentMetadataRepository,
} from '../database/document-repository';
import { TerminologyPersistenceService } from '../../app/terminology/terminology-service';
import { BillingService } from '../../app/billing/billing-service';
import { AuthorizationService, claimedRoleResolver } from '../../app/authz/rbac';
import { DeviceIngestionService } from '../../app/devices/device-ingestion-service';
import { PostgresTerminologyMappingRepository } from '../database/terminology-repository';
import { PostgresChargeRepository } from '../database/billing-repository';
import { PostgresDeviceIngestionRepository } from '../database/device-repository';
import { InventoryService } from '../../app/inventory/inventory-service';
import { PostgresInventoryRepository } from '../database/inventory-repository';
import { SetupConfigService } from '../../app/setup/setup-config-service';
import { DepartmentService } from '../../app/setup/department-service';
import { QualityService } from '../../app/quality/quality-service';
import { PostgresQualityRepository } from '../database/quality-repository';
import {
  IntegrationGateway,
  emptyIntegrationRegistry,
  type IntegrationAdapterRegistry,
} from '../../app/integration/integration-gateway';
import { PostgresSetupConfigRepository } from '../database/setup-config-repository';
import { PostgresDepartmentRepository } from '../database/department-repository';
import { NotificationService } from '../../app/notifications/notification-service';
import { NotificationDispatcher } from '../../app/notifications/dispatcher';
import { PostgresNotificationOutbox } from '../database/notification-repository';
import { InMemoryNotificationAdapter } from '../../app/in-memory';
import { InterpretationService } from '../../app/laboratory/interpretation-service';
import { LabFlowService } from '../../app/laboratory/lab-flow';
import { DeviceRegistry } from '../../domain/devices/device-registry';
import { ObservationService } from '../../app/laboratory/observation-service';
import { OrderService } from '../../app/laboratory/order-service';
import { ReportService } from '../../app/laboratory/report-service';
import { SpecimenService } from '../../app/laboratory/specimen-service';
import { runWithoutTenantScope } from '../database/tenant-scope';
import type { FacilityDirectory } from '../../app/ports';

export interface PostgresLaboratoryRuntime {
  readonly flow: LabFlowService;
  readonly orders: OrderService;
  readonly specimens: SpecimenService;
  readonly observations: ObservationService;
  readonly interpretations: InterpretationService;
  readonly reports: ReportService;
  /** Registration & intake (Step 6) — same runtime, same ports, no second system. */
  readonly patients: PatientService;
  /** Terminology persistence (Step 7) — same runtime, same ports. */
  readonly terminology: TerminologyPersistenceService;
  /** Diagnostic charge lifecycle (Step 8) — same runtime, same ports. */
  readonly billing: BillingService;
  /** Device ingestion foundation (Step 9) — same runtime, same ports. */
  readonly devices: DeviceIngestionService;
  /** Document management foundation (Step 13) — same runtime, same ports. */
  readonly documents: DocumentService;
  /** Laboratory inventory foundation (Step 14) — same runtime, same ports. */
  readonly inventory: InventoryService;
  /** Master setup configuration (Step 15) — same runtime, same ports. */
  readonly setup: SetupConfigService;
  /** Department master data (Step 24) — lifecycle administration. */
  readonly departments: import('../../app/setup/department-service').DepartmentService;
  /** Quality management (Step 27) — records + analytical hold boundary. */
  readonly quality: import('../../app/quality/quality-service').QualityService;
  /**
   * Integration gateway (Step 17) — same runtime, same services. No external
   * system is registered by default: the registry is EMPTY until an authorized
   * integration exists, so the gateway fails closed out of the box.
   */
  readonly integration: IntegrationGateway;
  /** Notifications & event delivery (Step 19) — in-memory channel only. */
  readonly notifications: NotificationService;
  /**
   * Step-19 durable delivery worker (operations seam). Intents are persisted
   * by `notifications.emit(...)` through the outbox; callers process a
   * facility's due batch by invoking
   * `runWithTenantScope(scope, () => dispatcher.processDue(facilityId))` —
   * never as the HTTP path, and never bypassing RLS.
   */
  readonly notificationDispatcher: NotificationDispatcher;
  /** Diagnostic worklist (Step 21) — deterministic priority read model. */
  readonly worklist: WorklistService;
  /** Patient report access (Step 22) — ownership-scoped read boundary. */
  readonly patientReports: PatientReportAccessService;
  /** Patient document access (Step 23) — explicitly-visible documents only. */
  readonly patientDocuments: PatientDocumentAccessService;
}

/**
 * Wires the in-process application contract to the existing PostgreSQL adapters.
 * `documentStore` injects the content-storage edge (defaults to the local
 * directory implementation) — the application itself never touches storage.
 */
export function createPostgresLaboratoryRuntime(
  db: Database,
  documentStore?: DocumentContentStore,
  /**
   * External systems registered with the integration gateway. Omitted (the
   * default) means NO external system is connected — the gateway fails closed.
   */
  integrationAdapters?: IntegrationAdapterRegistry,
): PostgresLaboratoryRuntime {
  const facilityDirectory = new PostgresFacilityDirectory(db);
  const facilities: FacilityDirectory = {
    // RLS-01 scope-escape: session validation must read the facility directory
    // without the caller's tenant scope — a forged session is only detectable
    // as SCOPE_MISMATCH when a cross-organization facility is visible to the
    // check. The escaped read runs as the pool role (the documented RLS
    // residual) and exposes registry metadata only, never tenant data.
    findById: (facilityId) =>
      runWithoutTenantScope(() => facilityDirectory.findById(facilityId)),
  };
  const idempotency = new PostgresIdempotencyStore(db);
  const audit = new PostgresAuditPort(db);
  const authz = new AuthorizationService({ roleResolver: claimedRoleResolver() });
  const orderRepository = new PostgresOrderRepository(db);
  const orders = new OrderService({
    patients: new PostgresPatientDirectory(db),
    encounters: new PostgresEncounterDirectory(db),
    facilities,
    modalities: new PostgresModalityDirectory(db),
    orders: orderRepository,
    audit,
    idempotency,
    authz,
  });
  const specimenRepository = new PostgresSpecimenRepository(db);
  const specimens = new SpecimenService({
    orders,
    specimens: specimenRepository,
    audit,
    idempotency,
    authz,
  });
  const observations = new ObservationService({
    orders,
    observations: new PostgresObservationRepository(db),
    specimens: new PostgresSpecimenRepository(db),
    audit,
    idempotency,
    authz,
  });
  const interpretations = new InterpretationService({
    orders,
    interpretations: new PostgresInterpretationRepository(db),
    audit,
    idempotency,
    authz,
  });
  const qualityRepository = new PostgresQualityRepository(db);
  const quality = new QualityService({
    quality: qualityRepository,
    facilities,
    audit,
    idempotency,
    authz,
  });
  const reportRepository = new PostgresReportRepository(db);
  const reports = new ReportService({
    orders,
    facilities,
    reports: reportRepository,
    audit,
    idempotency,
    authz,
    // QC hold boundary (Step 27): finalization pauses while a hold is active.
    // The probe runs inside the request's tenant scope, so RLS narrows the
    // query to the caller's facility — no session plumbing needed here.
    qualityHoldProbe: async () => {
      const hold = await qualityRepository.findActiveHoldInScope();
      return hold ? hold.id : undefined;
    },
  });
  const patientRepository = new PostgresPatientRegistrationRepository(db);
  const patients = new PatientService({
    patients: patientRepository,
    facilities,
    audit,
    idempotency,
    authz,
  });
  // Notifications (Step 19): in-memory channel adapter at the infrastructure
  // edge — no provider. The outbox makes events + delivery intents durable;
  // `notificationDispatcher` executes the delivery lifecycle under the
  // facility's tenant scope (operations seam). Future channels implement the
  // same adapter port.
  const notificationOutbox = new PostgresNotificationOutbox(db);
  const inMemoryAdapter = new InMemoryNotificationAdapter();
  const notifications = new NotificationService({
    adapters: [inMemoryAdapter],
    facilities,
    audit,
    authz,
    outbox: notificationOutbox,
  });
  const notificationDispatcher = new NotificationDispatcher({
    outbox: notificationOutbox,
    adapters: [inMemoryAdapter],
    audit,
  });
  const terminology = new TerminologyPersistenceService({
    mappings: new PostgresTerminologyMappingRepository(db),
    facilities,
    audit,
    idempotency,
    authz,
  });
  const billing = new BillingService({
    orders,
    charges: new PostgresChargeRepository(db),
    facilities,
    audit,
    idempotency,
    authz,
  });
  const devices = new DeviceIngestionService({
    registry: new DeviceRegistry(),
    repository: new PostgresDeviceIngestionRepository(db),
    observations,
    orders,
    facilities,
    audit,
    idempotency,
    authz,
  });
  const documents = new DocumentService({
    store: documentStore ?? new LocalDocumentContentStore('./data/documents'),
    documents: new PostgresDocumentMetadataRepository(db),
    patients: new PostgresPatientDirectory(db),
    orders: new PostgresOrderRepository(db),
    facilities,
    audit,
    idempotency,
    authz,
  });
  const inventory = new InventoryService({
    inventory: new PostgresInventoryRepository(db),
    facilities,
    audit,
    idempotency,
    authz,
  });
  const setup = new SetupConfigService({
    config: new PostgresSetupConfigRepository(db),
    facilities,
    audit,
    idempotency,
    authz,
  });
  const integration = new IntegrationGateway({
    adapters: integrationAdapters ?? emptyIntegrationRegistry(),
    systemRegistry: new PostgresExternalSystemRegistry(db),
    orderReferences: new PostgresOrderExternalReferenceStore(db),
    patients,
    orders,
    observations,
    interpretations,
    reports,
    specimens: new PostgresSpecimenRepository(db),
    patientReferences: patientRepository,
    facilities,
    audit,
    idempotency,
  });

  return {
    flow: new LabFlowService({
      orders,
      specimens,
      observations,
      interpretations,
      reports,
    }),
    orders,
    specimens,
    observations,
    interpretations,
    reports,
    patients,
    terminology,
    billing,
    devices,
    documents,
    inventory,
    quality,
    setup,
    integration,
    notifications,
    notificationDispatcher,
    worklist: new WorklistService({
      orders: orderRepository,
      facilities,
      config: setup,
      authz,
      specimens: specimenRepository,
      quality: qualityRepository,
    }),
    patientReports: new PatientReportAccessService({
      principalRegistry: new PostgresPatientPrincipalRegistry(db),
      reports: reportRepository,
      facilities,
      audit,
      authz,
    }),
    departments: new DepartmentService({
      departments: new PostgresDepartmentRepository(db),
      facilities,
      audit,
      idempotency,
      authz,
    }),
    patientDocuments: new PatientDocumentAccessService({
      principalRegistry: new PostgresPatientPrincipalRegistry(db),
      documentMetadata: new PostgresDocumentMetadataRepository(db),
      documents,
      facilities,
      audit,
      authz,
    }),
  };
}
