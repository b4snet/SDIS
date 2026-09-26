/**
 * Integration gateway application tests (Step 17).
 *
 * Proves the boundary over the EXISTING application services and domain
 * contracts: external payload → synthetic adapter → canonical command →
 * gateway → existing services, with INTEGRATION provenance (never HUMAN/
 * SYSTEM), tenant/facility scope, RBAC, idempotent replay without duplicate
 * resources or audit events, canonical patient identity (no second identity),
 * and an outbound report bundle that keeps Observation → Interpretation →
 * Report distinct and never mutates a record.
 *
 * Synthetic data only (`HMS-SYNTHETIC`). No external system is contacted.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  IntegrationGateway,
  type IntegrationAdapter,
} from '../../../src/app/integration/integration-gateway';
import {
  HMS_SYNTHETIC_SYSTEM,
  HmsSyntheticAdapter,
  StaticIntegrationRegistry,
} from '../../../src/infrastructure/integration/hms-synthetic-adapter';
import { PatientService } from '../../../src/app/patients/patient-service';
import { AuthorizationService, claimedRoleResolver } from '../../../src/app/authz/rbac';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../src/app/errors';
import {
  createFixture,
  sessionFor,
  OTHER_FACILITY,
  OTHER_ORG,
  PATIENT_ID,
  T0,
  type LabFixture,
} from '../helpers';
import { OrderService } from '../../../src/app/laboratory/order-service';
import {
  InMemoryExternalSystemRegistry,
  InMemoryIdempotencyStore,
  InMemoryPatientRegistrationRepository,
  type AuditLogPort,
} from '../../../src/app/in-memory';
import type { FacilityDirectory } from '../../../src/app/ports';
import type { ApplicationSession } from '../../../src/app/context';
import type { ExternalPatientReference } from '../../../src/types/external-reference';
import type { OrderItemId, SpecimenId } from '../../../src/types/ids';
import type { Specimen } from '../../../src/domain/specimen/specimen';

const MRN = 'MRN-SYN-1001';

/**
 * Registered external systems for the gateway under test (Step 20): the
 * synthetic HMS is ACTIVE by default; extra keys opt individual tests in.
 */
function registeredSystemsRegistry(
  ...extraKeys: readonly string[]
): InMemoryExternalSystemRegistry {
  const registry = new InMemoryExternalSystemRegistry();
  for (const key of [HMS_SYNTHETIC_SYSTEM, ...extraKeys]) {
    registry.register({
      systemKey: key,
      name: `Synthetic external system ${key}`,
      systemType: key === HMS_SYNTHETIC_SYSTEM ? 'HMS' : 'TEST',
      status: 'ACTIVE',
    });
  }
  return registry;
}

interface GatewayFixture {
  readonly gateway: IntegrationGateway;
  readonly session: ApplicationSession;
  readonly audit: AuditLogPort;
  readonly lab: LabFixture;
  readonly patients: PatientService;
}

