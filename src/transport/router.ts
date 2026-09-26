/**
 * SDIS HTTP transport — route table.
 *
 * Binds the repository-supported laboratory operations (docs/API_CONTRACTS.md
 * §8) to HTTP. Every handler performs three transport-only duties:
 *
 *   1. transport-shape validation (presence, JSON shape, id format),
 *   2. session enforcement (fail-closed; see session.ts),
 *   3. delegation to the EXISTING application services — scope, identity,
 *      lifecycle, idempotency, audit, and persistence are enforced below the
 *      transport layer, never here.
 *
 * No business logic lives in this file and no route ever touches PostgreSQL
 * directly. Authorship refs on reports are bound to the session actor by the
 * transport; client-supplied author fields are not accepted over HTTP (the
 * audit provenance actor is session-derived by construction).
 *
 * Response DTOs are the application DTO boundary (`src/app/dto.ts`) verbatim —
 * never domain entities, repository rows, or audit internals. Collections are
 * returned as bare JSON arrays; the Step-29 worklist views are the exception
 * and return keyset pagination metadata (`items` + `nextCursor`) in the body
 * (docs/API_CONTRACTS.md §4).
 */

import type { ApplicationSession } from '../app/context';
import type { InterpretationService } from '../app/laboratory/interpretation-service';
import type { ObservationService } from '../app/laboratory/observation-service';
import type { OrderService } from '../app/laboratory/order-service';
import type { ReportService } from '../app/laboratory/report-service';
import type { SpecimenService } from '../app/laboratory/specimen-service';
import type { PatientService } from '../app/patients/patient-service';
import type { TerminologyPersistenceService } from '../app/terminology/terminology-service';
import type { BillingService } from '../app/billing/billing-service';
import type { DeviceIngestionService } from '../app/devices/device-ingestion-service';
import type {
  DocumentService,
  DocumentContentDTO,
} from '../app/documents/document-service';
import type {
  InventoryService,
  ItemDTO,
  LotDTO,
  MovementDTO,
  ItemBalanceDTO,
} from '../app/inventory/inventory-service';
import type {
  SetupConfigService,
  SetupConfigDTO,
} from '../app/setup/setup-config-service';
import {
  INTEGRATION_OPERATIONS,
  type IntegrationGateway,
  type IntegrationAcknowledgement,
  type IntegrationOperation,
} from '../app/integration/integration-gateway';
import {
  NOTIFICATION_EVENT_TYPES,
  type NotificationService,
} from '../app/notifications/notification-service';
import type { ConfigFamily } from '../domain/master-setup/master-setup';
import { isUuidV4 } from '../types/ids';
import type { DiagnosticOrderStatus } from '../domain/ordering/diagnostic-order';
import type { SpecimenKind, SpecimenStatus } from '../domain/specimen/specimen';
import { TransportFailure } from './errors';
import { requireResolvedSession } from './session';
import * as v from './validate';

/**
 * Structural view of the laboratory application runtime the transport serves.
 * Typed over the APPLICATION services only — the transport never imports
 * infrastructure. Composition (e.g. `createPostgresLaboratoryRuntime`) happens
 * at the deployment/composition edge and is injected here.
 */
export interface TransportRuntime {
  readonly orders?: OrderService;
  readonly specimens?: SpecimenService;
  readonly observations?: ObservationService;
  readonly interpretations?: InterpretationService;
  readonly reports?: ReportService;
  /** Registration & intake (Step 6). */
  readonly patients?: PatientService;
  /** Terminology persistence (Step 7). */
  readonly terminology?: TerminologyPersistenceService;
  /** Diagnostic charge lifecycle (Step 8). */
  readonly billing?: BillingService;
  /** Device ingestion foundation (Step 9). */
  readonly devices?: DeviceIngestionService;
  /** Document management foundation (Step 13). */
  readonly documents?: DocumentService;
  /** Laboratory inventory foundation (Step 14). */
  readonly inventory?: InventoryService;
  /** Master setup configuration (Step 15). */
  readonly setup?: SetupConfigService;
  /** Quality management (Step 27) — records + analytical hold boundary. */
  readonly quality?: import('../app/quality/quality-service').QualityService;
  /** Department master data (Step 24) — lifecycle administration. */
  readonly departments?: import('../app/setup/department-service').DepartmentService;
  /** Integration gateway (Step 17). */
  readonly integration?: IntegrationGateway;
  /** Notifications & event delivery (Step 19). */
  readonly notifications?: NotificationService;
  /** Diagnostic worklist (Step 21) — deterministic priority read model. */
  readonly worklist?: import('../app/laboratory/worklist-service').WorklistService;
  /** Patient-facing report access (Step 22) — ownership-scoped read boundary. */
  readonly patientReports?: import('../app/patient-access/report-access-service').PatientReportAccessService;
  /** Patient-facing document access (Step 23) — explicitly-visible docs only. */
  readonly patientDocuments?: import('../app/patient-access/document-access-service').PatientDocumentAccessService;
}

export interface TransportDependencies {
  readonly runtime: TransportRuntime;
}

export interface Handled {
  readonly status: number;
  readonly body: unknown;
  /**
   * Raw content response (Step 13): binary document content served outside
   * the JSON envelope. When present the server streams `bytes` with the
   * given MIME type instead of JSON-serializing `body`.
   */
  readonly content?: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly downloadName: string;
  };
}

export type Router = (
  method: 'GET' | 'POST',
  url: string,
  body: v.Json | undefined,
  session: ApplicationSession | undefined,
  meta: { readonly headers: Record<string, string | string[] | undefined> },
) => Promise<Handled | undefined>;

/**
 * Capability accessors over the partially-specified runtime: routes whose
 * capability is absent respond 404 (the runtime predates the capability),
 * without weakening type narrowing for routes that use it.
 */
function requireCapability<T>(
  runtime: TransportRuntime,
  name:
    | 'orders'
    | 'specimens'
    | 'observations'
    | 'interpretations'
    | 'reports'
    | 'patients'
    | 'terminology'
    | 'billing'
    | 'devices'
    | 'documents'
    | 'inventory'
    | 'quality'
    | 'setup'
    | 'departments'
    | 'integration'
    | 'notifications'
    | 'worklist'
    | 'patientReports'
    | 'patientDocuments',
): T {
  const service = runtime[name] as T | undefined;
  if (!service) {
    throw new TransportFailure(404, 'Resource not found', [], 'NOT_FOUND');
  }
  return service;
}

