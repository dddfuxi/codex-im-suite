import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ProviderHealthCircuit } from '../provider-health-circuit.js';

describe('ProviderHealthCircuit', () => {
  it('opens after a transport failure and allows one half-open probe after cooldown', () => {
    const circuit = new ProviderHealthCircuit({ failureThreshold: 1, cooldownMs: 1000 });
    const key = 'ollama:http://127.0.0.1:11434:model';

    assert.equal(circuit.tryAcquire(key, 1000), true);
    circuit.recordFailure(key, 'transport', 1010);
    assert.equal(circuit.tryAcquire(key, 1500), false);

    assert.equal(circuit.tryAcquire(key, 2010), true);
    assert.equal(circuit.tryAcquire(key, 2011), false, 'only one half-open probe may run');
  });

  it('closes after a successful half-open probe', () => {
    const circuit = new ProviderHealthCircuit({ failureThreshold: 1, cooldownMs: 1000 });
    const key = 'provider:endpoint:model';

    circuit.recordFailure(key, 'timeout', 1000);
    assert.equal(circuit.tryAcquire(key, 2000), true);
    circuit.recordSuccess(key);

    assert.equal(circuit.tryAcquire(key, 2001), true);
    assert.equal(circuit.snapshot(key)?.state, 'closed');
  });

  it('does not open for content validation failures', () => {
    const circuit = new ProviderHealthCircuit({ failureThreshold: 1, cooldownMs: 1000 });
    const key = 'provider:endpoint:model';

    circuit.recordFailure(key, 'content', 1000);

    assert.equal(circuit.tryAcquire(key, 1001), true);
    assert.equal(circuit.snapshot(key)?.state, 'closed');
  });
});
