/**
 * Master setup configuration application tests (Step 15).
 *
 * Proves the capability over the EXISTING domain contract
 * (`src/domain/master-setup/master-setup.ts`): scoped + versioned records,
 * supported-family allowlist, server-derived scope, validated department
 * references, no-overwrite updates (history preserved), optimistic version
 * guard, RBAC, idempotent replay, and audit. Fresh fixture per test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { SetupConfigService } from '../../../src/app/setup/setup-config-service';
import { InMemorySetupConfigRepository } from '../../../src/app/in-memory-setup';
import { AuthorizationService, claimedRoleResolver } from '../../../src/app/authz/rbac';
import { ConflictError, NotFoundError, ValidationError } from '../../../src/app/errors';
import {
  createFixture,
  sessionFor,
  FACILITY,
  OTHER_FACILITY,
  OTHER_ORG,
  type LabFixture,
} from '../helpers';
import { InMemoryIdempotencyStore, type AuditLogPort } from '../../../src/app/in-memory';
import type { ApplicationSession } from '../../../src/app/context';
import type { FacilityDirectory } from '../../../src/app/ports';
import { toBrandedId, type DepartmentId } from '../../../src/types/ids';

const DEPT: DepartmentId = toBrandedId('00000000-0000-4000-8000-0000000000d1');
/** A second department of the SAME facility. */
const SIBLING_DEPT: DepartmentId = toBrandedId('00000000-0000-4000-8000-0000000000d4');
/** A department of ANOTHER facility. */
const OTHER_DEPT: DepartmentId = toBrandedId('00000000-0000-4000-8000-0000000000d2');
const UNKNOWN_DEPT: DepartmentId = toBrandedId('00000000-0000-4000-8000-0000000000d3');

interface Harness {
  readonly service: SetupConfigService;
  readonly repo: InMemorySetupConfigRepository;
  readonly session: ApplicationSession;
  readonly audit: AuditLogPort;
}

