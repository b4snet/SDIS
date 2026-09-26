/**
 * Terminology persistence application tests.
 *
 * Prove the Step-7 capability over the EXISTING domain terminology contract:
 * creation through the domain rules, duplicate rejection, scope enforcement
 * (facility-scoped creation, cross-facility isolation, forged tenant),
 * resolution precedence (facility override before global), audit emission,
 * and idempotent replay without duplicate audit.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TerminologyPersistenceService } from '../../../src/app/terminology/terminology-service';
import { InMemoryTerminologyMappingRepository } from '../../../src/app/in-memory-terminology';
import {
  AuditLogPort,
  InMemoryFacilityDirectory,
  InMemoryIdempotencyStore,
} from '../../../src/app/in-memory';
import { InMemoryAuditStore } from '../../../src/core/audit/audit';
import { AuthorizationService, claimedRoleResolver } from '../../../src/app/authz/rbac';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../../src/app/errors';
import { FACILITY, OTHER_FACILITY, ORG, OTHER_ORG, sessionFor } from '../helpers';

function serviceFor(facilities?: InMemoryFacilityDirectory): {
  service: TerminologyPersistenceService;
  audit: AuditLogPort;
  store: InMemoryTerminologyMappingRepository;
  idempotency: InMemoryIdempotencyStore;
  facilities: InMemoryFacilityDirectory;
} {
  const store = new InMemoryTerminologyMappingRepository();
  const audit = new AuditLogPort(new InMemoryAuditStore());
  const idempotency = new InMemoryIdempotencyStore();
  const dirs = facilities ?? freshFacilities();
  const service = new TerminologyPersistenceService({
    mappings: store,
    facilities: dirs,
    audit,
    idempotency,
  });
  return { service, audit, store, idempotency, facilities: dirs };
}

function freshFacilities(): InMemoryFacilityDirectory {
  const facilities = new InMemoryFacilityDirectory();
  facilities.register({
    id: FACILITY,
    organizationId: ORG,
    name: 'Synthetic Lab Facility',
    code: 'SYN-LAB-1',
    timezone: 'UTC',
  });
  facilities.register({
    id: OTHER_FACILITY,
    organizationId: ORG,
    name: 'Other Facility',
    code: 'SYN-LAB-2',
    timezone: 'UTC',
  });
  return facilities;
}

const CREATE = {
  canonicalCode: 'GLUCOSE',
  externalSystem: 'loinc',
  externalCode: '2345-7',
};

describe('terminology persistence: creation', () => {
  it('creates a facility-scoped mapping through the domain rules', async () => {
    const { service } = serviceFor(freshFacilities());
    const dto = await service.createMapping(sessionFor(), CREATE);
    assert.ok(dto.id);
    assert.deepEqual(dto.canonical, { system: 'sdis', code: 'GLUCOSE' });
    assert.deepEqual(dto.external, { system: 'loinc', code: '2345-7' });
    assert.equal(dto.facilityId, FACILITY);
    assert.equal(dto.validated, false);
  });

  it('rejects unknown external systems (domain vocabulary, not duplicated)', async () => {
    const { service } = serviceFor(freshFacilities());
    await assert.rejects(
      () =>
        service.createMapping(sessionFor(), {
          ...CREATE,
          externalSystem: 'made-up-system',
        }),
      ValidationError,
    );
  });

  it('rejects empty canonical/external codes', async () => {
    const { service } = serviceFor(freshFacilities());
    await assert.rejects(
      () => service.createMapping(sessionFor(), { ...CREATE, canonicalCode: '' }),
      ValidationError,
    );
    await assert.rejects(
      () => service.createMapping(sessionFor(), { ...CREATE, externalCode: '' }),
      ValidationError,
    );
  });

  it('rejects global-scope creation from a facility session (no scope escalation)', async () => {
    const { service } = serviceFor(freshFacilities());
    await assert.rejects(
      () => service.createMapping(sessionFor(), { ...CREATE, global: true }),
      ValidationError,
    );
  });

  it('rejects an unauthenticated session (fail-closed)', async () => {
    const { service } = serviceFor(freshFacilities());
    await assert.rejects(
      () => service.createMapping(undefined, CREATE),
      UnauthenticatedError,
    );
  });

  it('rejects a forged tenant before any resource check', async () => {
    const { service } = serviceFor(freshFacilities());
    await assert.rejects(
      () => service.createMapping(sessionFor(FACILITY, OTHER_ORG), CREATE),
      (error: unknown) =>
        error instanceof Error && /Cross-organization access/i.test(error.message),
    );
  });

  it('rejects duplicates as CONFLICT (no silent overwrite)', async () => {
    const { service } = serviceFor(freshFacilities());
    await service.createMapping(sessionFor(), CREATE);
    await assert.rejects(
      () => service.createMapping(sessionFor(), CREATE),
      ConflictError,
    );
  });

  it('allows the same external code at a different facility (scope-separated)', async () => {
    const { service } = serviceFor(freshFacilities());
    await service.createMapping(sessionFor(), CREATE);
    const other = await service.createMapping(sessionFor(OTHER_FACILITY), CREATE);
    assert.equal(other.facilityId, OTHER_FACILITY);
  });
});

describe('terminology persistence: creation authorization (remediation)', () => {
  function authorizedService(): {
    service: TerminologyPersistenceService;
    audit: AuditLogPort;
  } {
    const store = new InMemoryTerminologyMappingRepository();
    const audit = new AuditLogPort(new InMemoryAuditStore());
    const service = new TerminologyPersistenceService({
      mappings: store,
      facilities: freshFacilities(),
      audit,
      idempotency: new InMemoryIdempotencyStore(),
      authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
    });
    return { service, audit };
  }

  function sessionWithRoles(roles: readonly string[]): never {
    return { ...sessionFor(), roles } as never;
  }

  it('denies mapping creation to viewer and operator tiers (manager-only)', async () => {
    for (const roles of [['viewer'], ['operator']] as const) {
      const { service, audit } = authorizedService();
      await assert.rejects(
        () => service.createMapping(sessionWithRoles(roles), CREATE),
        ForbiddenError,
      );
      // Denied writes emit no audit event.
      assert.equal(
        audit.list().filter((e) => e.objectType === 'terminology-mapping').length,
        0,
      );
    }
  });

  it('allows mapping creation to the manager tier', async () => {
    const { service } = authorizedService();
    const dto = await service.createMapping(sessionWithRoles(['manager']), CREATE);
    assert.ok(dto.id);
    assert.equal(dto.facilityId, FACILITY);
  });

  it('reads stay open to every authenticated facility session', async () => {
    const store = new InMemoryTerminologyMappingRepository();
    const dirs = freshFacilities();
    const audit = new AuditLogPort(new InMemoryAuditStore());
    const idempotency = new InMemoryIdempotencyStore();
    const authz = new AuthorizationService({ roleResolver: claimedRoleResolver() });
    const writer = new TerminologyPersistenceService({
      mappings: store,
      facilities: dirs,
      audit,
      idempotency,
      authz,
    });
    const reader = new TerminologyPersistenceService({
      mappings: store,
      facilities: dirs,
      audit,
      idempotency,
      authz,
    });
    const created = await writer.createMapping(sessionWithRoles(['manager']), CREATE);
    const found = await reader.getMapping(
      sessionWithRoles(['viewer']),
      created.id as never,
    );
    assert.ok(found);
    const resolved = await reader.resolveMappings(
      sessionWithRoles(['viewer']),
      'GLUCOSE',
      'loinc',
    );
    assert.ok(resolved.length >= 1);
  });
});

describe('terminology persistence: retrieval and scope', () => {
  it('returns a mapping by id within scope', async () => {
    const { service } = serviceFor(freshFacilities());
    const dto = await service.createMapping(sessionFor(), CREATE);
    const found = await service.getMapping(sessionFor(), dto.id as never);
    assert.equal(found.id, dto.id);
  });

  it('TERM-01 regression: a global mapping is readable by id from any facility session', async () => {
    const { service, store } = serviceFor(freshFacilities());
    const globalId = '00000000-0000-4000-8000-000000000203';
    await store.save({
      id: globalId as never,
      canonical: { system: 'sdis', code: 'GLUCOSE' },
      external: { system: 'loinc', code: '2345-7' },
      validated: true,
    });
    const found = await service.getMapping(sessionFor(), globalId as never);
    assert.equal(found.id, globalId);
    assert.equal(
      found.facilityId,
      undefined,
      'global mapping DTO carries no facility scope',
    );
    // The same deployment-wide mapping is visible from a DIFFERENT facility too.
    const fromOther = await service.getMapping(
      sessionFor(OTHER_FACILITY),
      globalId as never,
    );
    assert.equal(fromOther.id, globalId);
  });

  it('hides another facility mapping behind the same 404 (no existence leak)', async () => {
    const { service } = serviceFor(freshFacilities());
    const dto = await service.createMapping(sessionFor(), CREATE);
    await assert.rejects(
      () => service.getMapping(sessionFor(OTHER_FACILITY), dto.id as never),
      NotFoundError,
    );
  });

  it('requires authentication for lookups too', async () => {
    const { service } = serviceFor(freshFacilities());
    await assert.rejects(
      () =>
        service.getMapping(undefined, '00000000-0000-4000-8000-000000000101' as never),
      UnauthenticatedError,
    );
  });

  it('resolves with facility override before global and hides other facilities', async () => {
    const { service, store } = serviceFor(freshFacilities());
    await service.createMapping(sessionFor(), {
      canonicalCode: 'HBA1C',
      externalSystem: 'local',
      externalCode: 'A1C-FAC1',
    });
    // Global default seeded directly through the port (system-level config).
    await store.save({
      id: '00000000-0000-4000-8000-000000000201' as never,
      canonical: { system: 'sdis', code: 'HBA1C' },
      external: { system: 'local', code: 'A1C-GLOBAL' },
      validated: true,
    });
    // Another facility's override must never appear for this session.
    await store.save({
      id: '00000000-0000-4000-8000-000000000202' as never,
      canonical: { system: 'sdis', code: 'HBA1C' },
      external: { system: 'local', code: 'A1C-FAC2' },
      facilityId: OTHER_FACILITY,
      validated: false,
    });

    const resolved = await service.resolveMappings(sessionFor(), 'HBA1C', 'local');
    assert.deepEqual(
      resolved.map((m) => m.external.code),
      ['A1C-FAC1', 'A1C-GLOBAL'],
    );

    const fromOther = await service.resolveMappings(
      sessionFor(OTHER_FACILITY),
      'HBA1C',
      'local',
    );
    assert.deepEqual(
      fromOther.map((m) => m.external.code),
      ['A1C-FAC2', 'A1C-GLOBAL'],
    );
  });

  it('rejects unknown systems and missing canonical codes on resolve', async () => {
    const { service } = serviceFor(freshFacilities());
    await assert.rejects(
      () => service.resolveMappings(sessionFor(), 'GLUCOSE', 'nope'),
      ValidationError,
    );
    await assert.rejects(
      () => service.resolveMappings(sessionFor(), '', 'loinc'),
      ValidationError,
    );
  });

  it('rejects cross-facility resolution access (ScopeMismatch through facility check)', async () => {
    const { service } = serviceFor(freshFacilities());
    await assert.rejects(
      () => service.resolveMappings(sessionFor(FACILITY, OTHER_ORG), 'GLUCOSE', 'loinc'),
      (error: unknown) =>
        error instanceof Error && /Cross-organization access/i.test(error.message),
    );
  });
});

describe('terminology persistence: audit and idempotency', () => {
  it('emits a CREATED audit event with facility context', async () => {
    const { service, audit } = serviceFor(freshFacilities());
    const dto = await service.createMapping(sessionFor(), CREATE);
    const events = audit.list().filter((e) => e.objectType === 'terminology-mapping');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.objectId, dto.id);
    assert.equal(events[0]?.action, 'CREATED');
  });

  it('replays the same idempotency key to the same mapping without duplicate audit', async () => {
    const { service, audit } = serviceFor(freshFacilities());
    const first = await service.createMapping(sessionFor(), {
      ...CREATE,
      idempotencyKey: 'term-replay-1',
    });
    const replay = await service.createMapping(sessionFor(), {
      ...CREATE,
      idempotencyKey: 'term-replay-1',
    });
    assert.equal(replay.id, first.id);
    const events = audit.list().filter((e) => e.objectType === 'terminology-mapping');
    assert.equal(events.length, 1);
  });

  it('does not collapse distinct idempotency keys (distinct logical requests)', async () => {
    const { service } = serviceFor(freshFacilities());
    const first = await service.createMapping(sessionFor(), {
      ...CREATE,
      idempotencyKey: 'term-key-1',
    });
    const second = await service.createMapping(sessionFor(), {
      ...CREATE,
      externalCode: '2345-8',
      idempotencyKey: 'term-key-2',
    });
    assert.notEqual(second.id, first.id);
  });
});
