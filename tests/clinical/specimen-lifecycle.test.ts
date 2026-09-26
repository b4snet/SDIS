/**
 * Clinical test: the specimen lifecycle follows the Step-1 status vocabulary
 * with the minimal documented ordering — no extra states are invented.
 *
 *   COLLECTED → RECEIVED → ACCEPTED → PROCESSED
 *                        ↘ REJECTED (terminal)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidSpecimenTransitionError,
  SPECIMEN_LIFECYCLE,
  transitionSpecimenStatus,
} from '../../src/domain/specimen/specimen';

describe('clinical: specimen lifecycle', () => {
  it('walks the full valid lifecycle', () => {
    let status = transitionSpecimenStatus('COLLECTED', 'RECEIVED');
    status = transitionSpecimenStatus(status, 'ACCEPTED');
    status = transitionSpecimenStatus(status, 'PROCESSED');
    assert.equal(status, 'PROCESSED');
  });

  it('rejects skipping and backwards jumps', () => {
    assert.throws(
      () => transitionSpecimenStatus('COLLECTED', 'ACCEPTED'),
      InvalidSpecimenTransitionError,
    );
    assert.throws(
      () => transitionSpecimenStatus('COLLECTED', 'PROCESSED'),
      InvalidSpecimenTransitionError,
    );
    assert.throws(
      () => transitionSpecimenStatus('ACCEPTED', 'RECEIVED'),
      InvalidSpecimenTransitionError,
    );
  });

  it('rejects transitions from terminal states', () => {
    assert.throws(
      () => transitionSpecimenStatus('PROCESSED', 'RECEIVED'),
      InvalidSpecimenTransitionError,
    );
    assert.throws(
      () => transitionSpecimenStatus('REJECTED', 'ACCEPTED'),
      InvalidSpecimenTransitionError,
    );
  });

  it('received specimens may be accepted or rejected', () => {
    assert.equal(transitionSpecimenStatus('RECEIVED', 'ACCEPTED'), 'ACCEPTED');
    assert.equal(transitionSpecimenStatus('RECEIVED', 'REJECTED'), 'REJECTED');
  });

  it('defines the canonical progression vocabulary', () => {
    assert.deepEqual(SPECIMEN_LIFECYCLE, [
      'COLLECTED',
      'RECEIVED',
      'ACCEPTED',
      'PROCESSED',
    ]);
  });
});
