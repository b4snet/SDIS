/**
 * SDIS PostgreSQL Repository Adapters
 *
 * Implements the application ports using PostgreSQL.
 * These adapters replace the in-memory implementations for production use.
 */

import { PoolClient } from 'pg';
import type {
  PatientDirectory,
  FacilityDirectory,
  EncounterDirectory,
  ModalityDirectory,
  OrderRepository,
  SpecimenRepository,
  ObservationRepository,
  InterpretationRepository,
  ReportRepository,
  AuditPort,
  IdempotencyStore,
  PatientPrincipalRegistry,
} from '../../app/ports';
import type { Encounter } from '../../domain/encounter/encounter';
import type { DiagnosticOrder, OrderItem } from '../../domain/ordering/diagnostic-order';
import type { Facility } from '../../domain/organization/organization';
import type { Patient } from '../../domain/patient/patient';
import type { Interpretation } from '../../domain/results/interpretation';
import type { Observation } from '../../domain/results/observation';
import type { DiagnosticReport, ReportVersion } from '../../domain/results/report';
import type { Specimen } from '../../domain/specimen/specimen';
import type {
  OrganizationId,
  FacilityId,
  PatientId,
  EncounterId,
  DiagnosticOrderId,
  OrderItemId,
  SpecimenId,
  ObservationId,
  InterpretationId,
  ReportId,
  ReportVersionId,
  AuditEventId,
} from '../../types/ids';
import type { ExternalSystemRecord } from '../../app/integration/integration-gateway';
import type { ModalityName } from '../../types/modality';
import type { DiagnosticOrderPriority } from '../../domain/ordering/diagnostic-order';
import type { AuditEvent } from '../../core/audit/audit';
import type { DataSource, ProvenanceSourceKind } from '../../types/provenance';
import { ConflictError } from '../../app/errors';
import { isUuidV4 } from '../../types/ids';
import type { PatientRegistrationRepository } from '../../app/patients/patient-service';
import type { ExternalPatientReference } from '../../types/external-reference';
import { Database, getDatabase } from './database';
import { v4 as uuidv4 } from 'uuid';

function toUUID(id: string): string {
  return id;
}

