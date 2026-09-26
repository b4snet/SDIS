/**
 * Step 24 — master setup & configuration application tests.
 *
 * Proves the department master-data administration boundary over the
 * EXISTING canonical `sdis.departments` table contract (create / list /
 * deactivate, per-facility code uniqueness, server-derived scope, RBAC via
 * the existing `setup.manage` permission, idempotent replay, audit) and the
 * bounded configuration registry keys driving worklist behavior — plus the
 * historical-integrity invariant: configuration and master-data changes
 * NEVER mutate finalized clinical records.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DepartmentService } from '../../../src/app/setup/department-service';
import { InMemoryDepartmentRepository } from '../../../src/app/in-memory-departments';
import { SetupConfigService } from '../../../src/app/setup/setup-config-service';
import { InMemorySetupConfigRepository } from '../../../src/app/in-memory-setup';
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
  orderIdOf,
  reportIdOf,
  at,
  FACILITY,
  OTHER_FACILITY,
  type LabFixture,
} from '../helpers';
import { toBrandedId, type DepartmentId } from '../../../src/types/ids';
import { InMemoryIdempotencyStore, type AuditLogPort } from '../../../src/app/in-memory';
import type { ApplicationSession } from '../../../src/app/context';
import type { FacilityDirectory } from '../../../src/app/ports';
import { WorklistService } from '../../../src/app/laboratory/worklist-service';
import { InMemoryOrderRepository } from '../../../src/app/in-memory';

function facilitiesOf(fixture: LabFixture): FacilityDirectory {
  return (fixture.orders as unknown as { deps: { facilities: FacilityDirectory } }).deps
    .facilities;
}

interface Harness {
  readonly departments: DepartmentService;
  readonly departmentRepo: InMemoryDepartmentRepository;
  readonly config: SetupConfigService;
  readonly configRepo: InMemorySetupConfigRepository;
  readonly session: ApplicationSession;
  readonly audit: AuditLogPort;
  readonly fixture: LabFixture;
}

function harness(roles: readonly string[] = ['manager']): Harness {
  const fixture = createFixture();
  const session = sessionFor();
  (session as { roles?: readonly string[] }).roles = roles as never;
  const departmentRepo = new InMemoryDepartmentRepository();
  const configRepo = new InMemorySetupConfigRepository();
  const authz = new AuthorizationService({ roleResolver: claimedRoleResolver() });
  const idempotency = new InMemoryIdempotencyStore();
  const facilities = facilitiesOf(fixture);
  const departments = new DepartmentService({
    departments: departmentRepo,
    facilities,
    audit: fixture.audit,
    idempotency,
    authz,
  });
  const config = new SetupConfigService({
    config: configRepo,
    facilities,
    audit: fixture.audit,
    idempotency,
    authz,
  });
  return {
    departments,
    departmentRepo,
    config,
    configRepo,
    session,
    audit: fixture.audit as AuditLogPort,
    fixture,
  };
}

describe('department master data: creation', () => {
  it('creates a department in the session facility and returns a clean DTO', async () => {
    const h = harness();
    const dto = await h.departments.createDepartment(h.session, {
      name: 'Clinical Biochemistry',
      code: 'BIOCHEM',
      modalities: ['BIOCHEMISTRY'],
    });
    assert.ok(dto.id);
    assert.equal(dto.facilityId, FACILITY);
    assert.equal(dto.code, 'BIOCHEM');
    assert.equal(dto.status, 'ACTIVE');
    assert.deepEqual(dto.modalities, ['BIOCHEMISTRY']);
  });

  it('rejects invalid names, codes, and modalities deterministically', async () => {
    const h = harness();
    const bad = [
      { name: '', code: 'OK' },
      { name: 'x'.repeat(161), code: 'OK' },
      { name: 'Lab', code: 'ok' },
      { name: 'Lab', code: '1ABC' },
      { name: 'Lab', code: 'A' },
      { name: 'Lab', code: 'OK', modalities: ['not a modality'] },
    ];
    for (const input of bad) {
      await assert.rejects(
        () =>
          h.departments.createDepartment(
            h.session,
            input as {
              name: string;
              code: string;
            },
          ),
        ValidationError,
      );
    }
    assert.equal((await h.departmentRepo.listByFacility(FACILITY)).length, 0);
  });

  it('enforces per-facility code uniqueness without recycling codes', async () => {
    const h = harness();
    await h.departments.createDepartment(h.session, { name: 'First', code: 'LAB01' });
    await assert.rejects(
      () => h.departments.createDepartment(h.session, { name: 'Second', code: 'LAB01' }),
      ConflictError,
    );
  });

  it('permits the same code in a different facility (scope-bounded uniqueness)', async () => {
    const h = harness();
    await h.departments.createDepartment(h.session, { name: 'Home', code: 'LAB01' });
    const other = sessionFor(OTHER_FACILITY);
    (other as { roles?: readonly string[] }).roles = ['manager'] as never;
    const foreign = await h.departments.createDepartment(other, {
      name: 'Away',
      code: 'LAB01',
    });
    assert.equal(foreign.facilityId, OTHER_FACILITY);
  });
});

describe('department master data: authorization and scope', () => {
  it('denies mutation without the administration permission (fail closed)', async () => {
    const h = harness(['operator']);
    await assert.rejects(
      () => h.departments.createDepartment(h.session, { name: 'Lab', code: 'LAB01' }),
      ForbiddenError,
    );
    await assert.rejects(
      () =>
        h.departments.deactivateDepartment(
          h.session,
          toBrandedId('00000000-0000-4000-8000-0000000000aa1'),
        ),
      ForbiddenError,
    );
  });

  it('permits reads at the viewer tier (SETUP_READ), denies nothing extra', async () => {
    const h = harness(['viewer']);
    const listed = await h.departments.listDepartments(h.session);
    assert.equal(listed.length, 0);
    await assert.rejects(
      () => h.departments.createDepartment(h.session, { name: 'Lab', code: 'LAB01' }),
      ForbiddenError,
    );
  });

  it('never exposes another facility department through get or deactivate', async () => {
    const h = harness();
    const foreignSession = sessionFor(OTHER_FACILITY);
    (foreignSession as { roles?: readonly string[] }).roles = ['manager'] as never;
    const foreign = await h.departments.createDepartment(foreignSession, {
      name: 'Away',
      code: 'AWAY01',
    });

    await assert.rejects(
      () => h.departments.getDepartment(h.session, toBrandedId(foreign.id)),
      NotFoundError,
    );
    await assert.rejects(
      () => h.departments.deactivateDepartment(h.session, toBrandedId(foreign.id)),
      NotFoundError,
    );
    // Deactivation by the OWNING facility works — scope is the discriminator.
    const deactivated = await h.departments.deactivateDepartment(
      foreignSession,
      toBrandedId(foreign.id),
    );
    assert.equal(deactivated.status, 'INACTIVE');
  });

  it('lists only the session facility departments (deterministic order)', async () => {
    const h = harness();
    const foreignSession = sessionFor(OTHER_FACILITY);
    (foreignSession as { roles?: readonly string[] }).roles = ['manager'] as never;
    await h.departments.createDepartment(foreignSession, {
      name: 'Away',
      code: 'AWAY01',
    });
    await h.departments.createDepartment(h.session, { name: 'Beta', code: 'BETA01' });
    await h.departments.createDepartment(h.session, { name: 'Alpha', code: 'ALPHA01' });

    const listed = await h.departments.listDepartments(h.session);
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.map((d) => d.code),
      ['ALPHA01', 'BETA01'],
    );
  });
});

describe('department master data: lifecycle', () => {
  it('deactivates without deletion; inactive departments stay resolvable', async () => {
    const h = harness();
    const created = await h.departments.createDepartment(h.session, {
      name: 'Histopathology',
      code: 'HISTO01',
    });
    const deactivated = await h.departments.deactivateDepartment(
      h.session,
      toBrandedId(created.id),
    );
    assert.equal(deactivated.status, 'INACTIVE');

    const fetched = await h.departments.getDepartment(h.session, toBrandedId(created.id));
    assert.equal(fetched.status, 'INACTIVE');
    // History preserved: the record still exists, no physical delete.
    const listed = await h.departments.listDepartments(h.session);
    assert.equal(listed.length, 1);
  });

  it('deactivation is idempotent and audited exactly once for the transition', async () => {
    const h = harness();
    const created = await h.departments.createDepartment(h.session, {
      name: 'Microbiology',
      code: 'MICRO01',
    });
    await h.departments.deactivateDepartment(h.session, toBrandedId(created.id), {
      idempotencyKey: 'deact-1',
    });
    const replay = await h.departments.deactivateDepartment(
      h.session,
      toBrandedId(created.id),
      {
        idempotencyKey: 'deact-1',
      },
    );
    assert.equal(replay.status, 'INACTIVE');

    const events = h.audit
      .list()
      .filter((e) => e.objectId === created.id && e.action === 'UPDATED');
    assert.equal(events.length, 1);
  });
});

describe('configuration registry (Step 24 bounded keys)', () => {
  it('validates bounded registry keys and typed values before persistence', async () => {
    const h = harness();
    const ok = await h.config.createConfig(h.session, {
      family: 'FACILITY',
      key: 'worklist.defaultPageSize',
      value: 25,
      effectiveFrom: '2026-09-21T00:00:00.000Z',
    });
    assert.equal(ok.value, 25);

    const bad = [
      { value: 0 },
      { value: 201 },
      { value: 12.5 },
      { value: '25' },
      { value: true },
    ];
    for (const override of bad) {
      await assert.rejects(
        () =>
          h.config.createConfig(h.session, {
            family: 'FACILITY' as const,
            key: 'worklist.defaultPageSize',
            effectiveFrom: '2026-09-21T00:00:00.000Z',
            ...override,
          }),
        ValidationError,
      );
    }
  });

  it('unregistered keys are operationally inert — no clinical behavior path', async () => {
    const h = harness();
    // A clinical-sounding key stores fine (generic validation) but is inert:
    // the worklist consumer reads ONLY registered keys, so defaults hold.
    await h.config.createConfig(h.session, {
      family: 'FACILITY',
      key: 'clinical.autoDiagnose',
      value: true,
      effectiveFrom: '2026-09-21T00:00:00.000Z',
    });
    const worklist = new WorklistService({
      orders: new InMemoryOrderRepository(),
      facilities: facilitiesOf(h.fixture),
      config: h.config,
      authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
    });
    const ordersRepo = (
      worklist as unknown as { deps: { orders: InMemoryOrderRepository } }
    ).deps.orders;
    for (let i = 0; i < 4; i += 1) {
      await ordersRepo.save({
        id: `00000000-0000-4000-8000-0000000000b${i}` as never,
        tenantId: '00000000-0000-4000-8000-0000000000t1' as never,
        facilityId: FACILITY,
        patientId: h.fixture.patientId,
        encounterId: h.fixture.encounterId,
        status: 'CREATED',
        priority: 'ROUTINE',
        orderedAt: `2026-09-21T0${i}:00:00.000Z`,
        items: [],
      } as never);
    }
    // Registered default (50) applies — the inert key changed nothing.
    const entries = await worklist.listForSession(h.session);
    assert.equal(entries.length, 4);
  });
});

describe('worklist configuration consumption (operational only)', () => {
  it('honors a configured page size and defaults when unset', async () => {
    const h = harness();
    await h.config.createConfig(h.session, {
      family: 'FACILITY',
      key: 'worklist.defaultPageSize',
      value: 2,
      effectiveFrom: '2026-09-21T00:00:00.000Z',
    });

    const worklist = new WorklistService({
      orders: new InMemoryOrderRepository(),
      facilities: facilitiesOf(h.fixture),
      config: h.config,
      authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
    });
    const ordersRepo = (
      worklist as unknown as { deps: { orders: InMemoryOrderRepository } }
    ).deps.orders;
    for (let i = 0; i < 3; i += 1) {
      await ordersRepo.save({
        id: `00000000-0000-4000-8000-00000000000${i}` as never,
        tenantId: '00000000-0000-4000-8000-0000000000t1' as never,
        facilityId: FACILITY,
        patientId: h.fixture.patientId,
        encounterId: h.fixture.encounterId,
        status: 'CREATED',
        priority: 'ROUTINE',
        orderedAt: `2026-09-21T0${i}:00:00.000Z`,
        items: [],
      } as never);
    }

    const entries = await worklist.listForSession(h.session);
    assert.equal(entries.length, 2);
  });

  it('includeHistory=false keeps REPORTED orders out of the operational queue', async () => {
    const h = harness();
    const worklist = new WorklistService({
      orders: new InMemoryOrderRepository(),
      facilities: facilitiesOf(h.fixture),
      config: h.config,
      authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
    });
    const ordersRepo = (
      worklist as unknown as { deps: { orders: InMemoryOrderRepository } }
    ).deps.orders;
    await ordersRepo.save({
      id: '00000000-0000-4000-8000-00000000000a' as never,
      tenantId: '00000000-0000-4000-8000-0000000000t1' as never,
      facilityId: FACILITY,
      patientId: h.fixture.patientId,
      encounterId: h.fixture.encounterId,
      status: 'REPORTED',
      priority: 'ROUTINE',
      orderedAt: '2026-09-21T01:00:00.000Z',
      items: [],
    } as never);

    const entries = await worklist.listForSession(h.session);
    assert.equal(entries.length, 0);
  });
});

describe('historical integrity (configuration never rewrites clinical truth)', () => {
  it('changing configuration after finalization leaves the report intact', async () => {
    const h = harness();
    const order = await h.fixture.orders.createOrder(h.fixture.session, {
      patientId: h.fixture.patientId,
      encounterId: h.fixture.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'SYN-CBC', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(10),
    });
    // Verification gate (Step 28): the order is walked to VERIFIED before
    // the report finalizes.
    await h.fixture.orders.transitionOrder(
      h.fixture.session,
      orderIdOf(order),
      'ACQUIRED',
      at(11),
    );
    await h.fixture.orders.transitionOrder(
      h.fixture.session,
      orderIdOf(order),
      'PROCESSING',
      at(12),
    );
    await h.fixture.orders.transitionOrder(
      h.fixture.session,
      orderIdOf(order),
      'RESULT_ENTERED',
      at(13),
    );
    const verifier = h.fixture.session;
    (verifier as { roles?: readonly string[] }).roles = [
      'manager',
      'operator',
      'viewer',
    ] as never;
    await h.fixture.orders.transitionOrder(
      verifier,
      orderIdOf(order),
      'VERIFIED',
      at(14),
    );

    const report = await h.fixture.reports.createReport(h.fixture.session, {
      orderId: orderIdOf(order),
      content: 'Final impression: unremarkable study.',
      authoredByRef: 'Dr. Synthetic',
      authoredAt: at(20),
    });
    const finalized = await h.fixture.reports.finalizeReport(
      h.fixture.session,
      reportIdOf(report),
      'Dr. Synthetic',
      at(30),
    );

    const first = await h.config.createConfig(h.session, {
      family: 'FACILITY',
      key: 'worklist.defaultPageSize',
      value: 10,
      effectiveFrom: '2026-09-21T00:00:00.000Z',
    });
    await h.departments.createDepartment(h.session, {
      name: 'Later Dept',
      code: 'LATER01',
    });
    await h.config.updateConfig(h.session, {
      family: 'FACILITY',
      key: 'worklist.defaultPageSize',
      value: 99,
      effectiveFrom: '2026-09-21T02:00:00.000Z',
      expectedVersion: first.version,
    });

    const reread = await h.fixture.reports.getReport(
      h.fixture.session,
      reportIdOf(finalized),
    );
    const head = reread.versions[reread.versions.length - 1]!;
    assert.equal(head.content, 'Final impression: unremarkable study.');
    assert.equal(reread.latestStatus, 'FINALIZED');
  });

  it('deactivating a department never deletes it or its configuration references', async () => {
    const h = harness();
    const created = await h.departments.createDepartment(h.session, {
      name: 'Referenced Dept',
      code: 'REFDEP1',
    });
    // Production reads one `sdis.departments` table; the split in-memory
    // fixtures mirror that single row in both stores.
    h.configRepo.registerDepartment(toBrandedId(created.id), FACILITY);
    await h.config.createConfig(h.session, {
      family: 'DEPARTMENT',
      key: 'worklist.defaultPageSize',
      value: 7,
      effectiveFrom: '2026-09-21T00:00:00.000Z',
      departmentId: toBrandedId(created.id),
    });
    await h.departments.deactivateDepartment(h.session, toBrandedId(created.id));

    const fetched = await h.departments.getDepartment(h.session, toBrandedId(created.id));
    assert.equal(fetched.status, 'INACTIVE');
    // Historical integrity: the department-scoped configuration written while
    // the department was ACTIVE remains resolvable after deactivation
    // (read through a department-scoped session, per Step-15 applicability).
    const deptSession = sessionFor();
    (deptSession as { roles?: readonly string[] }).roles = ['manager'] as never;
    (deptSession as { departmentId?: DepartmentId }).departmentId = toBrandedId(
      created.id,
    );
    const configs = await h.config.listApplicable(deptSession);
    assert.equal(configs.length, 1);
    assert.equal(configs[0]!.departmentId, created.id);
  });
});
