/**
 * Clinical test: the diagnostic-order lifecycle is constrained.
 *
 * ORDERED → ACQUIRED → PROCESSING → RESULT ENTERED → VERIFIED → FINALIZED → REPORTED
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidOrderTransitionError,
  ORDER_LIFECYCLE,
  transitionOrderStatus,
} from '../../src/domain/ordering/diagnostic-order';

describe('clinical: order lifecycle', () => {
  it('walks the full valid lifecycle', () => {
    let status = transitionOrderStatus('ORDERED', 'ACQUIRED');
    status = transitionOrderStatus(status, 'PROCESSING');
    status = transitionOrderStatus(status, 'RESULT_ENTERED');
    status = transitionOrderStatus(status, 'VERIFIED');
    status = transitionOrderStatus(status, 'FINALIZED');
    status = transitionOrderStatus(status, 'REPORTED');
    assert.equal(status, 'REPORTED');
  });

  it('rejects skipping and backwards jumps', () => {
    assert.throws(
      () => transitionOrderStatus('ORDERED', 'FINALIZED'),
      InvalidOrderTransitionError,
    );
    assert.throws(
      () => transitionOrderStatus('FINALIZED', 'RESULT_ENTERED'),
      InvalidOrderTransitionError,
    );
    assert.throws(
      () => transitionOrderStatus('REPORTED', 'FINALIZED'),
      InvalidOrderTransitionError,
    );
  });

  it('rejects transitions from a cancelled order', () => {
    assert.throws(
      () => transitionOrderStatus('CANCELLED', 'PROCESSING'),
      InvalidOrderTransitionError,
    );
  });

  it('ordered orders may be cancelled; later stages may not silently return', () => {
    assert.equal(transitionOrderStatus('ORDERED', 'CANCELLED'), 'CANCELLED');
    assert.equal(transitionOrderStatus('ACQUIRED', 'CANCELLED'), 'CANCELLED');
    assert.throws(
      () => transitionOrderStatus('VERIFIED', 'CANCELLED'),
      InvalidOrderTransitionError,
    );
  });

  it('defines the canonical lifecycle sequence', () => {
    assert.deepEqual(ORDER_LIFECYCLE, [
      'ORDERED',
      'ACQUIRED',
      'PROCESSING',
      'RESULT_ENTERED',
      'VERIFIED',
      'FINALIZED',
      'REPORTED',
    ]);
  });
});