/**
 * Detects a PostgreSQL unique-violation (SQLSTATE 23505). INT-33: racing
 * writers of a business-unique fact (accession number, external reference,
 * idempotent movement key) must surface the stable CONFLICT error contract
 * (409) — never a raw constraint failure (500).
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function fromUUID<T extends string>(id: string): T {
  return id as T;
}

// Helper to map DB row to domain Patient
function mapPatient(row: any): Patient {
  return {
    id: fromUUID<PatientId>(row.id),
    registeredAtFacilityId: fromUUID<FacilityId>(row.registered_at_facility_id),
    fullName: row.full_name,
    sex: row.sex,
    birthDate: row.birth_date ? row.birth_date.toISOString().split('T')[0] : undefined,
    externalReferences: Object.freeze([]), // Loaded separately if needed
  };
}

// Helper to map DB row to domain Facility
function mapFacility(row: any): Facility {
  return {
    id: fromUUID<FacilityId>(row.id),
    organizationId: fromUUID<OrganizationId>(row.organization_id),
    name: row.name,
    code: row.code,
    timezone: row.timezone,
  };
}

// Helper to map DB row to domain Encounter
function mapEncounter(row: any): Encounter {
  return {
    id: fromUUID<EncounterId>(row.id),
    patientId: fromUUID<PatientId>(row.patient_id),
    facilityId: fromUUID<FacilityId>(row.facility_id),
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : undefined,
    externalRef: row.external_ref_system
      ? {
          system: row.external_ref_system as any,
          value: row.external_ref_value,
          facilityId: fromUUID<FacilityId>(row.external_ref_facility_id),
        }
      : undefined,
  };
}

// Helper to map DB row to domain DiagnosticOrder
function mapOrder(row: any): DiagnosticOrder {
  return {
    id: fromUUID<DiagnosticOrderId>(row.id),
    patientId: fromUUID<PatientId>(row.patient_id),
    encounterId: fromUUID<EncounterId>(row.encounter_id),
    facilityId: fromUUID<FacilityId>(row.facility_id),
    modality: row.modality as ModalityName,
    status: row.status,
    priority: row.priority as DiagnosticOrderPriority,
    orderedAt: row.ordered_at.toISOString(),
    orderedByRef: row.ordered_by_ref,
    // Verification attribution (Step 28) — round-tripped, never client-set.
    ...(row.verified_by_ref
      ? {
          verifiedByRef: row.verified_by_ref,
          verifiedAt: row.verified_at.toISOString(),
        }
      : {}),
    items: Object.freeze([]), // Loaded separately
    version: Number(row.version ?? 1), // LAB-02 optimistic-concurrency version
  };
}

// Helper to map DB row to domain OrderItem
function mapOrderItem(row: any): OrderItem {
  return {
    id: fromUUID<OrderItemId>(row.id),
    orderId: fromUUID<DiagnosticOrderId>(row.order_id),
    testCode: row.test_code,
    codeSystem: row.code_system,
  };
}

// Helper to map DB row to domain Specimen
function mapSpecimen(row: any): Specimen {
  return {
    id: fromUUID<SpecimenId>(row.id),
    orderItemId: fromUUID<OrderItemId>(row.order_item_id),
    patientId: fromUUID<PatientId>(row.patient_id),
    kind: row.kind,
    collectedAt: row.collected_at.toISOString(),
    collectedByRef: row.collected_by_ref,
    status: row.status,
    ...(row.accession_number ? { accessionNumber: row.accession_number } : {}),
    ...(row.rejection_reason ? { rejectionReason: row.rejection_reason } : {}),
    version: Number(row.version ?? 1), // LAB-02 optimistic-concurrency version
  };
}

// Helper to map DB row to domain Observation
function mapObservation(row: any): Observation {
  let value: any;
  switch (row.value_kind) {
    case 'QUANTITATIVE':
      value = { kind: 'QUANTITATIVE', value: parseFloat(row.value_numeric) };
      break;
    case 'QUALITATIVE':
      value = { kind: 'QUALITATIVE', text: row.value_text };
      break;
    case 'CODED':
      value = { kind: 'CODED', code: row.value_code, codeSystem: row.value_code_system };
      break;
    case 'TEXT':
      value = { kind: 'TEXT', text: row.value_text };
      break;
  }

  return {
    id: fromUUID<ObservationId>(row.id),
    orderItemId: fromUUID<OrderItemId>(row.order_item_id),
    patientId: fromUUID<PatientId>(row.patient_id),
    code: row.code,
    codeSystem: row.code_system,
    value,
    unit: row.unit,
    issuedBy: {
      kind: row.issued_by_kind as any,
      label: row.issued_by_label,
      ref: row.issued_by_ref,
    },
    at: row.at.toISOString(),
  };
}

// Helper to map DB row to domain Interpretation
function mapInterpretation(row: any): Interpretation {
  return {
    id: fromUUID<InterpretationId>(row.id),
    orderItemId: fromUUID<OrderItemId>(row.order_item_id),
    source: {
      kind: row.source_kind as ProvenanceSourceKind,
      label: row.source_label,
      ref: row.source_ref,
    },
    text: row.text,
    at: row.at.toISOString(),
  };
}

// Helper to map DB row to domain ReportVersion
function mapReportVersion(row: any): ReportVersion {
  return {
    id: fromUUID<ReportVersionId>(row.id),
    reportId: fromUUID<ReportId>(row.report_id),
    version: row.version,
    status: row.status,
    content: row.content,
    authoredByRef: row.authored_by_ref,
    authoredAt: row.authored_at.toISOString(),
    finalizedAt: row.finalized_at ? row.finalized_at.toISOString() : undefined,
    supersedesVersionId: row.supersedes_version_id
      ? fromUUID<ReportVersionId>(row.supersedes_version_id)
      : undefined,
  };
}

// Helper to map DB row to domain DiagnosticReport
function mapReport(row: any): DiagnosticReport {
  return {
    id: fromUUID<ReportId>(row.id),
    orderId: fromUUID<DiagnosticOrderId>(row.order_id),
    patientId: fromUUID<PatientId>(row.patient_id),
    facilityId: fromUUID<FacilityId>(row.facility_id),
    versions: Object.freeze([]), // Loaded separately
  };
}

/**
 * PostgreSQL Patient Directory
 */
export class PostgresPatientDirectory implements PatientDirectory {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async findById(patientId: PatientId): Promise<Patient | undefined> {
    const result = await this.db.query('SELECT * FROM sdis.patients WHERE id = $1', [
      patientId,
    ]);
    if (result.rows.length === 0) return undefined;
    return mapPatient(result.rows[0]);
  }
}

/**
 * PostgreSQL patient registration repository — the write-capable patient path.
 *
 * Persists the canonical patient and its external references atomically
 * (`sdis.patients` + `sdis.patient_external_identifiers`, migration 002).
 * Duplicate references are constrained by the schema's
 * `UNIQUE (system, value, facility_id)`; the pre-check in the application
 * service surfaces it as the stable CONFLICT contract, and this adapter maps a
 * race-window unique violation to the same code. Subject to the same RLS
 * policies as every other adapter — no policy is bypassed or weakened.
 */
