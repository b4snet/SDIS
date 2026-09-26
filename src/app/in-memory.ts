/**
 * Deterministic in-memory adapters for the application ports.
 *
 * These are test/development infrastructure only. No PostgreSQL, no RLS, no
 * production persistence (docs/DATABASE.md). Entries are intentionally NOT
 * deep-frozen beyond what the domain already freezes so that services can build
 * updated revisions of records; the APPEND-ONLY audit store remains immutable.
 */

import type { AuditEvent, InMemoryAuditStore } from '../core/audit/audit';
import type { ExternalSystemRecord } from './integration/integration-gateway';
import { ConflictError } from './errors';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_NOTIFICATION_PRIORITY,
  DEFAULT_NOTIFICATION_RECIPIENT_SCOPE,
} from '../domain/notifications/notification';
import type {
  NotificationChannel,
  NotificationDeliveryAttempt,
  NotificationDeliveryStatus,
  NotificationEvent,
  NotificationEventType,
  NotificationIntent,
  NotificationIntentInput,
  NotificationOutbox,
  NotificationReceipt,
} from './notifications/notification-service';
import type { NotificationIntentId } from '../types/ids';
import type { Encounter } from '../domain/encounter/encounter';
import type { ExternalPatientReference } from '../types/external-reference';
import { PRIORITY_RANK } from '../domain/ordering/diagnostic-order';
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
import {
  type AuditPort,
  type EncounterDirectory,
  type FacilityDirectory,
  type IdempotencyStore,
  type InterpretationRepository,
  type ModalityDirectory,
  type ObservationRepository,
  type OrderRepository,
  type PatientDirectory,
  type PatientPrincipalRegistry,
  type ReportRepository,
  type SpecimenRepository,
} from './ports';
import type { PatientRegistrationRepository } from './patients/patient-service';

export class InMemoryPatientDirectory implements PatientDirectory {
  constructor(private readonly lookup: (id: PatientId) => Patient | undefined) {}

  async findById(patientId: PatientId): Promise<Patient | undefined> {
    return this.lookup(patientId);
  }

  /** Adapter over the Step-1 single identity source. */
  static fromIdentityService(service: {
    findById(id: PatientId): Patient | undefined;
  }): InMemoryPatientDirectory {
    return new InMemoryPatientDirectory((id) => service.findById(id));
  }
}

export class InMemoryEncounterDirectory implements EncounterDirectory {
  private readonly encounters = new Map<EncounterId, Encounter>();

  async findById(encounterId: EncounterId): Promise<Encounter | undefined> {
    return this.encounters.get(encounterId);
  }

  /** Fixture/registration entry for deterministic scenarios. */
  register(encounter: Encounter): Encounter {
    this.encounters.set(encounter.id, encounter);
    return encounter;
  }
}

export class InMemoryFacilityDirectory implements FacilityDirectory {
  private readonly facilities = new Map<FacilityId, Facility>();

  async findById(facilityId: FacilityId): Promise<Facility | undefined> {
    return this.facilities.get(facilityId);
  }

  /** Fixture/registration entry for deterministic scenarios. */
  register(facility: Facility): Facility {
    this.facilities.set(facility.id, facility);
    return facility;
  }
}

export class StaticModalityDirectory implements ModalityDirectory {
  constructor(private readonly names: readonly ModalityName[]) {}

  async has(name: ModalityName): Promise<boolean> {
    return this.names.includes(name);
  }
}

export class InMemoryOrderRepository implements OrderRepository {
  private readonly orders = new Map<DiagnosticOrderId, DiagnosticOrder>();
  private readonly itemIndex = new Map<OrderItemId, DiagnosticOrderId>();

  async save(order: DiagnosticOrder): Promise<DiagnosticOrder> {
    const existing = this.orders.get(order.id);
    // INT-33 CAS parity (LAB-02): mirrors the PG adapter exactly — a stale
    // write (the caller read an older version than the one stored here)
    // is refused with CONFLICT, never a silent lost update. In-memory tests
    // must not pass merely because the test double is weaker than PostgreSQL.
    if (existing && existing.version !== order.version) {
      throw new ConflictError(
        `Order was modified concurrently (version ${order.version} is stale) — re-read and retry`,
      );
    }
    // Mirrors the PG adapter: an INSERT stores the row at the initial
    // version; an UPDATE advances the stored version by one.
    const next = existing
      ? { ...order, version: existing.version + 1 }
      : { ...order, version: 1 };
    this.orders.set(order.id, next);
    for (const item of order.items) this.itemIndex.set(item.id, order.id);
    return next;
  }

