export type ProviderFailureKind = 'transport' | 'timeout' | 'server' | 'content';
export type ProviderCircuitState = 'closed' | 'open' | 'half_open';

interface ProviderCircuitEntry {
  state: ProviderCircuitState;
  failures: number;
  openedAt: number;
}

export interface ProviderHealthCircuitOptions {
  failureThreshold: number;
  cooldownMs: number;
}

/**
 * Small in-memory provider circuit breaker shared by latency-sensitive routes.
 * Keys are supplied by callers so the same mechanism works for Ollama,
 * OpenAI-compatible endpoints and future providers without name-specific rules.
 */
export class ProviderHealthCircuit {
  private readonly entries = new Map<string, ProviderCircuitEntry>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(options: ProviderHealthCircuitOptions) {
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold));
    this.cooldownMs = Math.max(1, Math.floor(options.cooldownMs));
  }

  tryAcquire(key: string, now = Date.now()): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry.state === 'closed') return true;
    if (entry.state === 'half_open') return false;
    if (now - entry.openedAt < this.cooldownMs) return false;

    // Exactly one caller owns the half-open probe until success/failure records
    // a new state. Concurrent requests continue through the fallback chain.
    entry.state = 'half_open';
    this.entries.set(key, entry);
    return true;
  }

  recordSuccess(key: string): void {
    this.entries.set(key, { state: 'closed', failures: 0, openedAt: 0 });
  }

  recordFailure(key: string, kind: ProviderFailureKind, now = Date.now()): void {
    if (kind === 'content') {
      // Invalid/unsafe model output does not prove the endpoint is unhealthy.
      this.recordSuccess(key);
      return;
    }

    const current = this.entries.get(key) || { state: 'closed' as const, failures: 0, openedAt: 0 };
    const failures = current.state === 'half_open' ? this.failureThreshold : current.failures + 1;
    this.entries.set(key, failures >= this.failureThreshold
      ? { state: 'open', failures, openedAt: now }
      : { state: 'closed', failures, openedAt: 0 });
  }

  snapshot(key: string): Readonly<ProviderCircuitEntry> | undefined {
    const entry = this.entries.get(key);
    return entry ? { ...entry } : undefined;
  }
}