export class PostgresPatientRegistrationRepository implements PatientRegistrationRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async save(patient: Patient): Promise<Patient> {
    try {
      await this.db.transaction(async (client) => {
        await client.query(
          `INSERT INTO sdis.patients (id, registered_at_facility_id, full_name, sex, birth_date)
                 VALUES ($1, $2, $3, $4, $5)`,
          [
            toUUID(patient.id),
            toUUID(patient.registeredAtFacilityId),
            patient.fullName,
            patient.sex,
            patient.birthDate ?? null,
          ],
        );
        for (const ref of patient.externalReferences) {
          await client.query(
            `INSERT INTO sdis.patient_external_identifiers (patient_id, system, value, facility_id)
                   VALUES ($1, $2, $3, $4)`,
            [toUUID(patient.id), ref.system, ref.value, toUUID(ref.facilityId)],
          );
        }
      });
    } catch (error: any) {
      if (error && typeof error === 'object' && error.code === '23505') {
        throw new ConflictError(
          'An external identifier with this system and value is already registered in this facility',
        );
      }
      throw error;
    }
    return patient;
  }

  async saveExternalReference(
    patientId: PatientId,
    ref: ExternalPatientReference,
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO sdis.patient_external_identifiers (patient_id, system, value, facility_id)
               VALUES ($1, $2, $3, $4)`,
        [toUUID(patientId), ref.system, ref.value, toUUID(ref.facilityId)],
      );
    } catch (error: any) {
      if (error && typeof error === 'object' && error.code === '23505') {
        throw new ConflictError(
          'An external identifier with this system and value is already registered in this facility',
        );
      }
      throw error;
    }
  }

  async findWithReferences(patientId: PatientId): Promise<Patient | undefined> {
    const result = await this.db.query('SELECT * FROM sdis.patients WHERE id = $1', [
      patientId,
    ]);
    if (result.rows.length === 0) return undefined;
    const refs = await this.db.query(
      `SELECT system, value, facility_id FROM sdis.patient_external_identifiers
             WHERE patient_id = $1 ORDER BY created_at`,
      [patientId],
    );
    const base = mapPatient(result.rows[0]);
    return {
      ...base,
      externalReferences: Object.freeze(
        refs.rows.map((row: any) => ({
          system: row.system as string,
          value: row.value as string,
          facilityId: fromUUID<FacilityId>(row.facility_id),
        })),
      ),
    };
  }

  async findPatientIdByExternalReference(
    ref: ExternalPatientReference,
  ): Promise<PatientId | undefined> {
    const result = await this.db.query(
      `SELECT patient_id FROM sdis.patient_external_identifiers
             WHERE system = $1 AND value = $2 AND facility_id = $3`,
      [ref.system, ref.value, toUUID(ref.facilityId)],
    );
    if (result.rows.length === 0) return undefined;
    return fromUUID<PatientId>(result.rows[0].patient_id);
  }
}

/**
 * PostgreSQL Facility Directory
 */
export class PostgresFacilityDirectory implements FacilityDirectory {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async findById(facilityId: FacilityId): Promise<Facility | undefined> {
    const result = await this.db.query('SELECT * FROM sdis.facilities WHERE id = $1', [
      facilityId,
    ]);
    if (result.rows.length === 0) return undefined;
    return mapFacility(result.rows[0]);
  }
}

/**
 * PostgreSQL Encounter Directory
 */
export class PostgresEncounterDirectory implements EncounterDirectory {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async findById(encounterId: EncounterId): Promise<Encounter | undefined> {
    const result = await this.db.query('SELECT * FROM sdis.encounters WHERE id = $1', [
      encounterId,
    ]);
    if (result.rows.length === 0) return undefined;
    return mapEncounter(result.rows[0]);
  }
}

/**
 * PostgreSQL Modality Directory
 */
export class PostgresModalityDirectory implements ModalityDirectory {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async has(name: ModalityName): Promise<boolean> {
    const result = await this.db.query('SELECT 1 FROM sdis.modalities WHERE name = $1', [
      name,
    ]);
    return result.rowCount > 0;
  }
}

/**
 * PostgreSQL Order Repository
 */
export class PostgresOrderRepository implements OrderRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async save(order: DiagnosticOrder): Promise<DiagnosticOrder> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // LAB-02 optimistic concurrency (version CAS): an UPDATE only applies if
      // the persisted row is still at the version the caller read. A lost
      // update (another writer committed since the read) matches zero rows →
      // CONFLICT; the caller must re-read and re-validate. New rows insert at
      // version 1. The row lock (FOR UPDATE) is unnecessary — the version
      // guard itself is atomic.
      const updated = await client.query(
        `UPDATE sdis.diagnostic_orders
            SET status = $2,
                priority = $4,
                verified_by_ref = $5,
                verified_at = $6,
                version = version + 1,
                updated_at = now()
          WHERE id = $1 AND version = $3
          RETURNING id`,
        [
          order.id,
          order.status,
          order.version,
          order.priority,
          order.verifiedByRef ?? null,
          order.verifiedAt ?? null,
        ],
      );
      if (updated.rowCount === 0) {
        const inserted = await client.query(
          `INSERT INTO sdis.diagnostic_orders
                  (id, patient_id, encounter_id, facility_id, modality, status,
                   priority, ordered_at, ordered_by_ref, verified_by_ref, verified_at, version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1)
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
          [
            order.id,
            order.patientId,
            order.encounterId,
            order.facilityId,
            order.modality,
            order.status,
            order.priority,
            order.orderedAt,
            order.orderedByRef,
            order.verifiedByRef ?? null,
            order.verifiedAt ?? null,
          ],
        );
        if (inserted.rowCount === 0) {
          // The row exists but not at the caller's version — a concurrent
          // transition won the race.
          throw new ConflictError(
            `Order was modified concurrently (version ${order.version} is stale) — re-read and retry`,
          );
        }
      }

      // Save order items
      for (const item of order.items) {
        await client.query(
          `INSERT INTO sdis.order_items (id, order_id, test_code, code_system)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT (id) DO UPDATE SET
                        test_code = EXCLUDED.test_code,
                        code_system = EXCLUDED.code_system`,
          [item.id, order.id, item.testCode, item.codeSystem],
        );
      }

      await client.query('COMMIT');
      // The returned aggregate mirrors the persisted row: an UPDATE advanced
      // the version; an INSERT created the row at the initial version.
      return {
        ...order,
        version: (updated.rowCount ?? 0) > 0 ? order.version + 1 : 1,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      // INT-33: a lost create-race against a business-unique fact is a 409,
      // not a raw constraint error.
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          'Order conflicts with an existing unique record — re-read and retry',
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async findById(id: DiagnosticOrderId): Promise<DiagnosticOrder | undefined> {
    const orderResult = await this.db.query(
      'SELECT * FROM sdis.diagnostic_orders WHERE id = $1',
      [id],
    );
    if (orderResult.rows.length === 0) return undefined;

    const order = mapOrder(orderResult.rows[0]);

    // Load items
    const itemsResult = await this.db.query(
      'SELECT * FROM sdis.order_items WHERE order_id = $1',
      [id],
    );
    const items = itemsResult.rows.map(mapOrderItem);

    return { ...order, items: Object.freeze(items) };
  }

  async findByOrderItemId(
    orderItemId: OrderItemId,
  ): Promise<DiagnosticOrder | undefined> {
    const result = await this.db.query(
      `SELECT o.* FROM sdis.diagnostic_orders o
             JOIN sdis.order_items i ON o.id = i.order_id
             WHERE i.id = $1`,
      [orderItemId],
    );
    if (result.rows.length === 0) return undefined;
    const order = mapOrder(result.rows[0]);

    const itemsResult = await this.db.query(
      'SELECT * FROM sdis.order_items WHERE order_id = $1',
      [order.id],
    );
    const items = itemsResult.rows.map(mapOrderItem);

    return { ...order, items: Object.freeze(items) };
  }

  async listByFacilityWithPriority(
    facilityId: FacilityId,
  ): Promise<readonly DiagnosticOrder[]> {
    // Returns the facility's FULL deterministic set — status narrowing is the
    // worklist service's per-view/per-config concern (BASELINE-06): the
    // `exception` view needs CANCELLED and `includeHistory` needs REPORTED,
    // so no status is pre-excluded here. Mirrors the in-memory twin exactly
    // (port contract: facility-scoped, priority-ranked, ordered-at, then id).
    const result = await this.db.query(
      `SELECT * FROM sdis.diagnostic_orders
         WHERE facility_id = $1
         ORDER BY CASE priority
                     WHEN 'EMERGENCY' THEN 0
                     WHEN 'URGENT' THEN 1
                     ELSE 2
                   END,
                   ordered_at,
                   id`,
      [facilityId],
    );
    return Object.freeze(result.rows.map((row: any) => mapOrder(row)));
  }
}