  async findById(id: DiagnosticOrderId): Promise<DiagnosticOrder | undefined> {
    return this.orders.get(id);
  }

  /**
   * Deterministic operational worklist (Step 21): priority rank first
   * (EMERGENCY -> URGENT -> ROUTINE), then ordered-at, then id. Queue
   * ordering only — never clinical triage.
   */
  async listByFacilityWithPriority(
    facilityId: FacilityId,
  ): Promise<readonly DiagnosticOrder[]> {
    return Object.freeze(
      [...this.orders.values()]
        .filter((order) => order.facilityId === facilityId)
        .sort(
          (a, b) =>
            PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
            a.orderedAt.localeCompare(b.orderedAt) ||
            a.id.localeCompare(b.id),
        ),
    );
  }

  async findByOrderItemId(
    orderItemId: OrderItemId,
  ): Promise<DiagnosticOrder | undefined> {
    const orderId = this.itemIndex.get(orderItemId);
    return orderId === undefined ? undefined : this.orders.get(orderId);
  }
}

export class InMemorySpecimenRepository implements SpecimenRepository {
  private readonly specimens = new Map<SpecimenId, Specimen>();

  async save(specimen: Specimen): Promise<Specimen> {
    const existing = this.specimens.get(specimen.id);
    // INT-33 CAS parity (LAB-02): a stale write is refused with CONFLICT,
    // mirroring the PostgreSQL adapter — no silent lost updates in tests.
    if (existing && existing.version !== specimen.version) {
      throw new ConflictError(
        `Specimen was modified concurrently (version ${specimen.version} is stale) — re-read and retry`,
      );
    }
    const next = existing
      ? { ...specimen, version: existing.version + 1 }
      : { ...specimen, version: 1 };
    this.specimens.set(specimen.id, next);
    return next;
  }

  async findById(id: SpecimenId): Promise<Specimen | undefined> {
    return this.specimens.get(id);
  }

  async listByOrderItem(orderItemId: OrderItemId): Promise<readonly Specimen[]> {
    return [...this.specimens.values()].filter((s) => s.orderItemId === orderItemId);
  }

  async findByAccessionNumber(
    facilityId: FacilityId,
    accessionNumber: string,
  ): Promise<Specimen | undefined> {
    // Facility ownership is resolved through the specimen's order; the
    // in-memory mirror tracks the facility on the record for the probe.
    return [...this.specimens.values()].find(
      (s) => s.accessionNumber === accessionNumber,
    );
  }

  /** Step 29 worklist read: deterministic (collected-at, then id). */
  async listByFacilityWithStatus(
    facilityId: FacilityId,
    statuses: readonly Specimen['status'][],
  ): Promise<readonly Specimen[]> {
    return [...this.specimens.values()]
      .filter((s) => statuses.includes(s.status))
      .sort(
        (a, b) =>
          a.collectedAt.localeCompare(b.collectedAt) ||
          String(a.id).localeCompare(String(b.id)),
      );
  }
}

export class InMemoryObservationRepository implements ObservationRepository {
  private readonly observations = new Map<ObservationId, Observation>();

  async save(observation: Observation): Promise<Observation> {
    this.observations.set(observation.id, observation);
    return observation;
  }

  async findById(id: ObservationId): Promise<Observation | undefined> {
    return this.observations.get(id);
  }

  async listByOrderItem(orderItemId: OrderItemId): Promise<readonly Observation[]> {
    return [...this.observations.values()].filter((o) => o.orderItemId === orderItemId);
  }
}

export class InMemoryInterpretationRepository implements InterpretationRepository {
  private readonly interpretations = new Map<InterpretationId, Interpretation>();

  async save(interpretation: Interpretation): Promise<Interpretation> {
    this.interpretations.set(interpretation.id, interpretation);
    return interpretation;
  }

  async findById(id: InterpretationId): Promise<Interpretation | undefined> {
    return this.interpretations.get(id);
  }

  async listByOrderItem(orderItemId: OrderItemId): Promise<readonly Interpretation[]> {
    return [...this.interpretations.values()].filter(
      (i) => i.orderItemId === orderItemId,
    );
  }
}

