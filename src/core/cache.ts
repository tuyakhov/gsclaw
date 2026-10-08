interface Entry<V> {
  value: V;
  expiresAt: number;
  weight: number;
}

/**
 * Small in-memory LRU with TTL and a total weight budget (for example, number of rows held) so a
 * few huge responses cannot exhaust memory on small runtimes such as Cloudflare Workers.
 */
export class LruCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private totalWeight = 0;

  constructor(
    private readonly opts: { maxEntries: number; maxWeight: number; now?: () => number },
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number, weight = 1): void {
    if (ttlMs <= 0 || weight > this.opts.maxWeight) return;
    this.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlMs, weight });
    this.totalWeight += weight;
    while (this.map.size > this.opts.maxEntries || this.totalWeight > this.opts.maxWeight) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    this.totalWeight -= entry.weight;
    this.map.delete(key);
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.map.keys()]) if (predicate(key)) this.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