/**
 * PostgreSQL Specimen Repository
 */
export class PostgresSpecimenRepository implements SpecimenRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async save(specimen: Specimen): Promise<Specimen> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // LAB-02 optimistic concurrency (version CAS) — same shape as the order
      // repository: an UPDATE applies only when the persisted row is still at
      // the version the caller read; otherwise the write is refused with
      // CONFLICT (never a silent regression of the specimen lifecycle).
      const updated = await client.query(
        `UPDATE sdis.specimens
            SET status = $2,
                accession_number = $4,
                rejection_reason = $5,
                version = version + 1,
                updated_at = now()
          WHERE id = $1 AND version = $3
          RETURNING id`,
        [
          specimen.id,
          specimen.status,
          specimen.version,
          specimen.accessionNumber ?? null,
          specimen.rejectionReason ?? null,
        ],
      );
      if (updated.rowCount === 0) {
        // CAS missed: the row either does not exist yet (fresh insert) or was
        // modified concurrently (stale version). Distinguish BEFORE any write:
        // attempting a rescue INSERT for an existing id would evaluate row
        // CHECK constraints on a candidate row that can never be stored,
        // masking the concurrency conflict with an unrelated constraint error.
        const existing = await client.query(
          'SELECT 1 FROM sdis.specimens WHERE id = $1',
          [specimen.id],
        );
        if ((existing.rowCount ?? 0) > 0) {
          throw new ConflictError(
            `Specimen was modified concurrently (version ${specimen.version} is stale) — re-read and retry`,
          );
        }
        const inserted = await client.query(
          `INSERT INTO sdis.specimens
                  (id, order_item_id, patient_id, kind, status, collected_at,
                   collected_by_ref, accession_number, rejection_reason, version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
             RETURNING id`,
          [
            specimen.id,
            specimen.orderItemId,
            specimen.patientId,
            specimen.kind,
            specimen.status,
            specimen.collectedAt,
            specimen.collectedByRef,
            specimen.accessionNumber ?? null,
            specimen.rejectionReason ?? null,
          ],
        );
        if (inserted.rowCount === 0) {
          throw new ConflictError(
            `Specimen was modified concurrently (version ${specimen.version} is stale) — re-read and retry`,
          );
        }
      }

      await client.query('COMMIT');
      return {
        ...specimen,
        version: (updated.rowCount ?? 0) > 0 ? specimen.version + 1 : 1,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      // INT-33: concurrent accessioning of the same number is a 409 — the
      // caller re-probes for a fresh number instead of surfacing a 500.
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          'Specimen conflicts with an existing unique record (accession number already assigned) — re-read and retry',
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async findById(id: SpecimenId): Promise<Specimen | undefined> {
    const result = await this.db.query('SELECT * FROM sdis.specimens WHERE id = $1', [
      id,
    ]);
    if (result.rows.length === 0) return undefined;
    return mapSpecimen(result.rows[0]);
  }

  async listByOrderItem(orderItemId: OrderItemId): Promise<readonly Specimen[]> {
    const result = await this.db.query(
      'SELECT * FROM sdis.specimens WHERE order_item_id = $1 ORDER BY collected_at',
      [orderItemId],
    );
    return Object.freeze(result.rows.map(mapSpecimen));
  }

  async findByAccessionNumber(
    facilityId: FacilityId,
    accessionNumber: string,
  ): Promise<Specimen | undefined> {
    // Facility scope rides the specimen's own order (authoritative owner);
    // RLS additionally constrains the query to the session's tenant/facility.
    const result = await this.db.query(
      `SELECT sp.* FROM sdis.specimens sp
         JOIN sdis.order_items oi ON oi.id = sp.order_item_id
         JOIN sdis.diagnostic_orders o ON o.id = oi.order_id
        WHERE o.facility_id = $1 AND sp.accession_number = $2
        LIMIT 1`,
      [facilityId, accessionNumber],
    );
    if (result.rows.length === 0) return undefined;
    return mapSpecimen(result.rows[0]);
  }

  /**
   * Step 29 worklist read: facility specimens in ANY of the given statuses,
   * deterministically ordered (collected-at, then id). Database-side
   * filtering/ordering; the status index (migration 004) serves the filter.
   */
  async listByFacilityWithStatus(
    facilityId: FacilityId,
    statuses: readonly Specimen['status'][],
  ): Promise<readonly Specimen[]> {
    const result = await this.db.query(
      `SELECT sp.* FROM sdis.specimens sp
         JOIN sdis.order_items oi ON oi.id = sp.order_item_id
         JOIN sdis.diagnostic_orders o ON o.id = oi.order_id
        WHERE o.facility_id = $1
          AND sp.status = ANY($2::text[])
        ORDER BY sp.collected_at, sp.id`,
      [facilityId, statuses as unknown as string[]],
    );
    return Object.freeze(result.rows.map((row: any) => mapSpecimen(row)));
  }
}

