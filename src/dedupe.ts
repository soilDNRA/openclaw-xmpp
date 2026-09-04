import {
  DEFAULT_DEDUPE_MAX_ENTRIES,
  DEFAULT_DEDUPE_TTL_MS
} from "./constants.js";

export class ExpiringDedupe {
  readonly #entries = new Map<string, number>();

  constructor(
    private readonly ttlMs = DEFAULT_DEDUPE_TTL_MS,
    private readonly maxEntries = DEFAULT_DEDUPE_MAX_ENTRIES,
    private readonly now: () => number = Date.now
  ) {}

  seen(key: string): boolean {
    const current = this.now();
    this.prune(current);
    const expiresAt = this.#entries.get(key);
    if (expiresAt !== undefined && expiresAt > current) {
      return true;
    }
    this.#entries.delete(key);
    this.#entries.set(key, current + this.ttlMs);
    this.#enforceLimit();
    return false;
  }

  get size(): number {
    return this.#entries.size;
  }

  prune(current = this.now()): void {
    for (const [key, expiresAt] of this.#entries) {
      if (expiresAt > current) {
        continue;
      }
      this.#entries.delete(key);
    }
  }

  #enforceLimit(): void {
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.#entries.delete(oldest);
    }
  }
}
