/**
 * Terminology test: canonical internal codes map to external systems; unknown
 * systems are rejected; facility overrides are honored.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TerminologyService } from '../../src/domain/terminology/terminology';
import { toBrandedId } from '../../src/types/ids';

const GLUCOSE = { system: 'sdis', code: 'GLUCOSE' };
const FACILITY = toBrandedId('00000000-0000-4000-8000-000000000011');

describe('terminology: canonical ↔ external mapping', () => {
  it('maps an internal canonical code to an external system', () => {
    const service = new TerminologyService();
    service.addMapping({
      id: toBrandedId('00000000-0000-4000-8000-000000000101'),
      canonical: GLUCOSE,
      external: { system: 'loinc', code: '2345-7' },
      validated: true,
    });
    assert.deepEqual(service.resolveToExternal(GLUCOSE, 'loinc'), {
      system: 'loinc',
      code: '2345-7',
    });
  });

  it('rejects unknown external code systems', () => {
    const service = new TerminologyService();
    assert.throws(
      () =>
        service.addMapping({
          id: toBrandedId('00000000-0000-4000-8000-000000000102'),
          canonical: GLUCOSE,
          external: { system: 'made-up-system', code: 'X' },
          validated: true,
        }),
      /Unknown external code system/,
    );
  });

  it('rejects non-internal canonical codes', () => {
    const service = new TerminologyService();
    assert.throws(
      () =>
        service.addMapping({
          id: toBrandedId('00000000-0000-4000-8000-000000000103'),
          canonical: { system: 'loinc', code: '2345-7' },
          external: { system: 'snomed', code: 'SNOMED-X' },
          validated: true,
        }),
      /must be the SDIS internal system/,
    );
  });

  it('facility-specific mapping overrides the global mapping', () => {
    const service = new TerminologyService();
    service.addMapping({
      id: toBrandedId('00000000-0000-4000-8000-000000000104'),
      canonical: GLUCOSE,
      external: { system: 'local', code: 'GLU-1' },
      validated: true,
    });
    service.addMapping({
      id: toBrandedId('00000000-0000-4000-8000-000000000105'),
      canonical: GLUCOSE,
      external: { system: 'local', code: 'GLU-2' },
      facilityId: FACILITY,
      validated: true,
    });
    assert.equal(service.resolveToExternal(GLUCOSE, 'local', FACILITY)?.code, 'GLU-2');
    assert.equal(service.resolveToExternal(GLUCOSE, 'local')?.code, 'GLU-1');
  });

  it('returns undefined for unmapped codes', () => {
    const service = new TerminologyService();
    assert.equal(
      service.resolveToExternal({ system: 'sdis', code: 'UNMAPPED' }, 'loinc'),
      undefined,
    );
  });
});