/**
 * PostgreSQL Observation Repository
 */
export class PostgresObservationRepository implements ObservationRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async save(observation: Observation): Promise<Observation> {
    const valueNumeric =
      observation.value.kind === 'QUANTITATIVE' ? observation.value.value : null;
    const valueText =
      observation.value.kind === 'QUALITATIVE' || observation.value.kind === 'TEXT'
        ? observation.value.text
        : null;
    const valueCode = observation.value.kind === 'CODED' ? observation.value.code : null;
    const valueCodeSystem =
      observation.value.kind === 'CODED' ? observation.value.codeSystem : null;

    await this.db.query(
      `INSERT INTO sdis.observations (id, order_item_id, patient_id, specimen_id, code, code_system, value_kind, value_numeric, value_text, value_code, value_code_system, unit, issued_by_kind, issued_by_label, issued_by_ref, at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (id) DO NOTHING`,
      [
        observation.id,
        observation.orderItemId,
        observation.patientId,
        observation.specimenId || null,
        observation.code,
        observation.codeSystem,
        observation.value.kind,
        valueNumeric,
        valueText,
        valueCode,
        valueCodeSystem,
        observation.unit || null,
        observation.issuedBy.kind,
        observation.issuedBy.label,
        observation.issuedBy.ref || null,
        observation.at,
      ],
    );
    return observation;
  }

  async findById(id: ObservationId): Promise<Observation | undefined> {
    const result = await this.db.query('SELECT * FROM sdis.observations WHERE id = $1', [
      id,
    ]);
    if (result.rows.length === 0) return undefined;
    return mapObservation(result.rows[0]);
  }

  async listByOrderItem(orderItemId: OrderItemId): Promise<readonly Observation[]> {
    const result = await this.db.query(
      'SELECT * FROM sdis.observations WHERE order_item_id = $1 ORDER BY at',
      [orderItemId],
    );
    return Object.freeze(result.rows.map(mapObservation));
  }
}