function harness(
  roles: readonly string[] = ['manager'],
  departmentId?: DepartmentId,
): Harness {
  const fixture: LabFixture = createFixture();
  const repo = new InMemorySetupConfigRepository();
  repo.registerDepartment(DEPT, FACILITY);
  repo.registerDepartment(SIBLING_DEPT, FACILITY);
  repo.registerDepartment(OTHER_DEPT, OTHER_FACILITY);
  const session = sessionFor();
  (session as { roles?: readonly string[] }).roles = roles as never;
  if (departmentId)
    (session as { departmentId?: DepartmentId }).departmentId = departmentId;
  const service = new SetupConfigService({
    config: repo,
    facilities: (fixture.orders as unknown as { deps: { facilities: FacilityDirectory } })
      .deps.facilities,
    audit: fixture.audit,
    idempotency: new InMemoryIdempotencyStore(),
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  return { service, repo, session, audit: fixture.audit as AuditLogPort };
}

const FACILITY_SETTING = {
  family: 'FACILITY' as const,
  key: 'worklist.defaultPageSize',
  value: 25,
  effectiveFrom: '2026-09-21T00:00:00.000Z',
};

describe('setup config: creation and validation', () => {
  it('creates version 1 of a facility setting and returns a clean DTO', async () => {
    const h = harness();
    const dto = await h.service.createConfig(h.session, FACILITY_SETTING);
    assert.ok(dto.id);
    assert.equal(dto.family, 'FACILITY');
    assert.equal(dto.key, 'worklist.defaultPageSize');
    assert.equal(dto.version, 1);
    assert.equal(dto.facilityId, FACILITY);
    assert.equal(dto.organizationId, sessionFor().organizationId);
    assert.ok(!('departmentId' in dto));
  });

  it('rejects unsupported configuration families', async () => {
    const h = harness();
    for (const family of ['REFERENCE_RANGE', 'PRICING', 'USER', 'MODALITY'] as const) {
      await assert.rejects(
        () =>
          h.service.createConfig(h.session, {
            ...FACILITY_SETTING,
            family: family as never,
            key: `k.${family.toLowerCase()}`,
          }),
        ValidationError,
      );
    }
  });

  it('rejects invalid keys, secret-bearing keys, and invalid values', async () => {
    const h = harness();
    const bad = [
      { key: 'has space' },
      { key: '.leading' },
      { key: 'db.password' },
      { key: 'api_key' },
    ];
    for (const override of bad) {
      await assert.rejects(
        () => h.service.createConfig(h.session, { ...FACILITY_SETTING, ...override }),
        ValidationError,
      );
    }
    await assert.rejects(
      () => h.service.createConfig(h.session, { ...FACILITY_SETTING, value: null }),
      ValidationError,
    );
    await assert.rejects(
      () =>
        h.service.createConfig(h.session, {
          ...FACILITY_SETTING,
          value: 'x'.repeat(9000),
        }),
      ValidationError,
    );
    await assert.rejects(
      () =>
        h.service.createConfig(h.session, {
          ...FACILITY_SETTING,
          effectiveFrom: 'not-a-date',
        }),
      ValidationError,
    );
  });

  it('conflicts on duplicate configuration in the same scope', async () => {
    const h = harness();
    await h.service.createConfig(h.session, FACILITY_SETTING);
    await assert.rejects(
      () => h.service.createConfig(h.session, FACILITY_SETTING),
      ConflictError,
    );
  });

  it('scopes department configuration to a department inside the session facility', async () => {
    const h = harness(['manager'], DEPT);
    const created = await h.service.createConfig(h.session, {
      family: 'DEPARTMENT',
      key: 'bench.label',
      value: 'Bench A',
      effectiveFrom: '2026-09-21T00:00:00.000Z',
      departmentId: DEPT,
    });
    assert.equal(created.departmentId, DEPT);

    await assert.rejects(
      () =>
        h.service.createConfig(h.session, {
          family: 'DEPARTMENT',
          key: 'bench.other',
          value: 'Bench B',
          effectiveFrom: '2026-09-21T00:00:00.000Z',
          departmentId: OTHER_DEPT,
        }),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        h.service.createConfig(h.session, {
          family: 'DEPARTMENT',
          key: 'bench.unknown',
          value: 'Bench C',
          effectiveFrom: '2026-09-21T00:00:00.000Z',
          departmentId: UNKNOWN_DEPT,
        }),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        h.service.createConfig(h.session, {
          family: 'DEPARTMENT',
          key: 'bench.none',
          value: 'Bench D',
          effectiveFrom: '2026-09-21T00:00:00.000Z',
        }),
      ValidationError,
    );
    await assert.rejects(
      () =>
        h.service.createConfig(h.session, {
          ...FACILITY_SETTING,
          key: 'facility.withDept',
          departmentId: DEPT,
        }),
      ValidationError,
    );
  });
});

describe('setup config: versioned updates', () => {
  it('appends a new version and preserves the previous one (no overwrite)', async () => {
    const h = harness();
    const v1 = await h.service.createConfig(h.session, FACILITY_SETTING);
    const v2 = await h.service.updateConfig(h.session, {
      family: 'FACILITY',
      key: FACILITY_SETTING.key,
      value: 50,
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      expectedVersion: 1,
    });
    assert.equal(v2.version, 2);
    assert.notEqual(v2.id, v1.id);
    assert.equal(v2.value, 50);

    // History is intact: the earlier version is still addressable.
    const history = await h.service.getConfigById(h.session, v1.id as never);
    assert.equal(history.version, 1);
    assert.equal(history.value, 25);
    // Retrieval by key returns the latest version.
    const latest = await h.service.getConfig(h.session, {
      family: 'FACILITY',
      key: FACILITY_SETTING.key,
    });
    assert.equal(latest.version, 2);
  });

  it('rejects a stale expectedVersion and leaves the configuration unchanged', async () => {
    const h = harness();
    await h.service.createConfig(h.session, FACILITY_SETTING);
    await h.service.updateConfig(h.session, {
      family: 'FACILITY',
      key: FACILITY_SETTING.key,
      value: 50,
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      expectedVersion: 1,
    });
    await assert.rejects(
      () =>
        h.service.updateConfig(h.session, {
          family: 'FACILITY',
          key: FACILITY_SETTING.key,
          value: 99,
          effectiveFrom: '2026-10-02T00:00:00.000Z',
          expectedVersion: 1,
        }),
      ConflictError,
    );
    const latest = await h.service.getConfig(h.session, {
      family: 'FACILITY',
      key: FACILITY_SETTING.key,
    });
    assert.equal(latest.version, 2);
    assert.equal(latest.value, 50);
  });

  it('404s an update of an unknown configuration', async () => {
    const h = harness();
    await assert.rejects(
      () =>
        h.service.updateConfig(h.session, {
          family: 'FACILITY',
          key: 'unknown.setting',
          value: 1,
          effectiveFrom: '2026-10-01T00:00:00.000Z',
          expectedVersion: 1,
        }),
      NotFoundError,
    );
  });

  it('replays a keyed update idempotently', async () => {
    const h = harness();
    await h.service.createConfig(h.session, FACILITY_SETTING);
    const input = {
      family: 'FACILITY' as const,
      key: FACILITY_SETTING.key,
      value: 50,
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      expectedVersion: 1,
      idempotencyKey: 'setup-update-1',
    };
    const first = await h.service.updateConfig(h.session, input);
    const second = await h.service.updateConfig(h.session, input);
    assert.equal(second.id, first.id);
    const latest = await h.service.getConfig(h.session, {
      family: 'FACILITY',
      key: FACILITY_SETTING.key,
    });
    assert.equal(latest.version, 2);
  });
});

describe('setup config: scope, listing, and authorization', () => {
  it('lists only the configuration applicable to the session scope', async () => {
    // One scope holds both a facility setting and a department setting; a
    // department setting of ANOTHER department must not become applicable.
    const h = harness(['manager'], DEPT);
    await h.service.createConfig(h.session, FACILITY_SETTING);
    await h.service.createConfig(h.session, {
      family: 'DEPARTMENT',
      key: 'bench.label',
      value: 'Bench A',
      effectiveFrom: '2026-09-21T00:00:00.000Z',
      departmentId: DEPT,
    });
    // A facility-level session may register configuration for any department
    // of that facility; a department session may not (checked below).
    const facilityWide = harness();
    await facilityWide.service.createConfig(facilityWide.session, {
      family: 'DEPARTMENT',
      key: 'bench.otherLabel',
      value: 'Bench B',
      effectiveFrom: '2026-09-21T00:00:00.000Z',
      departmentId: SIBLING_DEPT,
    });
    await assert.rejects(
      () =>
        h.service.createConfig(h.session, {
          family: 'DEPARTMENT',
          key: 'bench.foreign',
          value: 'Bench C',
          effectiveFrom: '2026-09-21T00:00:00.000Z',
          departmentId: OTHER_DEPT,
        }),
      NotFoundError,
    );

    const applicable = await h.service.listApplicable(h.session);
    assert.deepEqual(
      applicable.map((config) => `${config.family}:${config.key}`),
      ['DEPARTMENT:bench.label', 'FACILITY:worklist.defaultPageSize'],
    );

    // A session without a department sees no department-scoped configuration.
    await facilityWide.service.createConfig(facilityWide.session, FACILITY_SETTING);
    const scoped = await facilityWide.service.listApplicable(facilityWide.session);
    assert.deepEqual(
      scoped.map((config) => config.key),
      ['worklist.defaultPageSize'],
    );
  });

  it('hides another facility’s configuration behind a scope-unaware 404', async () => {
    const h = harness();
    const dto = await h.service.createConfig(h.session, FACILITY_SETTING);
    const other = sessionFor(OTHER_FACILITY);
    (other as { roles?: readonly string[] }).roles = ['manager'] as never;
    await assert.rejects(
      () => h.service.getConfigById(other, dto.id as never),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        h.service.getConfig(other, {
          family: 'FACILITY',
          key: FACILITY_SETTING.key,
        }),
      NotFoundError,
    );
    assert.equal((await h.service.listApplicable(other)).length, 0);
  });

  it('rejects a forged facility/organization pairing before any resource check', async () => {
    const h = harness();
    const forged = sessionFor(OTHER_FACILITY, OTHER_ORG);
    (forged as { roles?: readonly string[] }).roles = ['manager'] as never;
    await assert.rejects(
      () => h.service.createConfig(forged, FACILITY_SETTING),
      (error: { readonly code?: string }) => {
        assert.equal(error.code, 'SCOPE_MISMATCH');
        return true;
      },
    );
  });

  it('enforces authentication and the central RBAC permission set', async () => {
    const h = harness(['operator']);
    await assert.rejects(
      () => h.service.createConfig(undefined, FACILITY_SETTING),
      (error: { readonly code?: string }) => {
        assert.equal(error.code, 'UNAUTHENTICATED');
        return true;
      },
    );
    // Operators may read configuration but not change it.
    const manager = harness();
    const dto = await manager.service.createConfig(manager.session, FACILITY_SETTING);
    assert.ok(dto.id);
    assert.equal((await h.service.listApplicable(h.session)).length, 0);
    for (const rejected of [
      () =>
        h.service.createConfig(h.session, { ...FACILITY_SETTING, key: 'other.setting' }),
      () =>
        h.service.updateConfig(h.session, {
          family: 'FACILITY',
          key: FACILITY_SETTING.key,
          value: 1,
          effectiveFrom: '2026-10-01T00:00:00.000Z',
          expectedVersion: 1,
        }),
    ]) {
      await assert.rejects(rejected as never, (error: { readonly code?: string }) => {
        assert.equal(error.code, 'FORBIDDEN');
        return true;
      });
    }
  });
});

describe('setup config: audit and idempotency', () => {
  it('audits creation and update without recording the value', async () => {
    const h = harness();
    // Free-form values live on an unregistered (inert) key; registered keys
    // are typed-validated (Step 24).
    await h.service.createConfig(h.session, {
      ...FACILITY_SETTING,
      key: 'note.synthetic',
      value: 'synthetic-operational-value',
    });
    await h.service.updateConfig(h.session, {
      family: 'FACILITY',
      key: 'note.synthetic',
      value: 'synthetic-updated-value',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      expectedVersion: 1,
    });
    const audits = (await h.audit.list()).filter(
      (event) => event.objectType === 'setup-config',
    );
    assert.deepEqual(
      audits.map((event) => event.action),
      ['CREATED', 'UPDATED'],
    );
    assert.equal(audits[1]?.detail, `FACILITY key=note.synthetic version=1 -> 2`);
    for (const event of audits) {
      assert.ok(!/synthetic-(operational|updated)-value/.test(event.detail ?? ''));
    }
  });

  it('replays a keyed creation without a duplicate record or audit event', async () => {
    const h = harness();
    const input = { ...FACILITY_SETTING, idempotencyKey: 'setup-create-1' };
    const first = await h.service.createConfig(h.session, input);
    const second = await h.service.createConfig(h.session, input);
    assert.equal(second.id, first.id);
    const audits = (await h.audit.list()).filter(
      (event) => event.objectType === 'setup-config',
    );
    assert.equal(audits.length, 1);
    const latest = await h.service.listApplicable(h.session);
    assert.equal(latest.length, 1);
  });
});
