/**
 * Extensibility test: the modality registry must accommodate Laboratory and all
 * planned future diagnostic modalities WITHOUT any core change.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ModalityRegistry } from '../../src/domain/modality/modality';

describe('architecture: modality extensibility', () => {
  it('registers LAB, ECG, EEG, PFT, TMT, ECHO and ULTRASOUND on one registry', () => {
    const registry = new ModalityRegistry();
    for (const name of ['LAB', 'ECG', 'EEG', 'PFT', 'TMT', 'ECHO', 'ULTRASOUND']) {
      registry.register({
        name: name as never,
        displayName: name,
        capabilities: ['ORDERING', 'REPORT'],
      });
    }
    assert.equal(registry.all().length, 7);
    for (const name of ['LAB', 'ECG', 'EEG', 'PFT', 'TMT', 'ECHO', 'ULTRASOUND']) {
      assert.ok(registry.has(name as never), `${name} must be representable`);
      assert.equal(registry.get(name as never)?.displayName, name);
    }
  });

  it('a future modality registers without modifying the registry', () => {
    const registry = new ModalityRegistry();
    registry.register({
      name: 'LAB',
      displayName: 'Laboratory',
      capabilities: ['ORDERING', 'SPECIMEN', 'OBSERVATIONS', 'REPORT'],
    });
    registry.register({
      name: 'GENOMICS',
      displayName: 'Genomics',
      capabilities: ['ORDERING', 'OBSERVATIONS', 'INTERPRETATION', 'REPORT'],
    });
    assert.ok(registry.has('GENOMICS'));
    assert.equal(registry.get('GENOMICS')?.capabilities.length, 4);
  });

  it('duplicate registration is rejected', () => {
    const registry = new ModalityRegistry();
    registry.register({ name: 'LAB', displayName: 'Laboratory', capabilities: [] });
    assert.throws(() =>
      registry.register({ name: 'LAB', displayName: 'Duplicate', capabilities: [] }),
    );
  });

  it('a missing modality is absent, not defaulted to LAB', () => {
    const registry = new ModalityRegistry();
    registry.register({ name: 'LAB', displayName: 'Laboratory', capabilities: [] });
    assert.equal(registry.get('EEG'), undefined);
  });
});