/**
 * PostgreSQL Interpretation Repository
 */
export class PostgresInterpretationRepository implements InterpretationRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async save(interpretation: Interpretation): Promise<Interpretation> {
    await this.db.query(
      `INSERT INTO sdis.interpretations (id, order_item_id, source_kind, source_label, source_ref, text, at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO NOTHING`,
      [
        interpretation.id,
        interpretation.orderItemId,
        interpretation.source.kind,
        interpretation.source.label,
        interpretation.source.ref || null,
        interpretation.text,
        interpretation.at,
      ],
    );
    return interpretation;
  }

  async findById(id: InterpretationId): Promise<Interpretation | undefined> {
    const result = await this.db.query(
      'SELECT * FROM sdis.interpretations WHERE id = $1',
      [id],
    );
    if (result.rows.length === 0) return undefined;
    return mapInterpretation(result.rows[0]);
  }

  async listByOrderItem(orderItemId: OrderItemId): Promise<readonly Interpretation[]> {
    const result = await this.db.query(
      'SELECT * FROM sdis.interpretations WHERE order_item_id = $1 ORDER BY at',
      [orderItemId],
    );
    return Object.freeze(result.rows.map(mapInterpretation));
  }
}

/**
 * PostgreSQL Report Repository
 */
export class PostgresReportRepository implements ReportRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async save(report: DiagnosticReport): Promise<DiagnosticReport> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Upsert report header
      await client.query(
        `INSERT INTO sdis.reports (id, order_id, patient_id, facility_id, current_version)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (id) DO UPDATE SET
                    current_version = EXCLUDED.current_version,
                    updated_at = now()`,
        [
          report.id,
          report.orderId,
          report.patientId,
          report.facilityId,
          report.versions.length,
        ],
      );

      // Save versions (only new ones)
      for (const version of report.versions) {
        await client.query(
          `INSERT INTO sdis.report_versions (id, report_id, version, status, content, authored_by_ref, authored_at, finalized_at, supersedes_version_id)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                  ON CONFLICT (report_id, version) DO UPDATE SET
                    status = EXCLUDED.status,
                    authored_by_ref = EXCLUDED.authored_by_ref,
                    finalized_at = EXCLUDED.finalized_at
                  WHERE sdis.report_versions.status = 'DRAFT'`,
          [
            version.id,
            report.id,
            version.version,
            version.status,
            version.content,
            version.authoredByRef,
            version.authoredAt,
            version.finalizedAt || null,
            version.supersedesVersionId || null,
          ],
        );
      }

      await client.query('COMMIT');
      return report;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findById(id: ReportId): Promise<DiagnosticReport | undefined> {
    const reportResult = await this.db.query('SELECT * FROM sdis.reports WHERE id = $1', [
      id,
    ]);
    if (reportResult.rows.length === 0) return undefined;

    const report = mapReport(reportResult.rows[0]);

    const versionsResult = await this.db.query(
      'SELECT * FROM sdis.report_versions WHERE report_id = $1 ORDER BY version',
      [id],
    );
    const versions = versionsResult.rows.map(mapReportVersion);

    return { ...report, versions: Object.freeze(versions) };
  }

  /**
   * Step 22 patient access: reports for ONE patient within ONE facility.
   * Deterministic ordering (created_at, id); scoped by the caller's
   * server-derived session values — never by client input.
   */
  async listByPatientAndFacility(
    patientId: PatientId,
    facilityId: FacilityId,
  ): Promise<readonly DiagnosticReport[]> {
    const result = await this.db.query(
      `SELECT * FROM sdis.reports
        WHERE patient_id = $1 AND facility_id = $2
        ORDER BY created_at, id`,
      [patientId, facilityId],
    );
    if (result.rows.length === 0) return [];

    const reports = result.rows.map(mapReport);
    const versionsResult = await this.db.query(
      `SELECT * FROM sdis.report_versions WHERE report_id = ANY($1::uuid[]) ORDER BY version`,
      [reports.map((report) => report.id)],
    );
    const byReport = new Map<ReportId, ReportVersion[]>();
    for (const row of versionsResult.rows) {
      const version = mapReportVersion(row);
      const list = byReport.get(version.reportId);
      if (list) list.push(version);
      else byReport.set(version.reportId, [version]);
    }
    return reports.map((report) => ({
      ...report,
      versions: Object.freeze(byReport.get(report.id) ?? []),
    }));
  }
}

