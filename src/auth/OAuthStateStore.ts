import { randomBytes } from 'crypto';

interface StateEntry {
  expiresAt: number;
}

/**
 * Server-side nonce store for OAuth CSRF state parameters.
 * Each nonce is single-use and expires after ttlMs (default 10 min).
 */
export class OAuthStateStore {
  private readonly states = new Map<string, StateEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /** Generates a cryptographically random state nonce and stores it with a TTL. */
  generate(): string {
    this.prune();
    const nonce = randomBytes(32).toString('hex');
    this.states.set(nonce, { expiresAt: Date.now() + this.ttlMs });
    return nonce;
  }

  /**
   * Validates and consumes the state nonce (single-use).
   * Returns true if the nonce exists and has not expired; false otherwise.
   * The entry is always removed on first access.
   */
  consume(state: string): boolean {
    const entry = this.states.get(state);
    if (!entry) return false;
    this.states.delete(state);
    return Date.now() <= entry.expiresAt;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.states) {
      if (now > entry.expiresAt) this.states.delete(key);
    }
  }
}
