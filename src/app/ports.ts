/**
 * SDIS application-layer ports (repository/store boundaries).
 *
 * The application services depend ONLY on these interfaces, never on a concrete
 * store. Step 2 ships deterministic in-memory adapters (`src/app/in-memory.ts`);
 * PostgreSQL persistence is intentionally deferred (docs/DATABASE.md — no schema
 * invented, no RLS claimed).
 */

import type { AuditEvent } from '../core/audit/audit';
import type { Encounter } from '../domain/encounter/encounter';
import type { DiagnosticOrder } from '../domain/ordering/diagnostic-order';
import type { Facility } from '../domain/organization/organization';
import type { Patient } from '../domain/patient/patient';
import type { Interpretation } from '../domain/results/interpretation';
import type { Observation } from '../domain/results/observation';
import type { DiagnosticReport } from '../domain/results/report';
import type { Specimen } from '../domain/specimen/specimen';
import type {
  DiagnosticOrderId,
  EncounterId,
  FacilityId,
  InterpretationId,
  ObservationId,
  OrderItemId,
  PatientId,
  ReportId,
  SpecimenId,
} from '../types/ids';
import type { ModalityName } from '../types/modality';

/** Single identity source — read view over the canonical patient directory. */
export interface PatientDirectory {
  findById(patientId: PatientId): Promise<Patient | undefined>;
}

/** Facility registry binding each facility to its owning organization. */
export interface FacilityDirectory {
  findById(facilityId: FacilityId): Promise<Facility | undefined>;
}

/** Encounter registry (standalone Registration / HMS-integrated encounters). */
export interface EncounterDirectory {
  findById(encounterId: EncounterId): Promise<Encounter | undefined>;
}

/** Modality extension point (single registry, never branched on by core). */
export interface ModalityDirectory {
  has(name: ModalityName): Promise<boolean>;
}

export interface OrderRepository {
  save(order: DiagnosticOrder): Promise<DiagnosticOrder>;
  findById(id: DiagnosticOrderId): Promise<DiagnosticOrder | undefined>;
  /** Resolve the order that owns an order item (for item-scoped operations). */
  findByOrderItemId(orderItemId: OrderItemId): Promise<DiagnosticOrder | undefined>;
  /**
   * Deterministic operational worklist for a facility (Step 21): priority
   * rank first (EMERGENCY → URGENT → ROUTINE), then ordered-at, then id.
   * Queue ordering only — never clinical triage.
   */
  listByFacilityWithPriority(facilityId: FacilityId): Promise<readonly DiagnosticOrder[]>;
}

export interface SpecimenRepository {
  save(specimen: Specimen): Promise<Specimen>;
  findById(id: SpecimenId): Promise<Specimen | undefined>;
  listByOrderItem(orderItemId: OrderItemId): Promise<readonly Specimen[]>;
  /** Uniqueness probe: which specimen (if any) carries this accession number
   * within the facility (Step 27 accessioning). */
  findByAccessionNumber(
    facilityId: FacilityId,
    accessionNumber: string,
  ): Promise<Specimen | undefined>;
  /**
   * Step 29 worklist read model: the facility's specimens currently in ANY of
   * the given statuses, deterministically ordered (collected-at, then id).
   * A pure query over authoritative specimen state — no second store.
   */
  listByFacilityWithStatus(
    facilityId: FacilityId,
    statuses: readonly Specimen['status'][],
  ): Promise<readonly Specimen[]>;
}

export interface ObservationRepository {
  save(observation: Observation): Promise<Observation>;
  findById(id: ObservationId): Promise<Observation | undefined>;
  listByOrderItem(orderItemId: OrderItemId): Promise<readonly Observation[]>;
}

export interface InterpretationRepository {
  save(interpretation: Interpretation): Promise<Interpretation>;
  findById(id: InterpretationId): Promise<Interpretation | undefined>;
  listByOrderItem(orderItemId: OrderItemId): Promise<readonly Interpretation[]>;
}

export interface ReportRepository {
  save(report: DiagnosticReport): Promise<DiagnosticReport>;
  findById(id: ReportId): Promise<DiagnosticReport | undefined>;
  /**
   * Reports authored for one patient within one facility (Step 22 patient
   * access). Scope comes from the SERVER-derived session, never the client.
   */
  listByPatientAndFacility(
    patientId: PatientId,
    facilityId: FacilityId,
  ): Promise<readonly DiagnosticReport[]>;
}

/**
 * Patient ownership binding (Step 22): maps an authenticated patient
 * principal to the ONE canonical patient identity whose records it may
 * access. The binding is server-side data — never accepted from the client,
 * never derived from demographics or external identifiers. No binding → the
 * principal owns nothing (fail closed).
 */
export interface PatientPrincipalRegistry {
  resolvePatientId(userId: string): Promise<PatientId | undefined>;
}

/** Append-only audit port (no update/delete path by construction). */
export interface AuditPort {
  record(event: AuditEvent): Promise<void>;
}

/** Deterministic idempotency record: same logical request → same logical effect. */
export interface IdempotencyStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  /**
   * IDEM-01: cross-process single-flight. Serializes same-key callers — the
   * loser of the race never runs `create` and reads the winner's stored
   * result. The PG adapter implements this with a per-key advisory lock held
   * for the whole get→create→put unit; the in-memory adapter with per-key
   * in-process chaining. Stores without this method fall back to the plain
   * check-then-act path in `runIdempotent`.
   */
  withExclusive?<T>(key: string, create: () => Promise<T>): Promise<T>;
}