/**
 * PostgreSQL patient principal registry (Step 22): the ownership binding
 * between an authenticated patient principal (credential userId) and its ONE
 * canonical patient identity. Only non-secret binding references live in the
 * database — credential material never does.
 */
export class PostgresPatientPrincipalRegistry {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async bind(userId: string, patientId: PatientId): Promise<void> {
    await this.db.query(
      `INSERT INTO sdis.patient_principal_bindings (user_id, patient_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         patient_id = EXCLUDED.patient_id,
         updated_at = now()`,
      [userId, patientId],
    );
  }

  async resolvePatientId(userId: string): Promise<PatientId | undefined> {
    const result = await this.db.query(
      'SELECT patient_id FROM sdis.patient_principal_bindings WHERE user_id = $1',
      [userId],
    );
    const row = result.rows[0] as { patient_id: string } | undefined;
    return row?.patient_id as PatientId | undefined;
  }
}

/**
 * PostgreSQL Audit Port
 */
export class PostgresAuditPort implements AuditPort {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async record(event: AuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO sdis.audit_events (
                id, action, object_type, object_id, at,
                organization_id, facility_id, department_id,
                actor_kind, actor_id, actor_display_name,
                source_kind, source_label, source_ref,
                detail, previous_hash, event_hash
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        event.id,
        event.action,
        event.objectType,
        event.objectId,
        event.at,
        event.context.organizationId,
        event.context.facilityId,
        event.context.departmentId || null,
        event.provenance.actor.kind,
        event.provenance.actor.id,
        event.provenance.actor.displayName || null,
        event.provenance.source.kind,
        event.provenance.source.label,
        event.provenance.source.ref || null,
        event.detail || null,
        null,
        null, // Hash chain handled by trigger
      ],
    );
  }
}

/**
 * PostgreSQL Idempotency Store
 *
 * SEC-03: rows are tagged with the session facility parsed from the
 * facility-composed key (`scope:facility:key`, the shape every session-scoped
 * caller produces). The tag drives the RLS facility policy (migration 029);
 * unparseable (legacy/internal) keys store NULL and keep the historical
 * visibility until the 24-hour TTL expires them.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this.db.query(
      'SELECT value FROM sdis.idempotency_keys WHERE key = $1 AND expires_at > now()',
      [key],
    );
    if (result.rows.length === 0) return undefined;
    return result.rows[0].value as T;
  }

  async put<T>(key: string, value: T): Promise<void> {
    // Write-once for active keys (a recorded result is immutable), while
    // allowing an expired key to be re-recorded: replays must return the
    // FIRST stored result; only an expired row may be refreshed.
    await this.db.query(
      `INSERT INTO sdis.idempotency_keys (key, value, expires_at, facility_id)
             VALUES ($1, $2, now() + interval '24 hours', $3)
             ON CONFLICT (key) DO UPDATE SET
               value = EXCLUDED.value,
               expires_at = EXCLUDED.expires_at,
               facility_id = EXCLUDED.facility_id
             WHERE sdis.idempotency_keys.expires_at <= now()`,
      [key, JSON.stringify(value), facilityIdOfIdempotencyKey(key)],
    );
  }

  /**
   * IDEM-01 single-flight: a per-key advisory lock held for the whole
   * get→create→put unit. `pg_advisory_xact_lock` is a TRANSACTION-scoped lock,
   * so it releases at COMMIT/ROLLBACK — it can never leak on a pooled
   * connection (a session-level `pg_advisory_lock` would). Two processes
   * racing the same key serialize here: the loser blocks on the lock, then
   * reads the winner's committed result and its `create` never runs.
   */
  async withExclusive<T>(key: string, create: () => Promise<T>): Promise<T> {
    return this.db.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      const existing = await client.query<{ value: T }>(
        'SELECT value FROM sdis.idempotency_keys WHERE key = $1 AND expires_at > now()',
        [key],
      );
      if (existing.rows.length > 0) return existing.rows[0]?.value as T;
      const value = await create();
      await client.query(
        `INSERT INTO sdis.idempotency_keys (key, value, expires_at, facility_id)
               VALUES ($1, $2, now() + interval '24 hours', $3)
               ON CONFLICT (key) DO UPDATE SET
                 value = EXCLUDED.value,
                 expires_at = EXCLUDED.expires_at,
                 facility_id = EXCLUDED.facility_id
               WHERE sdis.idempotency_keys.expires_at <= now()`,
        [key, JSON.stringify(value), facilityIdOfIdempotencyKey(key)],
      );
      return value;
    });
  }
}

