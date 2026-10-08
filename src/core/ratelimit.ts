/**
 * Per-key token bucket (in memory, per instance). Refills `perMinute` tokens per minute with a
 * burst of the same size. A limit of 0 disables limiting.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    if (this.perMinute <= 0) return { ok: true };
    const now = this.now();
    const ratePerMs = this.perMinute / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: this.perMinute, updated: now };
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + (now - bucket.updated) * ratePerMs);
    bucket.updated = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      this.prune(now);
      return { ok: true };
    }
    this.buckets.set(key, bucket);
    return { ok: false, retryAfterSeconds: Math.ceil((1 - bucket.tokens) / ratePerMs / 1000) };
  }

  private prune(now: number): void {
    if (this.buckets.size <= 1000) return;
    for (const [key, bucket] of this.buckets)
      if (now - bucket.updated > 120_000) this.buckets.delete(key);
  }
}