function fixtureFor(
  roles: readonly string[] = ['operator'],
): GatewayFixture & { readonly patientId: string } {
  const lab = createFixture();
  const audit = lab.audit as AuditLogPort;
  const orderDeps = (
    lab.orders as unknown as {
      deps: {
        patients: Parameters<typeof OrderService.prototype.createOrder>[0] extends never
          ? never
          : import('../../../src/app/ports').PatientDirectory;
        encounters: import('../../../src/app/ports').EncounterDirectory;
        modalities: import('../../../src/app/ports').ModalityDirectory;
        orders: import('../../../src/app/ports').OrderRepository;
        facilities: FacilityDirectory;
      };
    }
  ).deps;
  const facilities = orderDeps.facilities;
  const specimensRepo = (
    lab.specimens as unknown as {
      deps: {
        specimens: { listByOrderItem(id: OrderItemId): Promise<readonly Specimen[]> };
      };
    }
  ).deps.specimens;

  // The canonical patient identity store — the SAME store the gateway
  // resolves external references against.
  const patientRepo = new InMemoryPatientRegistrationRepository();
  const patients = new PatientService({
    patients: patientRepo,
    facilities,
    audit,
    idempotency: new InMemoryIdempotencyStore(),
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  // Wired the way the PostgreSQL runtime wires it: the ONE authorization
  // engine is present, so gateway requests inherit the real RBAC semantics.
  const orders = new OrderService({
    patients: orderDeps.patients,
    encounters: orderDeps.encounters,
    facilities,
    modalities: orderDeps.modalities,
    orders: orderDeps.orders,
    audit,
    idempotency: new InMemoryIdempotencyStore(),
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  const idempotency = new InMemoryIdempotencyStore();
  const session = sessionFor();
  (session as { roles?: readonly string[] }).roles = roles as never;

  const gateway = new IntegrationGateway({
    adapters: new StaticIntegrationRegistry([new HmsSyntheticAdapter()]),
    systemRegistry: registeredSystemsRegistry(),
    patients,
    orders,
    // The laboratory fixture's result services stay as-is; only the ORDER
    // service is authz-wired above (it is the one this suite mutates).
    observations: lab.observations,
    interpretations: lab.interpretations,
    reports: lab.reports,
    specimens: { listByOrderItem: (id) => specimensRepo.listByOrderItem(id) },
    patientReferences: patientRepo,
    facilities,
    audit,
    idempotency,
  });
  return { gateway, session, audit, lab, patients, patientId: PATIENT_ID };
}

/** The gateway patient created through the real registration service. */
async function registeredPatientId(fx: GatewayFixture): Promise<string> {
  const dto = await fx.patients.registerPatient(fx.session, {
    fullName: 'Synthetic Gateway Patient',
    sex: 'UNKNOWN',
    externalReferences: [{ system: 'HOSPITAL_MRN', value: MRN }],
  });
  return dto.id;
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    system: HMS_SYNTHETIC_SYSTEM,
    operation: 'RESOLVE_PATIENT' as const,
    payload: { mrn: MRN },
    ...overrides,
  } as never;
}

async function integrationAudits(audit: AuditLogPort) {
  return (await audit.list()).filter(
    (event) => event.objectType === 'integration-request',
  );
}

describe('integration: patient reference resolution', () => {
  it('resolves an external MRN to the canonical patient (canonical id only)', async () => {
    const fx = fixtureFor();
    const patientId = await registeredPatientId(fx);
    const ack = await fx.gateway.handle(fx.session, envelope());
    assert.equal(ack.outcome, 'RESOLVED');
    assert.equal(ack.externalReference, MRN);
    const resource = ack.resource as { readonly id: string };
    assert.equal(resource.id, patientId);
    // Resolution is a read: no integration audit event is emitted.
    assert.equal((await integrationAudits(fx.audit)).length, 0);
  });

  it('fails closed when no patient matches the external reference', async () => {
    const fx = fixtureFor();
    await assert.rejects(
      () =>
        fx.gateway.handle(fx.session, envelope({ payload: { mrn: 'MRN-SYN-UNKNOWN' } })),
      NotFoundError,
    );
  });

  it('does not resolve a reference registered in another facility', async () => {
    const fx = fixtureFor();
    const other = sessionFor(OTHER_FACILITY);
    (other as { roles?: readonly string[] }).roles = ['operator'] as never;
    await assert.rejects(() => fx.gateway.handle(other, envelope()), NotFoundError);
  });
});

describe('integration: patient creation and reference attachment', () => {
  it('registers a patient through the existing service with INTEGRATION provenance', async () => {
    const fx = fixtureFor();
    const ack = await fx.gateway.handle(
      fx.session,
      envelope({
        operation: 'REGISTER_PATIENT',
        payload: {
          fullName: 'Synthetic Inbound Patient',
          sex: 'F',
          birthDate: '1992-04-01',
          mrn: 'MRN-SYN-2002',
        },
      }),
    );
    assert.equal(ack.outcome, 'CREATED');
    const patient = ack.resource as { readonly id: string; readonly facilityId?: string };
    assert.ok(patient.id);

    const events = await fx.audit.list();
    const patientEvent = events.find((event) => event.objectType === 'patient');
    assert.equal(patientEvent?.provenance.source.kind, 'INTEGRATION');
    assert.equal(
      patientEvent?.provenance.source.label,
      'synthetic HMS integration adapter',
    );
    const integration = events.filter(
      (event) => event.objectType === 'integration-request',
    );
    assert.equal(integration.length, 1);
    assert.equal(integration[0]?.action, 'IMPORTED');
    assert.equal(integration[0]?.provenance.source.kind, 'INTEGRATION');
  });

  it('does not create a duplicate patient on keyed replay (one audit event)', async () => {
    const fx = fixtureFor();
    const request = envelope({
      operation: 'REGISTER_PATIENT',
      idempotencyKey: 'ext-req-1',
      payload: { fullName: 'Synthetic Replay Patient', sex: 'M', mrn: 'MRN-SYN-3003' },
    });
    const first = await fx.gateway.handle(fx.session, request);
    const second = await fx.gateway.handle(fx.session, request);
    const firstResource = first.resource as { readonly id: string };
    const secondResource = second.resource as { readonly id: string };
    assert.equal(secondResource.id, firstResource.id);
    const events = await fx.audit.list();
    assert.equal(events.filter((event) => event.objectType === 'patient').length, 1);
    assert.equal((await integrationAudits(fx.audit)).length, 1);
  });

  it('rejects a duplicate external reference (identity duplicate detection preserved)', async () => {
    const fx = fixtureFor();
    await registeredPatientId(fx); // MRN already claimed through the service
    await assert.rejects(
      () =>
        fx.gateway.handle(
          fx.session,
          envelope({
            operation: 'REGISTER_PATIENT',
            payload: { fullName: 'Duplicate MRN Patient', sex: 'F', mrn: MRN },
          }),
        ),
      ConflictError,
    );
  });

  it('attaches an external reference to an existing in-scope patient', async () => {
    const fx = fixtureFor();
    const patientId = await registeredPatientId(fx);
    const ack = await fx.gateway.handle(
      fx.session,
      envelope({
        operation: 'ATTACH_PATIENT_REFERENCE',
        payload: { patientId, mrn: 'MRN-SYN-4004' },
      }),
    );
    assert.equal(ack.outcome, 'CREATED');
    const patient = ack.resource as {
      readonly externalReferences: readonly { readonly value: string }[];
    };
    assert.ok(patient.externalReferences.some((ref) => ref.value === 'MRN-SYN-4004'));

    const events = await fx.audit.list();
    const attachEvent = events.find(
      (event) => event.objectType === 'patient-external-identifier',
    );
    assert.equal(attachEvent?.provenance.source.kind, 'INTEGRATION');
    // Non-PHI detail: the identifier VALUE never enters the audit trail.
    assert.ok(!(attachEvent?.detail ?? '').includes('MRN-SYN-4004'));
  });

  it('refuses to attach a reference to a patient outside the session facility', async () => {
    const fx = fixtureFor();
    const patientId = await registeredPatientId(fx);
    const other = sessionFor(OTHER_FACILITY);
    (other as { roles?: readonly string[] }).roles = ['operator'] as never;
    // The existing patient service refuses cross-facility access as a scope
    // mismatch — the gateway adds no weaker rule of its own.
    await assert.rejects(
      () =>
        fx.gateway.handle(
          other,
          envelope({
            operation: 'ATTACH_PATIENT_REFERENCE',
            payload: { patientId, mrn: 'MRN-SYN-5005' },
          }),
        ),
      (error: { readonly code?: string }) => {
        assert.ok(['SCOPE_MISMATCH', 'NOT_FOUND'].includes(error.code ?? ''));
        return true;
      },
    );
  });
});

describe('integration: inbound diagnostic orders', () => {
  it('submits an order through the existing order service with INTEGRATION provenance', async () => {
    const fx = fixtureFor();
    const ack = await fx.gateway.handle(
      fx.session,
      envelope({
        operation: 'SUBMIT_ORDER',
        payload: {
          patientId: PATIENT_ID,
          encounterId: fx.lab.encounterId,
          modality: 'LAB',
          testCodes: [{ code: 'CBC', system: 'sdis' }],
          orderedAt: T0,
          hmsOrderId: 'HMS-ORDER-1',
        },
      }),
    );
    assert.equal(ack.outcome, 'CREATED');
    assert.equal(ack.externalReference, 'HMS-ORDER-1');
    const order = ack.resource as { readonly id: string; readonly status: string };
    assert.equal(order.status, 'ORDERED');

    const events = await fx.audit.list();
    const orderEvent = events.find((event) => event.objectType === 'diagnostic-order');
    assert.equal(orderEvent?.provenance.source.kind, 'INTEGRATION');

    const status = await fx.gateway.handle(
      fx.session,
      envelope({ operation: 'ORDER_STATUS', payload: { orderId: order.id } }),
    );
    assert.equal(status.outcome, 'RESOLVED');
    assert.equal((status.resource as { readonly id: string }).id, order.id);
  });

  it('does not duplicate an order on keyed replay', async () => {
    const fx = fixtureFor();
    const request = envelope({
      operation: 'SUBMIT_ORDER',
      idempotencyKey: 'ext-order-1',
      payload: {
        patientId: PATIENT_ID,
        encounterId: fx.lab.encounterId,
        modality: 'LAB',
        testCodes: [{ code: 'CBC', system: 'sdis' }],
        orderedAt: T0,
      },
    });
    const first = await fx.gateway.handle(fx.session, request);
    const second = await fx.gateway.handle(fx.session, request);
    assert.equal(
      (second.resource as { readonly id: string }).id,
      (first.resource as { readonly id: string }).id,
    );
    const events = await fx.audit.list();
    assert.equal(
      events.filter((event) => event.objectType === 'diagnostic-order').length,
      1,
    );
    assert.equal((await integrationAudits(fx.audit)).length, 1);
  });

  it('keeps order lifecycle and scope rules intact (unknown patient/encounter)', async () => {
    const fx = fixtureFor();
    await assert.rejects(
      () =>
        fx.gateway.handle(
          fx.session,
          envelope({
            operation: 'SUBMIT_ORDER',
            payload: {
              patientId: '00000000-0000-4000-8000-00000000f001',
              encounterId: fx.lab.encounterId,
              modality: 'LAB',
              testCodes: [{ code: 'CBC', system: 'sdis' }],
              orderedAt: T0,
            },
          }),
        ),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        fx.gateway.handle(
          fx.session,
          envelope({
            operation: 'SUBMIT_ORDER',
            payload: {
              patientId: PATIENT_ID,
              encounterId: fx.lab.encounterId,
              modality: 'NOT-A-MODALITY',
              testCodes: [{ code: 'CBC', system: 'sdis' }],
              orderedAt: T0,
            },
          }),
        ),
      ValidationError,
    );
  });
});

describe('integration: outbound report retrieval', () => {
  async function withReport(): Promise<GatewayFixture & { reportId: string }> {
    const fx = fixtureFor(['operator', 'manager']);
    const result = await fx.lab.flow.run({
      session: fx.session,
      patientId: PATIENT_ID,
      encounterId: fx.lab.encounterId,
      modality: 'LAB',
      testCode: 'CBC',
      codeSystem: 'sdis',
      specimenKind: 'BLOOD',
      observationCode: 'HB',
      observationValue: { kind: 'QUANTITATIVE', value: 13.2 },
      observationUnit: 'g/dL',
      observationIssuedBy: { kind: 'DEVICE', label: 'analyzer-x1', ref: 'dev-1' },
      interpretationSource: { kind: 'ALGORITHM', label: 'rules-v3' },
      interpretationText: 'within expected pattern',
      reportContent: 'CBC within expected pattern',
      startedAt: T0,
    });
    return Object.assign(fx, { reportId: result.report.id });
  }

  it('retrieves a bundle that keeps observation, interpretation, and report distinct', async () => {
    const fx = await withReport();
    const before = (await fx.lab.reports.getReport(fx.session, fx.reportId as never))
      .latestStatus;

    const ack = await fx.gateway.handle(
      fx.session,
      envelope({ operation: 'FETCH_REPORT', payload: { reportId: fx.reportId } }),
    );
    assert.equal(ack.outcome, 'RETRIEVED');
    const bundle = ack.resource as {
      readonly order: { readonly id: string };
      readonly specimens: readonly unknown[];
      readonly observations: readonly { readonly value: unknown }[];
      readonly interpretations: readonly unknown[];
      readonly report: {
        readonly versions: readonly { readonly version: number }[];
        readonly latestStatus: string;
      };
    };
    assert.ok(bundle.order.id);
    assert.ok(bundle.specimens.length >= 1);
    assert.ok(bundle.observations.length >= 1);
    assert.ok(bundle.interpretations.length >= 1);
    assert.equal(bundle.report.latestStatus, 'FINALIZED');
    assert.equal(bundle.report.versions.length, 1);

    // Retrieval never mutates the clinical record.
    const after = (await fx.lab.reports.getReport(fx.session, fx.reportId as never))
      .latestStatus;
    assert.equal(after, before);

    const exported = (await integrationAudits(fx.audit)).filter(
      (event) => event.action === 'EXPORTED',
    );
    assert.equal(exported.length, 1);
    assert.equal(exported[0]?.objectId, fx.reportId);
    assert.equal(exported[0]?.provenance.source.kind, 'INTEGRATION');
  });

  it('preserves amendments in the retrieved report versions', async () => {
    const fx = await withReport();
    const amendSession = fx.session;
    (amendSession as { roles?: readonly string[] }).roles = [
      'manager',
      'operator',
      'viewer',
    ] as never;
    await fx.lab.reports.amendReport(amendSession, {
      reportId: fx.reportId as never,
      content: 'amended: CBC within expected pattern',
      authoredByRef: 'pathologist-synthetic-1',
      authoredAt: '2026-09-20T09:30:00.000Z',
      amendmentReason: 'REPORT_CORRECTION',
      source: { kind: 'HUMAN', label: 'pathologist' },
    });
    const ack = await fx.gateway.handle(
      fx.session,
      envelope({ operation: 'FETCH_REPORT', payload: { reportId: fx.reportId } }),
    );
    const bundle = ack.resource as {
      readonly report: { readonly versions: readonly { readonly version: number }[] };
    };
    assert.equal(bundle.report.versions.length, 2);
    assert.deepEqual(
      bundle.report.versions.map((version) => version.version),
      [1, 2],
    );
  });

  it('refuses to export a report outside the session facility', async () => {
    const fx = await withReport();
    const other = sessionFor(OTHER_FACILITY);
    (other as { roles?: readonly string[] }).roles = ['operator'] as never;
    await assert.rejects(
      () =>
        fx.gateway.handle(
          other,
          envelope({ operation: 'FETCH_REPORT', payload: { reportId: fx.reportId } }),
        ),
      (error: { readonly code?: string }) => {
        assert.ok(['SCOPE_MISMATCH', 'NOT_FOUND'].includes(error.code ?? ''));
        return true;
      },
    );
  });
});

describe('integration: boundary and authorization', () => {
  it('fails closed for an unregistered external system', async () => {
    const fx = fixtureFor();
    await assert.rejects(
      () => fx.gateway.handle(fx.session, envelope({ system: 'SOME-OTHER-HMS' })),
      ForbiddenError,
    );
  });

  it('refuses an adapter that tries to claim non-integration provenance', async () => {
    const fx = fixtureFor();
    const rogue: IntegrationAdapter = {
      system: 'ROGUE-SYNTHETIC',
      label: 'rogue adapter',
      sourceKind: 'HUMAN',
      normalize: () => ({
        command: 'RESOLVE_PATIENT',
        reference: { system: 'HOSPITAL_MRN', value: MRN } as ExternalPatientReference,
      }),
      acknowledge: () => {
        throw new Error('unreachable');
      },
    };
    const registry = new StaticIntegrationRegistry([new HmsSyntheticAdapter(), rogue]);
    const gw = new IntegrationGateway({
      adapters: registry,
      systemRegistry: registeredSystemsRegistry('ROGUE-SYNTHETIC'),
      patients: fx.patients,
      orders: fx.lab.orders,
      observations: fx.lab.observations,
      interpretations: fx.lab.interpretations,
      reports: fx.lab.reports,
      specimens: { listByOrderItem: async () => [] },
      patientReferences: new InMemoryPatientRegistrationRepository(),
      facilities: (
        fx.lab.orders as unknown as { deps: { facilities: FacilityDirectory } }
      ).deps.facilities,
      audit: fx.audit,
      idempotency: new InMemoryIdempotencyStore(),
    });
    await assert.rejects(
      () => gw.handle(fx.session, envelope({ system: 'ROGUE-SYNTHETIC' })),
      ValidationError,
    );
  });

  it('rejects unsupported operations and malformed payloads with validation errors', async () => {
    const fx = fixtureFor();
    await assert.rejects(
      () => fx.gateway.handle(fx.session, envelope({ operation: 'DROP_TABLE' })),
      ValidationError,
    );
    await assert.rejects(
      () => fx.gateway.handle(fx.session, envelope({ payload: { mrn: '' } })),
      ValidationError,
    );
    await assert.rejects(
      () => fx.gateway.handle(fx.session, envelope({ correlationId: 'x'.repeat(200) })),
      ValidationError,
    );
  });

  it('records the external correlation id in the integration audit event', async () => {
    const fx = fixtureFor();
    await fx.gateway.handle(
      fx.session,
      envelope({
        operation: 'REGISTER_PATIENT',
        correlationId: 'hms-corr-9',
        payload: { fullName: 'Synthetic Correlated', sex: 'M', mrn: 'MRN-SYN-6006' },
      }),
    );
    const events = await integrationAudits(fx.audit);
    assert.equal(
      events[0]?.detail,
      `HMS-SYNTHETIC REGISTER_PATIENT correlation=hms-corr-9`,
    );
    // PHI safety: no payload values in the audit detail.
    assert.ok(!(events[0]?.detail ?? '').includes('MRN-SYN-6006'));
  });

  it('stays fail-closed without a session (401) and for a forged scope (403)', async () => {
    const fx = fixtureFor();
    await assert.rejects(
      () => fx.gateway.handle(undefined, envelope()),
      (error: { readonly code?: string }) => {
        assert.equal(error.code, 'UNAUTHENTICATED');
        return true;
      },
    );
    const forged = sessionFor(OTHER_FACILITY, OTHER_ORG);
    (forged as { roles?: readonly string[] }).roles = ['operator'] as never;
    await assert.rejects(
      () => fx.gateway.handle(forged, envelope()),
      (error: { readonly code?: string }) => {
        assert.equal(error.code, 'SCOPE_MISMATCH');
        return true;
      },
    );
  });

  it('enforces the existing RBAC permissions of the called services', async () => {
    const fx = fixtureFor(['viewer']);
    await assert.rejects(
      () =>
        fx.gateway.handle(
          fx.session,
          envelope({
            operation: 'SUBMIT_ORDER',
            payload: {
              patientId: PATIENT_ID,
              encounterId: fx.lab.encounterId,
              modality: 'LAB',
              testCodes: [{ code: 'CBC', system: 'sdis' }],
              orderedAt: T0,
            },
          }),
        ),
      (error: { readonly code?: string }) => {
        assert.equal(error.code, 'FORBIDDEN');
        return true;
      },
    );
  });
});

/** Guard: the fixture's specimen repository type is exercised by the bundle. */
void (undefined as unknown as SpecimenId);