/**
 * Extracts the session facility from a facility-composed idempotency key
 * (`scope:facility:key`). Returns undefined for legacy/internal keys, which
 * store NULL facility and keep historical visibility until TTL expiry.
 * Misparse fails closed-safe: at worst a row is invisible to a future
 * lookup, which recomputes instead of replaying — never a cross-facility
 * plant or read.
 */
function facilityIdOfIdempotencyKey(key: string): string | undefined {
  const parts = key.split(':');
  if (parts.length >= 3 && parts[1] !== undefined && isUuidV4(parts[1])) {
    return parts[1];
  }
  return undefined;
}

// Ensure idempotency_keys table exists (will be created in a migration)
export async function ensureIdempotencyTable(
  db: Database = getDatabase(),
): Promise<void> {
  await db.query(`
        CREATE TABLE IF NOT EXISTS sdis.idempotency_keys (
            key TEXT PRIMARY KEY,
            value JSONB NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON sdis.idempotency_keys(expires_at);
    `);
}

/**
 * PostgreSQL external-system registry (Step 20).
 *
 * Backs the gateway's fail-closed registration check. `config_ref` is a
 * NON-SECRET configuration reference — no credential is ever stored or
 * returned here (secret management is a documented future dependency).
 */
export class PostgresExternalSystemRegistry {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async find(systemKey: string): Promise<ExternalSystemRecord | undefined> {
    const result = await this.db.query(
      `SELECT * FROM sdis.external_systems WHERE system_key = $1`,
      [systemKey],
    );
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0];
    return {
      systemKey: row.system_key as string,
      name: row.name as string,
      systemType: row.system_type as ExternalSystemRecord['systemType'],
      ...(row.organization_id ? { organizationId: row.organization_id as string } : {}),
      ...(row.facility_id ? { facilityId: row.facility_id as string } : {}),
      status: row.status as ExternalSystemRecord['status'],
      ...(row.config_ref ? { configRef: row.config_ref as string } : {}),
    };
  }

  /** Registers a system (idempotent per system_key via the unique constraint). */
  async register(system: ExternalSystemRecord & { readonly id: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO sdis.external_systems
           (id, system_key, name, system_type, organization_id, facility_id, status, config_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (system_key) DO UPDATE
           SET name = EXCLUDED.name,
               status = EXCLUDED.status,
               config_ref = EXCLUDED.config_ref,
               updated_at = now()`,
      [
        system.id,
        system.systemKey,
        system.name,
        system.systemType,
        system.organizationId ?? null,
        system.facilityId ?? null,
        system.status,
        system.configRef ?? null,
      ],
    );
  }
}

/**
 * PostgreSQL order external-reference store (Step 20).
 *
 * The correlation map external order id → canonical SDIS order id. Uniqueness
 * is per (system_key, external_ref); canonical ids are never overwritten.
 * The table is append-only at the privilege level, so a conflicting remap is
 * rejected by the database itself.
 */
export class PostgresOrderExternalReferenceStore {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async record(params: {
    systemKey: string;
    externalRef: string;
    orderId: DiagnosticOrderId;
    facilityId: FacilityId;
    correlationId?: string;
  }): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO sdis.order_external_references
             (id, system_key, external_ref, order_id, facility_id, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          uuidv4(),
          params.systemKey,
          params.externalRef,
          params.orderId,
          params.facilityId,
          params.correlationId ?? null,
        ],
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        (error as { code?: unknown }).code === '23505'
      ) {
        throw new ConflictError('External order reference is already mapped to an order');
      }
      throw error;
    }
  }

  async findOrderId(
    systemKey: string,
    externalRef: string,
  ): Promise<DiagnosticOrderId | undefined> {
    const result = await this.db.query(
      `SELECT order_id FROM sdis.order_external_references
             WHERE system_key = $1 AND external_ref = $2`,
      [systemKey, externalRef],
    );
    if (result.rows.length === 0) return undefined;
    return result.rows[0].order_id as DiagnosticOrderId;
  }
}