export class InMemoryReportRepository implements ReportRepository {
  private readonly reports = new Map<ReportId, DiagnosticReport>();

  async save(report: DiagnosticReport): Promise<DiagnosticReport> {
    this.reports.set(report.id, report);
    return report;
  }

  async findById(id: ReportId): Promise<DiagnosticReport | undefined> {
    return this.reports.get(id);
  }

  async listByPatientAndFacility(
    patientId: PatientId,
    facilityId: FacilityId,
  ): Promise<readonly DiagnosticReport[]> {
    return [...this.reports.values()]
      .filter(
        (report) => report.patientId === patientId && report.facilityId === facilityId,
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}

/**
 * In-memory patient principal registry (Step 22): the application-level
 * ownership binding between an authenticated patient principal and its ONE
 * canonical patient identity. Production binds this port at the runtime
 * edge (credential/identity infrastructure); no binding is ever accepted
 * from the client.
 */
export class InMemoryPatientPrincipalRegistry implements PatientPrincipalRegistry {
  private readonly bindings = new Map<string, PatientId>();

  bind(userId: string, patientId: PatientId): void {
    this.bindings.set(userId, patientId);
  }

  async resolvePatientId(userId: string): Promise<PatientId | undefined> {
    return this.bindings.get(userId);
  }
}

/** Append-only audit adapter over the Step-1 audit store contract. */
export class AuditLogPort implements AuditPort {
  constructor(private readonly store: InMemoryAuditStore) {}

  async record(event: Parameters<AuditPort['record']>[0]): Promise<void> {
    await this.store.append(event);
  }

  /** Read for audit/invariant checks; returns a snapshot, never the live store. */
  list(): readonly AuditEvent[] {
    return [...this.store.list()];
  }
}

/**
 * In-memory patient registration repository (test/development adapter).
 * Backs the patient application service with the same reference-uniqueness
 * semantics as the PostgreSQL schema (system+facility+value UNIQUE).
 */
export class InMemoryPatientRegistrationRepository implements PatientRegistrationRepository {
  private readonly patients = new Map<PatientId, Patient>();
  private readonly refs = new Map<string, PatientId>();

  async save(patient: Patient): Promise<Patient> {
    this.patients.set(patient.id, patient);
    for (const ref of patient.externalReferences) {
      this.refs.set(this.refKey(ref), patient.id);
    }
    return patient;
  }

  async saveExternalReference(
    patientId: PatientId,
    ref: ExternalPatientReference,
  ): Promise<void> {
    const patient = this.patients.get(patientId);
    if (patient) {
      this.patients.set(patientId, {
        ...patient,
        externalReferences: [...patient.externalReferences, Object.freeze(ref)],
      });
    }
    this.refs.set(this.refKey(ref), patientId);
  }

  async findWithReferences(patientId: PatientId): Promise<Patient | undefined> {
    return this.patients.get(patientId);
  }

  async findPatientIdByExternalReference(
    ref: ExternalPatientReference,
  ): Promise<PatientId | undefined> {
    return this.refs.get(this.refKey(ref));
  }

  private refKey(ref: ExternalPatientReference): string {
    return `${ref.system.toUpperCase()}::${ref.facilityId}::${ref.value}`;
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, unknown>();
  private readonly exclusives = new Map<string, Promise<unknown>>();

  async get<T>(key: string): Promise<T | undefined> {
    // Single documented narrowing point: values are only ever written through
    // the typed put<T> below, so a stored value always has the requested type.
    // Callers never cast; the interface stays generic.
    return this.entries.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
  }

  /**
   * IDEM-01 single-flight: per-key promise chain serializes same-key callers
   * within this process. Different actor code never runs twice for one key.
   */
  withExclusive<T>(key: string, create: () => Promise<T>): Promise<T> {
    const predecessor = this.exclusives.get(key) ?? Promise.resolve();
    const run = predecessor
      .catch(() => undefined) // a failed predecessor never blocks its successor
      .then(async () => {
        const existing = await this.get<T>(key);
        if (existing !== undefined) return existing;
        const value = await create();
        await this.put(key, value);
        return value;
      });
    this.exclusives.set(key, run);
    // IDEM-01 cleanup without leaking a rejection: `Promise.prototype.finally`
    // on a REJECTED `run` returns a rejecting promise that nobody observes —
    // node's test runner reports that unhandledRejection as a failing file.
    // Attaching an (onFulfilled, onRejected) pair resolves in both cases.
    const cleanup = (): void => {
      if (this.exclusives.get(key) === run) this.exclusives.delete(key);
    };
    void run.then(cleanup, cleanup);
    return run;
  }
}

/**
 * Deterministic in-memory notification channel adapter (Step 19).
 *
 * Test/development infrastructure on the `NotificationChannelAdapter` port:
 * records every delivered event for assertions, and can be pre-programmed to
 * reject/fail deterministically (by event type) so failure and duplicate
 * delivery behavior is provable without any real provider.
 */
export class InMemoryNotificationAdapter {
  readonly channel: NotificationChannel = 'IN_MEMORY';
  private readonly delivered: NotificationEvent[] = [];
  private readonly failures = new Map<string, 'REJECTED' | 'FAILED'>();

  constructor(private readonly clock: () => string = () => new Date().toISOString()) {}

  /** Program a deterministic rejection/failure for the given event type. */
  programFailure(eventType: NotificationEventType, as: 'REJECTED' | 'FAILED'): void {
    this.failures.set(eventType, as);
  }

  async deliver(event: NotificationEvent): Promise<NotificationReceipt> {
    const programmed = this.failures.get(event.type);
    if (programmed) {
      return {
        eventId: event.eventId,
        channel: this.channel,
        attempt: 1,
        status: programmed,
        failureCategory:
          programmed === 'REJECTED' ? 'INVALID_DESTINATION' : 'TEMPORARY_FAILURE',
        occurredAt: this.clock(),
      };
    }
    this.delivered.push(event);
    return {
      eventId: event.eventId,
      channel: this.channel,
      attempt: 1,
      status: 'DELIVERED',
      occurredAt: this.clock(),
    };
  }

  /** Delivered events, for subscriber-style assertions in tests. */
  getDelivered(): readonly NotificationEvent[] {
    return this.delivered;
  }

  countDeliveredOfType(type: NotificationEventType): number {
    return this.delivered.filter((event) => event.type === type).length;
  }
}

/**
 * In-memory external-system registry (Step 20) — mirrors the PostgreSQL
 * registry's fail-closed contract for composition and tests: an unknown key
 * resolves to `undefined` and a DISABLED system must be refused by callers.
 * Holds identity metadata only — never credentials.
 */
export class InMemoryExternalSystemRegistry {
  private readonly systems = new Map<string, ExternalSystemRecord>();

  async find(systemKey: string): Promise<ExternalSystemRecord | undefined> {
    return this.systems.get(systemKey);
  }

  register(system: ExternalSystemRecord): void {
    this.systems.set(system.systemKey, system);
  }
}

/**
 * In-memory order external-reference store (Step 20) — mirrors the PostgreSQL
 * store's contract: uniqueness per (external system, external reference), the
 * canonical order id is never overwritten, and a conflicting remap throws the
 * existing ConflictError.
 */
export class InMemoryOrderReferenceStore {
  private readonly refs = new Map<string, { orderId: string; facilityId: string }>();

  private key(systemKey: string, externalRef: string): string {
    return `${systemKey}::${externalRef}`;
  }

  async record(params: {
    systemKey: string;
    externalRef: string;
    orderId: DiagnosticOrderId;
    facilityId: FacilityId;
    correlationId?: string;
  }): Promise<void> {
    const key = this.key(params.systemKey, params.externalRef);
    if (this.refs.has(key)) {
      throw new ConflictError('External order reference is already mapped to an order');
    }
    this.refs.set(key, { orderId: params.orderId, facilityId: params.facilityId });
  }

  async findOrderId(
    systemKey: string,
    externalRef: string,
  ): Promise<DiagnosticOrderId | undefined> {
    return this.refs.get(this.key(systemKey, externalRef))?.orderId as
      DiagnosticOrderId | undefined;
  }
}

/**
 * In-memory notification outbox (Step 19) — mirrors the PostgreSQL store's
 * contract: event dedup by key, per-(event, channel) intent uniqueness,
 * conditional (CAS) claiming/settling so concurrent dispatchers never deliver
 * one intent twice, append-only attempt ledger, and facility-scoped reads.
 * Test/development infrastructure only (no persistence, no RLS).
 */
export class InMemoryNotificationOutbox implements NotificationOutbox {
  private readonly events = new Map<string, NotificationEvent>();
  private readonly eventKeys = new Map<string, string>();
  private readonly intents = new Map<string, NotificationIntent>();
  private readonly attempts = new Map<string, NotificationDeliveryAttempt[]>();

  async enqueue(input: {
    readonly event: NotificationEvent;
    readonly eventKey: string;
    readonly intents: readonly NotificationIntentInput[];
    readonly now: string;
  }): Promise<{ event: NotificationEvent; intents: readonly NotificationIntent[] }> {
    const existingEventId = this.eventKeys.get(input.eventKey);
    const canonical = existingEventId ? this.events.get(existingEventId) : input.event;
    if (!canonical) {
      throw new Error('In-memory notification outbox invariant violated');
    }
    if (!existingEventId) {
      this.events.set(input.event.eventId, input.event);
      this.eventKeys.set(input.eventKey, input.event.eventId);
    }
    const enqueued: NotificationIntent[] = [];
    for (const intentInput of input.intents) {
      const existing = this.findIntentFor(canonical.eventId, intentInput.channel);
      if (existing) {
        enqueued.push(existing);
        continue;
      }
      const intent: NotificationIntent = {
        id: randomUUID() as NotificationIntentId,
        eventId: canonical.eventId,
        eventType: canonical.type,
        correlationId: canonical.correlationId,
        channel: intentInput.channel,
        status: 'PENDING',
        priority: intentInput.priority ?? DEFAULT_NOTIFICATION_PRIORITY,
        recipientScope:
          intentInput.recipientScope ?? DEFAULT_NOTIFICATION_RECIPIENT_SCOPE,
        ...(intentInput.recipientRef ? { recipientRef: intentInput.recipientRef } : {}),
        attemptCount: 0,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        organizationId: canonical.organizationId,
        facilityId: canonical.facilityId,
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.intents.set(intent.id, intent);
      this.attempts.set(intent.id, []);
      enqueued.push(intent);
    }
    return { event: canonical, intents: enqueued };
  }

  async listByFacility(
    facilityId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{
    items: readonly NotificationIntent[];
    nextCursor: string | null;
  }> {
    const sorted = [...this.intents.values()]
      .filter((i) => i.facilityId === facilityId)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? b.id.localeCompare(a.id)
          : b.createdAt.localeCompare(a.createdAt),
      );
    let start = 0;
    if (opts.cursor) {
      const [cursorAt, cursorId] = splitCursor(opts.cursor);
      const index = sorted.findIndex(
        (i) => i.createdAt === cursorAt && i.id === cursorId,
      );
      // Unknown cursor → empty page (never leak other facilities' positions).
      start = index >= 0 ? index + 1 : sorted.length;
    }
    const limit = opts.limit ?? 50;
    const slice = sorted.slice(start, start + limit);
    const last = slice.length > 0 ? slice[slice.length - 1] : undefined;
    const nextCursor =
      last && sorted.length > start + limit ? `${last.createdAt}|${last.id}` : null;
    return { items: slice, nextCursor };
  }

  async findById(
    facilityId: string,
    intentId: string,
  ): Promise<NotificationIntent | undefined> {
    const intent = this.intents.get(intentId);
    return intent && intent.facilityId === facilityId ? intent : undefined;
  }

  async findEvent(
    facilityId: string,
    eventId: string,
  ): Promise<NotificationEvent | undefined> {
    const event = this.events.get(eventId);
    return event && event.facilityId === facilityId ? event : undefined;
  }

  async listAttempts(
    facilityId: string,
    intentId: string,
  ): Promise<readonly NotificationDeliveryAttempt[]> {
    const intent = this.intents.get(intentId);
    if (!intent || intent.facilityId !== facilityId) return [];
    return [...(this.attempts.get(intentId) ?? [])].sort(
      (a, b) => a.attemptNumber - b.attemptNumber,
    );
  }

  async claimDue(
    facilityId: string,
    opts: { limit: number; leaseMs: number; now: number },
  ): Promise<readonly NotificationIntent[]> {
    const nowIso = new Date(opts.now).toISOString();
    const leaseCutoff = new Date(opts.now - opts.leaseMs).toISOString();
    // Finalize exhausted rows first (same ordering as the PG store).
    for (const intent of this.intents.values()) {
      if (
        intent.facilityId === facilityId &&
        (intent.status === 'FAILED' || intent.status === 'RETRYING') &&
        intent.attemptCount >= intent.maxAttempts
      ) {
        this.intents.set(intent.id, {
          ...intent,
          status: 'PERMANENTLY_FAILED',
          failedAt: nowIso,
          updatedAt: nowIso,
        });
      }
    }
    const due = [...this.intents.values()]
      .filter((i) => i.facilityId === facilityId)
      .filter((i) => {
        if (
          (i.status === 'PENDING' || i.status === 'FAILED' || i.status === 'RETRYING') &&
          i.attemptCount < i.maxAttempts
        ) {
          return !i.nextAttemptAt || i.nextAttemptAt <= nowIso;
        }
        if (i.status === 'PROCESSING' && i.lastAttemptAt) {
          return i.lastAttemptAt <= leaseCutoff;
        }
        return false;
      })
      .sort((a, b) => {
        const atA = a.nextAttemptAt ?? a.createdAt;
        const atB = b.nextAttemptAt ?? b.createdAt;
        return atA === atB ? a.id.localeCompare(b.id) : atA.localeCompare(atB);
      })
      .slice(0, opts.limit);
    for (const intent of due) {
      this.intents.set(intent.id, {
        ...intent,
        status: 'PROCESSING',
        updatedAt: nowIso,
      });
    }
    return due.map((intent) => ({ ...intent, status: 'PROCESSING' as const }));
  }

  async settle(settlement: {
    readonly intentId: NotificationIntentId;
    readonly expectedStatus: NotificationDeliveryStatus;
    readonly toStatus: NotificationDeliveryStatus;
    readonly attempt: NotificationDeliveryAttempt;
    readonly nextAttemptAt?: string;
    readonly failureReason?: string;
  }): Promise<boolean> {
    const intent = this.intents.get(settlement.intentId);
    if (!intent || intent.status !== settlement.expectedStatus) return false;
    const ledger = this.attempts.get(settlement.intentId) ?? [];
    if (ledger.some((a) => a.attemptNumber === settlement.attempt.attemptNumber)) {
      return false; // duplicate worker execution (mirrors the DB UNIQUE guard)
    }
    const { toStatus, attempt, nextAttemptAt, failureReason } = settlement;
    this.attempts.set(settlement.intentId, [...ledger, attempt]);
    this.intents.set(settlement.intentId, {
      ...intent,
      status: toStatus,
      attemptCount: attempt.attemptNumber,
      lastAttemptAt: attempt.attemptedAt,
      nextAttemptAt,
      failureReason: failureReason ?? undefined,
      ...(toStatus === 'DELIVERED' ? { deliveredAt: attempt.attemptedAt } : {}),
      ...(toStatus === 'FAILED' ||
      toStatus === 'RETRYING' ||
      toStatus === 'PERMANENTLY_FAILED'
        ? { failedAt: attempt.attemptedAt }
        : {}),
      updatedAt: attempt.attemptedAt,
    });
    return true;
  }

  async cancel(
    intentId: string,
    from: NotificationDeliveryStatus,
    at: string,
  ): Promise<boolean> {
    const intent = this.intents.get(intentId);
    if (!intent || intent.status !== from) return false;
    if (from !== 'PENDING' && from !== 'FAILED' && from !== 'RETRYING') return false;
    this.intents.set(intentId, {
      ...intent,
      status: 'CANCELLED',
      cancelledAt: at,
      updatedAt: at,
    });
    return true;
  }

  async requeue(
    intentId: string,
    from: NotificationDeliveryStatus,
    at: string,
  ): Promise<boolean> {
    const intent = this.intents.get(intentId);
    if (!intent || intent.status !== from) return false;
    if (from !== 'FAILED' && from !== 'RETRYING') return false;
    this.intents.set(intentId, {
      ...intent,
      status: 'PENDING',
      nextAttemptAt: undefined,
      updatedAt: at,
    });
    return true;
  }

  private findIntentFor(
    eventId: string,
    channel: NotificationChannel,
  ): NotificationIntent | undefined {
    for (const intent of this.intents.values()) {
      if (intent.eventId === eventId && intent.channel === channel) return intent;
    }
    return undefined;
  }
}

/** `createdAt|id` cursor split (ISO timestamps + UUIDs never contain '|'). */
function splitCursor(cursor: string): [string, string] {
  const separator = cursor.lastIndexOf('|');
  if (separator < 0) return ['', ''];
  return [cursor.slice(0, separator), cursor.slice(separator + 1)];
}
