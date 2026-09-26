/**
 * Security test: tenant/facility context cannot be omitted or forged, and data
 * cannot cross organization or facility boundaries.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertContextProvided,
  assertFacilityScoped,
  assertSameOrganization,
} from '../../src/types/tenant';

describe('security: tenant & facility isolation', () => {
  it('scoped operations reject missing context', () => {
    assert.throws(() => assertContextProvided(undefined), /context is required/);
    assert.throws(() => assertContextProvided({} as never), /context is required/);
  });

  it('accepts an explicit context', () => {
    const ctx = {
      organizationId: '00000000-0000-4000-8000-000000000001' as never,
      facilityId: '00000000-0000-4000-8000-000000000002' as never,
    };
    assert.doesNotThrow(() => assertContextProvided(ctx));
  });

  it('rejects cross-organization access', () => {
    const orgA = { organizationId: '00000000-0000-4000-8000-000000000001' as never };
    const orgB = { organizationId: '00000000-0000-4000-8000-000000000002' as never };
    assert.throws(() => assertSameOrganization(orgA, orgB), /Cross-organization/);
  });

  it('rejects cross-facility access even within the same organization', () => {
    const facA = {
      organizationId: '00000000-0000-4000-8000-000000000001' as never,
      facilityId: '00000000-0000-4000-8000-000000000011' as never,
    };
    const facB = {
      organizationId: '00000000-0000-4000-8000-000000000001' as never,
      facilityId: '00000000-0000-4000-8000-000000000012' as never,
    };
    assert.throws(() => assertFacilityScoped(facA, facB), /Cross-facility/);
  });

  it('allows same-scope access', () => {
    const scope = {
      organizationId: '00000000-0000-4000-8000-000000000001' as never,
      facilityId: '00000000-0000-4000-8000-000000000011' as never,
    };
    assert.doesNotThrow(() => assertFacilityScoped(scope, scope));
  });
});