function headerString(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * `Idempotency-Key` header wins over a body field (docs/API_CONTRACTS.md §4);
 * the application-level idempotency store remains the ONLY engine.
 */
function idempotencyKeyOf(
  obj: Record<string, v.Json>,
  meta: { readonly headers: Record<string, string | string[] | undefined> },
): string | undefined {
  return (
    headerString(meta.headers, 'idempotency-key') ??
    v.optionalString(obj, 'idempotencyKey')
  );
}

const API_PREFIX = ['api', 'v1'] as const;

export function createRouter(deps: TransportDependencies): Router {
  const runtime = deps.runtime;

  return async function route(method, url, body, session, meta) {
    const segments = new URL(url, 'http://sdis.internal').pathname
      .split('/')
      .filter(Boolean);
    if (segments[0] !== API_PREFIX[0] || segments[1] !== API_PREFIX[1]) {
      return undefined; // outside the API prefix → unhandled (404)
    }
    const [, , head, second, third, fourth, fifth] = segments;

    // ---- Patient registration & intake (Step 6) ---------------------------
    // NOTE: routes below use `runtime.patients` guarded by presence checks so
    // the transport stays usable with runtimes that predate the capability.
    if (head === 'patients' && method === 'POST' && !second) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const patient = await requireCapability<PatientService>(
        runtime,
        'patients',
      ).registerPatient(session, {
        fullName: v.requiredString(obj, 'fullName'),
        sex: v.requiredString(obj, 'sex') as 'F' | 'M' | 'OTHER' | 'UNKNOWN',
        birthDate: v.optionalString(obj, 'birthDate'),
        externalReferences: obj['externalReferences']
          ? (
              obj['externalReferences'] as unknown as readonly {
                system: string;
                value: string;
              }[]
            ).map((ref) => ({
              system: v.requiredString(ref as never, 'system'),
              value: v.requiredString(ref as never, 'value'),
            }))
          : undefined,
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 201, body: patient };
    }

    if (head === 'patients' && method === 'GET' && second && !third) {
      requireResolvedSession(session);
      const patient = await requireCapability<PatientService>(
        runtime,
        'patients',
      ).getPatient(session, v.parsePatientId(second));
      return { status: 200, body: patient };
    }

    if (
      head === 'patients' &&
      method === 'POST' &&
      second &&
      third === 'external-identifiers' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const patient = await requireCapability<PatientService>(
        runtime,
        'patients',
      ).attachExternalIdentifier(session, {
        patientId: v.parsePatientId(second),
        system: v.requiredString(obj, 'system'),
        value: v.requiredString(obj, 'value'),
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 201, body: patient };
    }

    // ---- Terminology persistence (Step 7) ----------------------------------
    if (head === 'terminology' && method === 'POST' && second === 'mappings' && !third) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const mapping = await requireCapability<TerminologyPersistenceService>(
        runtime,
        'terminology',
      ).createMapping(session, {
        canonicalCode: v.requiredString(obj, 'canonicalCode'),
        externalSystem: v.requiredString(obj, 'externalSystem'),
        externalCode: v.requiredString(obj, 'externalCode'),
        validated: obj['validated'] === true,
        global: obj['global'] === true,
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 201, body: mapping };
    }

    if (head === 'terminology' && method === 'GET' && second === 'mappings' && third) {
      requireResolvedSession(session);
      const mapping = await requireCapability<TerminologyPersistenceService>(
        runtime,
        'terminology',
      ).getMapping(session, v.parseTerminologyMappingId(third));
      return { status: 200, body: mapping };
    }

    if (
      head === 'terminology' &&
      method === 'GET' &&
      second === 'resolve' &&
      third &&
      fourth
    ) {
      requireResolvedSession(session);
      const mappings = await requireCapability<TerminologyPersistenceService>(
        runtime,
        'terminology',
      ).resolveMappings(session, decodeURIComponent(third), decodeURIComponent(fourth));
      return { status: 200, body: mappings };
    }

    // ---- Device ingestion foundation (Step 9) -------------------------------
    if (
      head === 'devices' &&
      method === 'POST' &&
      second &&
      third === 'acquisitions' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      // DEV-03: a linked acquisition (orderItemId present) REQUIRES the vendor
      // rawPayload object — an omitted payload must be a 422 at the boundary,
      // never a downstream TypeError/500.
      const linked = obj['orderItemId'] !== undefined;
      const acquisition = await requireCapability<DeviceIngestionService>(
        runtime,
        'devices',
      ).ingest(session, {
        deviceId: v.parseDeviceId(second),
        adapterId: v.requiredString(obj, 'adapterId'),
        acquiredAt: v.requiredTimestamp(obj, 'acquiredAt'),
        rawPayload: linked
          ? v.requireObjectField(obj, 'rawPayload')
          : (obj['rawPayload'] ?? undefined),
        orderItemId: obj['orderItemId']
          ? v.parseOrderItemId(v.requiredUuid(obj, 'orderItemId'))
          : undefined,
        patientId: obj['patientId']
          ? v.parsePatientId(v.requiredUuid(obj, 'patientId'))
          : undefined,
        ingestionKey: v.requiredString(obj, 'ingestionKey'),
      });
      return { status: 201, body: acquisition };
    }

    // ---- Diagnostic charge lifecycle (Step 8) -------------------------------
    if (head === 'charges' && method === 'POST' && !second) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const charge = await requireCapability<BillingService>(
        runtime,
        'billing',
      ).createCharge(session, {
        orderId: v.parseOrderId(v.requiredUuid(obj, 'orderId')),
        orderItemId: v.parseOrderItemId(v.requiredUuid(obj, 'orderItemId')),
        serviceId: v.requiredUuid(obj, 'serviceId') as never,
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 201, body: charge };
    }

    if (head === 'charges' && method === 'GET' && second && !third) {
      requireResolvedSession(session);
      const charge = await requireCapability<BillingService>(
        runtime,
        'billing',
      ).getCharge(session, v.parseChargeId(second));
      return { status: 200, body: charge };
    }

    if (
      head === 'diagnostic-orders' &&
      method === 'GET' &&
      second &&
      third === 'charges' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const charges = await requireCapability<BillingService>(
        runtime,
        'billing',
      ).listChargesForOrder(session, v.parseOrderId(second));
      return { status: 200, body: charges };
    }

    // ---- Diagnostic orders -------------------------------------------------
    if (head === 'diagnostic-orders' && method === 'POST' && !second) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const order = await requireCapability<OrderService>(runtime, 'orders').createOrder(
        session,
        {
          patientId: v.parsePatientId(v.requiredUuid(obj, 'patientId')),
          encounterId: v.parseEncounterId(v.requiredUuid(obj, 'encounterId')),
          modality: v.requiredString(obj, 'modality'),
          items: v.requiredItems(obj, 'items'),
          orderedAt: v.requiredTimestamp(obj, 'orderedAt'),
          priority: v.optionalString(obj, 'priority'),
          idempotencyKey: idempotencyKeyOf(obj, meta),
        },
      );
      return { status: 201, body: order };
    }

    if (head === 'diagnostic-orders' && method === 'GET' && second && !third) {
      requireResolvedSession(session);
      const order = await requireCapability<OrderService>(runtime, 'orders').getOrder(
        session,
        v.parseOrderId(second),
      );
      return { status: 200, body: order };
    }

    if (
      head === 'diagnostic-orders' &&
      method === 'POST' &&
      second &&
      third === 'transitions' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      // The target vocabulary is enforced by the domain state machine below
      // the transport; an unknown target surfaces as INVALID_STATE_TRANSITION
      // (409) from the application boundary — no vocabulary duplication here.
      const order = await requireCapability<OrderService>(
        runtime,
        'orders',
      ).transitionOrder(
        session,
        v.parseOrderId(second),
        v.requiredString(obj, 'to') as DiagnosticOrderStatus,
        v.requiredTimestamp(obj, 'at'),
        {
          detail: v.optionalString(obj, 'detail'),
          source: obj['source'] ? v.requiredSource(obj, 'source') : undefined,
        },
      );
      return { status: 200, body: order };
    }

    // Priority change (Step 21): operational only, validated + audited +
    // idempotent in the order service; no vocabulary duplication here.
    if (
      head === 'diagnostic-orders' &&
      method === 'POST' &&
      second &&
      third === 'priority' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const order = await requireCapability<OrderService>(
        runtime,
        'orders',
      ).changeOrderPriority(
        session,
        v.parseOrderId(second),
        v.requiredString(obj, 'priority'),
        v.requiredTimestamp(obj, 'at'),
        { idempotencyKey: idempotencyKeyOf(obj, meta) },
      );
      return { status: 200, body: order };
    }

    // Facility worklist (Step 21): deterministic operational queue ordering
    // (priority rank, then ordered-at, then id) — never clinical triage.
    if (head === 'worklist' && method === 'GET' && !second) {
      requireResolvedSession(session);
      // Step 27 read-model filters: query-string narrowing of the SAME
      // authoritative facility worklist. Facility scope stays server-derived;
      // unknown values surface as 422 (status) or are ignored (dates).
      const query = new URL(url, 'http://sdis.internal').searchParams;
      const status = query.get('status') ?? undefined;
      const priority = query.get('priority') ?? undefined;
      // Filter vocabularies are validated (422 on unknown values) so a typo
      // can never silently return a broader or empty worklist.
      const ORDER_STATUSES = [
        'ORDERED',
        'ACQUIRED',
        'PROCESSING',
        'RESULT_ENTERED',
        'VERIFIED',
        'FINALIZED',
        'REPORTED',
        'CANCELLED',
      ] as const;
      const PRIORITIES = ['ROUTINE', 'URGENT', 'EMERGENCY'] as const;
      if (
        status !== undefined &&
        !(ORDER_STATUSES as readonly string[]).includes(status)
      ) {
        throw new TransportFailure(422, `Unknown worklist status filter: ${status}`);
      }
      if (
        priority !== undefined &&
        !(PRIORITIES as readonly string[]).includes(priority)
      ) {
        throw new TransportFailure(422, `Unknown worklist priority filter: ${priority}`);
      }
      const filters = {
        ...(status ? { status: status as never } : {}),
        ...(priority ? { priority: priority as never } : {}),
        ...(query.get('from') ? { from: query.get('from') as string } : {}),
        ...(query.get('to') ? { to: query.get('to') as string } : {}),
      };
      const entries = await requireCapability<
        import('../app/laboratory/worklist-service').WorklistService
      >(runtime, 'worklist').listForSession(session, filters);
      return { status: 200, body: entries };
    }

    // Typed operational worklist views (Step 29): the SAME authoritative read
    // model parameterized per workflow stage (collection, accessioning,
    // processing, result-entry, verification, finalization, exception). The
    // view vocabulary is validated here (422 on unknown); every permission,
    // scope, and ordering decision stays in the application service.
    if (head === 'worklists' && method === 'GET' && second && !third) {
      requireResolvedSession(session);
      const VIEWS = [
        'collection',
        'accessioning',
        'processing',
        'result-entry',
        'verification',
        'finalization',
        'exception',
      ] as const;
      if (!(VIEWS as readonly string[]).includes(second)) {
        throw new TransportFailure(422, `Unknown worklist view: ${second}`);
      }
      const query = new URL(url, 'http://sdis.internal').searchParams;
      const priority = query.get('priority') ?? undefined;
      if (
        priority !== undefined &&
        !['ROUTINE', 'URGENT', 'EMERGENCY'].includes(priority)
      ) {
        throw new TransportFailure(422, `Unknown worklist priority filter: ${priority}`);
      }
      const limitRaw = query.get('limit') ?? undefined;
      let limit: number | undefined;
      if (limitRaw !== undefined) {
        limit = Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1) {
          throw new TransportFailure(422, 'limit must be a positive integer');
        }
      }
      const page = await requireCapability<
        import('../app/laboratory/worklist-service').WorklistService
      >(runtime, 'worklist').listView(session, second as never, {
        ...(priority ? { priority: priority as never } : {}),
        ...(query.get('testCode') ? { testCode: query.get('test') as string } : {}),
        ...(query.get('from') ? { from: query.get('from') as string } : {}),
        ...(query.get('to') ? { to: query.get('to') as string } : {}),
        ...(query.get('cursor') ? { cursor: query.get('cursor') as string } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return { status: 200, body: page };
    }

    // ---- Patient report access (Step 22) -----------------------------------
    // Ownership-scoped read boundary: the authenticated PATIENT principal is
    // resolved server-side; no patient/report identifier from the client is
    // ever treated as ownership proof. Errors reuse the existing taxonomy and
    // never reveal whether a foreign or unfinalized report exists.
    if (head === 'patient' && method === 'GET' && second === 'reports' && !third) {
      requireResolvedSession(session);
      const views = await requireCapability<
        import('../app/patient-access/report-access-service').PatientReportAccessService
      >(runtime, 'patientReports').listMyReports(session);
      return { status: 200, body: views };
    }
    if (head === 'patient' && method === 'GET' && second === 'reports' && third) {
      requireResolvedSession(session);
      const view = await requireCapability<
        import('../app/patient-access/report-access-service').PatientReportAccessService
      >(runtime, 'patientReports').getMyReport(session, v.parseReportId(third));
      return { status: 200, body: view };
    }

    // ---- Specimens ----------------------------------------------------------
    if (
      head === 'order-items' &&
      method === 'POST' &&
      second &&
      third === 'specimens' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const specimen = await requireCapability<SpecimenService>(
        runtime,
        'specimens',
      ).collectSpecimen(session, {
        orderItemId: v.parseOrderItemId(second),
        patientId: v.parsePatientId(v.requiredUuid(obj, 'patientId')),
        kind: v.requiredString(obj, 'kind') as SpecimenKind,
        collectedAt: v.requiredTimestamp(obj, 'collectedAt'),
        collectedByRef: v.optionalString(obj, 'collectedByRef'),
        idempotencyKey: idempotencyKeyOf(obj, meta),
        source: obj['source'] ? v.requiredSource(obj, 'source') : undefined,
      });
      return { status: 201, body: specimen };
    }

    if (
      head === 'specimens' &&
      method === 'POST' &&
      second &&
      third === 'transitions' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const specimen = await requireCapability<SpecimenService>(
        runtime,
        'specimens',
      ).transitionSpecimen(
        session,
        v.parseSpecimenId(second),
        v.requiredString(obj, 'to') as SpecimenStatus,
        v.requiredTimestamp(obj, 'at'),
        {
          detail: v.optionalString(obj, 'detail'),
          source: obj['source'] ? v.requiredSource(obj, 'source') : undefined,
          // Step 27: exception reason (required for REJECTED) and the
          // accession prefix pass through to the application boundary.
          rejectionReason: v.optionalString(obj, 'rejectionReason') as never,
          accessionPrefix: v.optionalString(obj, 'accessionPrefix'),
          idempotencyKey: idempotencyKeyOf(obj, meta),
        },
      );
      return { status: 200, body: specimen };
    }

    // ---- Observations --------------------------------------------------------
    if (
      head === 'order-items' &&
      method === 'POST' &&
      second &&
      third === 'observations' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const observation = await requireCapability<ObservationService>(
        runtime,
        'observations',
      ).enterObservation(session, {
        orderItemId: v.parseOrderItemId(second),
        patientId: v.parsePatientId(v.requiredUuid(obj, 'patientId')),
        specimenId: obj['specimenId']
          ? v.parseSpecimenId(v.requiredUuid(obj, 'specimenId'))
          : undefined,
        code: v.requiredString(obj, 'code'),
        codeSystem: v.requiredString(obj, 'codeSystem'),
        value: v.requiredObservationValue(obj, 'value'),
        unit: v.optionalString(obj, 'unit'),
        issuedBy: v.requiredSource(obj, 'issuedBy'),
        at: v.requiredTimestamp(obj, 'at'),
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 201, body: observation };
    }

    if (
      head === 'order-items' &&
      method === 'GET' &&
      second &&
      third === 'observations' &&
      !fourth
    ) {
      requireResolvedSession(session);
      return {
        status: 200,
        body: await requireCapability<ObservationService>(
          runtime,
          'observations',
        ).listForOrderItem(session, v.parseOrderItemId(second)),
      };
    }

    // ---- Interpretations -----------------------------------------------------
    if (
      head === 'order-items' &&
      method === 'POST' &&
      second &&
      third === 'interpretations' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const interpretation = await requireCapability<InterpretationService>(
        runtime,
        'interpretations',
      ).addInterpretation(session, {
        orderItemId: v.parseOrderItemId(second),
        source: v.requiredSource(obj, 'source'),
        text: v.requiredString(obj, 'text'),
        at: v.requiredTimestamp(obj, 'at'),
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 201, body: interpretation };
    }

    if (
      head === 'order-items' &&
      method === 'GET' &&
      second &&
      third === 'interpretations' &&
      !fourth
    ) {
      requireResolvedSession(session);
      return {
        status: 200,
        body: await requireCapability<InterpretationService>(
          runtime,
          'interpretations',
        ).listForOrderItem(session, v.parseOrderItemId(second)),
      };
    }

    // ---- Reports -------------------------------------------------------------
    if (
      head === 'diagnostic-orders' &&
      method === 'POST' &&
      second &&
      third === 'reports' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const report = await requireCapability<ReportService>(
        runtime,
        'reports',
      ).createReport(session, {
        orderId: v.parseOrderId(second),
        content: v.requiredString(obj, 'content'),
        authoredByRef: sessionActorRef(session),
        authoredAt: v.requiredTimestamp(obj, 'authoredAt'),
        idempotencyKey: idempotencyKeyOf(obj, meta),
        source: obj['source'] ? v.requiredSource(obj, 'source') : undefined,
      });
      return { status: 201, body: report };
    }

    if (
      head === 'reports' &&
      method === 'POST' &&
      second &&
      third === 'finalize' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const report = await requireCapability<ReportService>(
        runtime,
        'reports',
      ).finalizeReport(
        session,
        v.parseReportId(second),
        sessionActorRef(session),
        v.requiredTimestamp(obj, 'at'),
        {
          source: obj['source'] ? v.requiredSource(obj, 'source') : undefined,
          idempotencyKey: idempotencyKeyOf(obj, meta),
        },
      );
      return { status: 200, body: report };
    }

    if (
      head === 'reports' &&
      method === 'POST' &&
      second &&
      third === 'amendments' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const report = await requireCapability<ReportService>(
        runtime,
        'reports',
      ).amendReport(session, {
        reportId: v.parseReportId(second),
        content: v.requiredString(obj, 'content'),
        authoredByRef: sessionActorRef(session),
        authoredAt: v.requiredTimestamp(obj, 'authoredAt'),
        // Step 28: the amendment reason is REQUIRED and vocabulary-validated
        // by the application service (422 on missing/unknown values).
        amendmentReason: v.requiredString(obj, 'amendmentReason'),
        idempotencyKey: idempotencyKeyOf(obj, meta),
        source: obj['source'] ? v.requiredSource(obj, 'source') : undefined,
      });
      return { status: 200, body: report };
    }

    if (head === 'reports' && method === 'GET' && second && !third) {
      requireResolvedSession(session);
      const report = await requireCapability<ReportService>(runtime, 'reports').getReport(
        session,
        v.parseReportId(second),
      );
      return { status: 200, body: report };
    }

    // ---- Document management foundation (Step 13) ---------------------------
    if (head === 'documents' && method === 'POST' && !second) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const document = await requireCapability<DocumentService>(
        runtime,
        'documents',
      ).storeDocument(session, {
        documentType: v.requiredString(obj, 'documentType') as never,
        displayName: v.requiredString(obj, 'displayName'),
        mimeType: v.requiredString(obj, 'mimeType'),
        bytes: base64ToBytes(v.requiredString(obj, 'contentBase64')),
        ...(obj['patientId']
          ? { patientId: v.parsePatientId(v.requiredUuid(obj, 'patientId')) }
          : {}),
        ...(obj['orderItemId']
          ? { orderItemId: v.parseOrderItemId(v.requiredUuid(obj, 'orderItemId')) }
          : {}),
        ...(obj['retentionUntil']
          ? { retentionUntil: v.requiredTimestamp(obj, 'retentionUntil') }
          : {}),
        ...(obj['patientVisible'] !== undefined
          ? { patientVisible: obj['patientVisible'] === true }
          : {}),
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 201, body: document };
    }

    if (
      head === 'documents' &&
      method === 'GET' &&
      second &&
      third === 'content' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const content: DocumentContentDTO = await requireCapability<DocumentService>(
        runtime,
        'documents',
      ).getDocumentContent(session, v.parseDocumentId(second));
      return {
        status: 200,
        body: undefined,
        content: {
          bytes: content.bytes,
          mimeType: content.mimeType,
          downloadName: content.displayName,
        },
      };
    }

    if (head === 'documents' && method === 'GET' && second && !third) {
      requireResolvedSession(session);
      const document = await requireCapability<DocumentService>(
        runtime,
        'documents',
      ).getDocument(session, v.parseDocumentId(second));
      return { status: 200, body: document };
    }

    // Staff per-patient document listing (Step 23): scope is server-derived
    // from the session facility; the patient must exist in the same scope.
    if (
      head === 'patients' &&
      method === 'GET' &&
      second &&
      third === 'documents' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const documents = await requireCapability<DocumentService>(
        runtime,
        'documents',
      ).listDocumentsForPatient(session, v.parsePatientId(second));
      return { status: 200, body: documents };
    }

    // Retirement (Step 23): removes ACCESS, never content. Audited and
    // idempotent via the existing engine.
    if (head === 'documents' && method === 'POST' && second && third === 'retire') {
      requireResolvedSession(session);
      const document = await requireCapability<DocumentService>(
        runtime,
        'documents',
      ).retireDocument(session, v.parseDocumentId(second), {
        idempotencyKey: idempotencyKeyOf((body as Record<string, v.Json>) ?? {}, meta),
      });
      return { status: 200, body: document };
    }

    // ---- Patient document access (Step 23) ---------------------------------
    // Explicitly patient-visible documents only, through the Step-22
    // ownership gate. Foreign / non-visible / retired / unknown are the same
    // indistinguishable 404.
    if (head === 'patient' && method === 'GET' && second === 'documents' && !third) {
      requireResolvedSession(session);
      const docs = await requireCapability<
        import('../app/patient-access/document-access-service').PatientDocumentAccessService
      >(runtime, 'patientDocuments').listMyDocuments(session);
      return { status: 200, body: docs };
    }
    if (
      head === 'patient' &&
      method === 'GET' &&
      second === 'documents' &&
      third &&
      fourth === 'content' &&
      !fifth
    ) {
      requireResolvedSession(session);
      const content = await requireCapability<
        import('../app/patient-access/document-access-service').PatientDocumentAccessService
      >(runtime, 'patientDocuments').getMyDocumentContent(
        session,
        v.parseDocumentId(third),
      );
      return {
        status: 200,
        body: undefined,
        content: {
          bytes: content.bytes,
          mimeType: content.mimeType,
          downloadName: content.displayName,
        },
      };
    }
    if (head === 'patient' && method === 'GET' && second === 'documents' && third) {
      requireResolvedSession(session);
      const doc = await requireCapability<
        import('../app/patient-access/document-access-service').PatientDocumentAccessService
      >(runtime, 'patientDocuments').getMyDocument(session, v.parseDocumentId(third));
      return { status: 200, body: doc };
    }

    // ---- Laboratory inventory foundation (Step 14) -------------------------
    if (head === 'inventory' && method === 'POST' && second === 'items' && !third) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const item: ItemDTO = await requireCapability<InventoryService>(
        runtime,
        'inventory',
      ).registerItem(session, {
        sku: v.requiredString(obj, 'sku'),
        name: v.requiredString(obj, 'name'),
        category: v.requiredString(obj, 'category') as never,
      });
      return { status: 201, body: item };
    }

    if (head === 'inventory' && method === 'POST' && second === 'lots' && !third) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const lot: LotDTO = await requireCapability<InventoryService>(
        runtime,
        'inventory',
      ).registerLot(session, {
        itemId: v.parseInventoryItemId(v.requiredUuid(obj, 'itemId')),
        lotNumber: v.requiredString(obj, 'lotNumber'),
        expiryDate: v.requiredString(obj, 'expiryDate'),
        receivedQuantity: requiredPositiveNumber(obj, 'receivedQuantity'),
      });
      return { status: 201, body: lot };
    }

    if (head === 'inventory' && method === 'POST' && second === 'receive' && !third) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const movement: MovementDTO = await requireCapability<InventoryService>(
        runtime,
        'inventory',
      ).receiveStock(session, {
        itemId: v.parseInventoryItemId(v.requiredUuid(obj, 'itemId')),
        lotNumber: v.requiredString(obj, 'lotNumber'),
        expiryDate: v.requiredString(obj, 'expiryDate'),
        quantity: requiredPositiveNumber(obj, 'quantity'),
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 201, body: movement };
    }

    if (head === 'inventory' && method === 'POST' && second === 'issue' && !third) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const movementType = v.requiredString(obj, 'movementType');
      if (
        movementType !== 'OUT' &&
        movementType !== 'WASTAGE' &&
        movementType !== 'RETURN'
      ) {
        throw v.bad('Field "movementType" must be OUT, WASTAGE, or RETURN');
      }
      const movement: MovementDTO = await requireCapability<InventoryService>(
        runtime,
        'inventory',
      ).issueStock(session, {
        batchId: v.parseInventoryItemId(v.requiredUuid(obj, 'batchId')),
        quantity: requiredPositiveNumber(obj, 'quantity'),
        movementType,
        reason: v.requiredString(obj, 'reason'),
        ...(v.optionalString(obj, 'operationRef')
          ? { operationRef: v.optionalString(obj, 'operationRef') as string }
          : {}),
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 201, body: movement };
    }

    if (
      head === 'inventory' &&
      method === 'GET' &&
      second === 'items' &&
      third &&
      fourth === 'balance' &&
      !fifth
    ) {
      requireResolvedSession(session);
      const balance: ItemBalanceDTO = await requireCapability<InventoryService>(
        runtime,
        'inventory',
      ).getBalance(session, v.parseInventoryItemId(third));
      return { status: 200, body: balance };
    }

    if (
      head === 'inventory' &&
      method === 'GET' &&
      second === 'items' &&
      third &&
      fourth === 'lots' &&
      !fifth
    ) {
      requireResolvedSession(session);
      const item = await requireCapability<InventoryService>(
        runtime,
        'inventory',
      ).getLotStatus(session, v.parseInventoryItemId(third));
      return { status: 200, body: item };
    }

    // ---- Inventory lifecycle completion (Step 31) --------------------------
    // Controlled lot transition (quarantine/release/retire) — audited, reasoned.
    if (
      head === 'inventory' &&
      method === 'POST' &&
      second === 'lots' &&
      third &&
      fourth === 'status' &&
      !fifth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const target = v.requiredString(obj, 'target');
      if (
        target !== 'AVAILABLE' &&
        target !== 'QUARANTINED' &&
        target !== 'RELEASED' &&
        target !== 'RETIRED'
      ) {
        throw v.bad(
          'Field "target" must be AVAILABLE, QUARANTINED, RELEASED, or RETIRED',
        );
      }
      const lot: LotDTO = await requireCapability<InventoryService>(
        runtime,
        'inventory',
      ).changeLotStatus(session, {
        batchId: v.parseInventoryItemId(third),
        target,
        reason: v.requiredString(obj, 'reason'),
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 200, body: lot };
    }

    // Item operational lifecycle (retire/reactivate) — audited, reasoned.
    if (
      head === 'inventory' &&
      method === 'POST' &&
      second === 'items' &&
      third &&
      fourth === 'status' &&
      !fifth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const activeRaw = obj['active'];
      if (typeof activeRaw !== 'boolean') {
        throw v.bad('Field "active" must be a boolean');
      }
      const item: ItemDTO = await requireCapability<InventoryService>(
        runtime,
        'inventory',
      ).changeItemStatus(session, {
        itemId: v.parseInventoryItemId(third),
        active: activeRaw,
        reason: v.requiredString(obj, 'reason'),
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 200, body: item };
    }

    // Expiring lots (Step 31 §11): bounded horizonDays query (1-365).
    if (head === 'inventory' && method === 'GET' && second === 'expiring' && !third) {
      requireResolvedSession(session);
      const query = new URL(url, 'http://sdis.internal').searchParams;
      const horizonRaw = query.get('horizonDays');
      const horizonDays = horizonRaw === null ? 30 : Number(horizonRaw);
      const lots = await requireCapability<InventoryService>(
        runtime,
        'inventory',
      ).listExpiringLots(session, horizonDays);
      return { status: 200, body: lots };
    }

    // FEFO selection (Step 31 §12): deterministic read-only pick; the caller
    // consumes through the separately-gated issueStock.
    if (
      head === 'inventory' &&
      method === 'GET' &&
      second === 'items' &&
      third &&
      fourth === 'fefo-selection' &&
      !fifth
    ) {
      requireResolvedSession(session);
      const selected = await requireCapability<InventoryService>(
        runtime,
        'inventory',
      ).selectLotForConsumption(session, v.parseInventoryItemId(third));
      return { status: 200, body: selected ?? {} };
    }

    // Lot usage traceability (Step 31 §14): full movement history of one lot.
    if (
      head === 'inventory' &&
      method === 'GET' &&
      second === 'lots' &&
      third &&
      fourth === 'usage' &&
      !fifth
    ) {
      requireResolvedSession(session);
      const usage = await requireCapability<InventoryService>(
        runtime,
        'inventory',
      ).getLotUsage(session, v.parseInventoryItemId(third));
      return { status: 200, body: usage };
    }

    // Operation-centric usage traceability (Step 31 §14).
    if (
      head === 'inventory' &&
      method === 'GET' &&
      second === 'operations' &&
      third &&
      fourth === 'usage' &&
      !fifth
    ) {
      requireResolvedSession(session);
      const usage = await requireCapability<InventoryService>(
        runtime,
        'inventory',
      ).getOperationUsage(session, decodeURIComponent(third));
      return { status: 200, body: usage };
    }

    // ---- Master setup configuration (Step 15) ----------------------------
    if (head === 'setup' && second === 'config' && method === 'POST' && !third) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const config: SetupConfigDTO = await requireCapability<SetupConfigService>(
        runtime,
        'setup',
      ).createConfig(session, {
        family: v.requiredString(obj, 'family') as ConfigFamily,
        key: v.requiredString(obj, 'key'),
        value: obj['value'] as never,
        effectiveFrom: v.requiredTimestamp(obj, 'effectiveFrom'),
        ...(obj['sourceVersion']
          ? { sourceVersion: v.requiredString(obj, 'sourceVersion') }
          : {}),
        ...(obj['departmentId']
          ? { departmentId: v.parseDepartmentId(v.requiredUuid(obj, 'departmentId')) }
          : {}),
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 201, body: config };
    }

    if (head === 'setup' && second === 'config' && method === 'GET' && !third) {
      requireResolvedSession(session);
      const configs = await requireCapability<SetupConfigService>(
        runtime,
        'setup',
      ).listApplicable(session);
      return { status: 200, body: { configs } };
    }

    // ---- Notifications & event delivery (Step 19) -------------------------
    // Delivery receipt read model. Events themselves are emitted INSIDE
    // application services (never via HTTP); the bus is not a public API.
    if (
      head === 'notifications' &&
      second === 'deliveries' &&
      method === 'GET' &&
      third &&
      !fourth
    ) {
      requireResolvedSession(session);
      const eventId = decodeURIComponent(third);
      if (!isUuidV4(eventId)) {
        throw new TransportFailure(
          422,
          'Event id must be a UUID v4 identifier',
          [],
          'VALIDATION_FAILED',
        );
      }
      const receipts = await requireCapability<NotificationService>(
        runtime,
        'notifications',
      ).getDelivery(session, eventId);
      return { status: 200, body: { eventId, receipts } };
    }

    if (
      head === 'notifications' &&
      second === 'event-types' &&
      method === 'GET' &&
      !third
    ) {
      requireResolvedSession(session);
      return { status: 200, body: { eventTypes: NOTIFICATION_EVENT_TYPES } };
    }

    // Step 19 durable read models + lifecycle: outbox-backed delivery intents,
    // facility-scoped. List/detail DTOs never expose payloads or secrets;
    // retry and cancel are manager-tier (NOTIFICATION_MANAGE) actions.
    if (head === 'notifications' && method === 'GET' && !second) {
      requireResolvedSession(session);
      const query = new URL(url, 'http://sdis.internal').searchParams;
      const cursor = query.get('cursor') ?? undefined;
      const limitRaw = query.get('limit');
      let limit: number | undefined;
      if (limitRaw !== null && limitRaw !== undefined) {
        limit = Number(limitRaw);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new TransportFailure(
            422,
            'limit must be an integer between 1 and 100',
            [],
            'VALIDATION_FAILED',
          );
        }
      }
      const page = await requireCapability<NotificationService>(
        runtime,
        'notifications',
      ).listNotifications(session, {
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return { status: 200, body: page };
    }

    if (
      head === 'notifications' &&
      method === 'GET' &&
      second &&
      !third &&
      second !== 'deliveries' &&
      second !== 'event-types'
    ) {
      requireResolvedSession(session);
      const detail = await requireCapability<NotificationService>(
        runtime,
        'notifications',
      ).getNotification(session, v.parseNotificationIntentId(decodeURIComponent(second)));
      return { status: 200, body: detail };
    }

    if (
      head === 'notifications' &&
      method === 'POST' &&
      second &&
      third === 'retry' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const intent = await requireCapability<NotificationService>(
        runtime,
        'notifications',
      ).retryNotification(
        session,
        v.parseNotificationIntentId(decodeURIComponent(second)),
        { at: v.requiredTimestamp(obj, 'at') },
      );
      return { status: 200, body: intent };
    }

    if (
      head === 'notifications' &&
      method === 'POST' &&
      second &&
      third === 'cancel' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const intent = await requireCapability<NotificationService>(
        runtime,
        'notifications',
      ).cancelNotification(
        session,
        v.parseNotificationIntentId(decodeURIComponent(second)),
        { at: v.requiredTimestamp(obj, 'at') },
      );
      return { status: 200, body: intent };
    }

    if (
      head === 'setup' &&
      second === 'config' &&
      method === 'GET' &&
      third === 'versions' &&
      fourth &&
      !fifth
    ) {
      requireResolvedSession(session);
      const config = await requireCapability<SetupConfigService>(
        runtime,
        'setup',
      ).getConfigById(session, v.parseSetupConfigId(fourth));
      return { status: 200, body: config };
    }

    // ---- Department master data (Step 24) ----------------------------------
    // Administration of the EXISTING canonical departments: lifecycle and
    // scope are enforced in the application service; no business rules here.
    if (head === 'departments' && method === 'POST' && !second) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const department = await requireCapability<
        import('../app/setup/department-service').DepartmentService
      >(runtime, 'departments').createDepartment(session, {
        name: v.requiredString(obj, 'name'),
        code: v.requiredString(obj, 'code'),
        ...(Array.isArray(obj['modalities'])
          ? { modalities: (obj['modalities'] as v.Json[]).map(String) }
          : {}),
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 201, body: department };
    }
    if (head === 'departments' && method === 'GET' && !second) {
      requireResolvedSession(session);
      const departments = await requireCapability<
        import('../app/setup/department-service').DepartmentService
      >(runtime, 'departments').listDepartments(session);
      return { status: 200, body: departments };
    }
    if (head === 'departments' && method === 'GET' && second && !third) {
      requireResolvedSession(session);
      const department = await requireCapability<
        import('../app/setup/department-service').DepartmentService
      >(runtime, 'departments').getDepartment(session, v.parseDepartmentId(second));
      return { status: 200, body: department };
    }
    // Deactivation is a POST lifecycle action (state-changing, idempotent).
    if (
      head === 'departments' &&
      method === 'POST' &&
      second &&
      third === 'deactivate' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const department = await requireCapability<
        import('../app/setup/department-service').DepartmentService
      >(runtime, 'departments').deactivateDepartment(
        session,
        v.parseDepartmentId(second),
        {
          idempotencyKey: idempotencyKeyOf((body ?? {}) as Record<string, v.Json>, meta),
        },
      );
      return { status: 200, body: department };
    }

    // ---- Quality management (Step 27) ---------------------------------------
    // Records + the analytical-hold boundary. Holds pause report finalization
    // (application boundary); they never touch patient results.
    if (head === 'quality' && method === 'POST' && second === 'records' && !third) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const hold = obj['hold'] as { reason?: unknown } | undefined;
      const record = await requireCapability<
        import('../app/quality/quality-service').QualityService
      >(runtime, 'quality').recordQuality(session, {
        family: v.requiredString(obj, 'family') as never,
        referenceType: v.requiredString(obj, 'referenceType'),
        ...(obj['referenceId']
          ? { referenceId: v.requiredString(obj, 'referenceId') }
          : {}),
        at: v.requiredTimestamp(obj, 'at'),
        ...(obj['note'] ? { note: v.requiredString(obj, 'note') } : {}),
        ...(hold && typeof hold === 'object' && typeof hold['reason'] === 'string'
          ? { hold: { reason: hold['reason'] } }
          : {}),
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 201, body: record };
    }

    if (head === 'quality' && method === 'GET' && second === 'records' && !third) {
      requireResolvedSession(session);
      const query = new URL(url, 'http://sdis.internal').searchParams;
      const family = query.get('family') ?? undefined;
      const records = await requireCapability<
        import('../app/quality/quality-service').QualityService
      >(runtime, 'quality').listQuality(session, family as never);
      return { status: 200, body: { records } };
    }

    if (
      head === 'quality' &&
      method === 'POST' &&
      second === 'holds' &&
      third === 'release' &&
      !fourth
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const released = await requireCapability<
        import('../app/quality/quality-service').QualityService
      >(runtime, 'quality').releaseHold(session, {
        holdId: v.parseQualityRecordId(v.requiredUuid(obj, 'holdId')),
        at: v.requiredTimestamp(obj, 'at'),
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 200, body: released };
    }

    if (
      head === 'setup' &&
      second === 'config' &&
      method === 'GET' &&
      third &&
      fourth &&
      !fifth
    ) {
      requireResolvedSession(session);
      const config = await requireCapability<SetupConfigService>(
        runtime,
        'setup',
      ).getConfig(session, {
        family: decodeURIComponent(third) as ConfigFamily,
        key: decodeURIComponent(fourth),
      });
      return { status: 200, body: config };
    }

    if (
      head === 'setup' &&
      second === 'config' &&
      method === 'POST' &&
      third &&
      fourth &&
      fifth === 'versions'
    ) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const config: SetupConfigDTO = await requireCapability<SetupConfigService>(
        runtime,
        'setup',
      ).updateConfig(session, {
        family: decodeURIComponent(third) as ConfigFamily,
        key: decodeURIComponent(fourth),
        value: obj['value'] as never,
        effectiveFrom: v.requiredTimestamp(obj, 'effectiveFrom'),
        ...(obj['sourceVersion']
          ? { sourceVersion: v.requiredString(obj, 'sourceVersion') }
          : {}),
        ...(obj['departmentId']
          ? { departmentId: v.parseDepartmentId(v.requiredUuid(obj, 'departmentId')) }
          : {}),
        expectedVersion: v.requiredVersionNumber(obj, 'expectedVersion'),
        idempotencyKey: idempotencyKeyOf(obj, meta),
      });
      return { status: 201, body: config };
    }

    // ---- Integration gateway (Step 17) ------------------------------------
    // The transport only shapes requests and maps outcomes onto status codes;
    // every integration rule lives in the gateway and the services it calls.
    if (head === 'integration' && second === 'requests' && method === 'POST' && !third) {
      requireResolvedSession(session);
      const obj = v.requireObject(body);
      const operation = v.requiredString(obj, 'operation');
      if (!(INTEGRATION_OPERATIONS as readonly string[]).includes(operation)) {
        throw v.bad('Unsupported integration operation');
      }
      const payload = obj['payload'];
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw v.bad('Field "payload" must be a JSON object');
      }
      const acknowledgement: IntegrationAcknowledgement =
        await requireCapability<IntegrationGateway>(runtime, 'integration').handle(
          session,
          {
            system: v.requiredString(obj, 'system'),
            operation: operation as IntegrationOperation,
            payload: payload as Record<string, unknown>,
            ...(obj['correlationId']
              ? { correlationId: v.requiredString(obj, 'correlationId') }
              : {}),
            idempotencyKey: idempotencyKeyOf(obj, meta),
          },
        );
      return {
        status: acknowledgement.outcome === 'CREATED' ? 201 : 200,
        body: acknowledgement,
      };
    }

    if (
      head === 'integration' &&
      method === 'GET' &&
      (second === 'orders' || second === 'reports') &&
      third &&
      !fourth
    ) {
      requireResolvedSession(session);
      const system = headerString(meta.headers, 'x-integration-system');
      if (!system) {
        throw v.bad('Header "x-integration-system" is required');
      }
      const gateway = requireCapability<IntegrationGateway>(runtime, 'integration');
      const acknowledgement: IntegrationAcknowledgement = await gateway.handle(session, {
        system,
        operation: second === 'orders' ? 'ORDER_STATUS' : 'FETCH_REPORT',
        payload:
          second === 'orders'
            ? { orderId: decodeURIComponent(third) }
            : { reportId: decodeURIComponent(third) },
      });
      return { status: 200, body: acknowledgement };
    }

    return undefined; // unhandled → 404 by the server
  };
}

/** A JSON number field that must be a positive finite number (422 otherwise). */
function requiredPositiveNumber(obj: Record<string, v.Json>, field: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw v.bad(`Field "${field}" must be a positive number`);
  }
  return value;
}

/**
 * Decodes the base64 content field of an upload. Invalid base64 is a 422
 * (transport shape), never a silent corruption path. Node's decoder is
 * lenient, so validity is verified by re-encoding.
 */
function base64ToBytes(value: string): Uint8Array {
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length === 0 || buffer.toString('base64') !== value) {
    throw new TransportFailure(422, 'Field "contentBase64" is not valid base64');
  }
  return new Uint8Array(buffer);
}

/** The acting principal (never a client-supplied author). */
function sessionActorRef(session: ApplicationSession): string {
  return session.actor.id;
}
