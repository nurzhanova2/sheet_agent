export class InMemoryRateLimiter {
  readonly #buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly maxRequests = 30, private readonly windowMs = 60_000) {}
  consume(key: string, now = Date.now()): boolean {
    const bucket = this.#buckets.get(key);
    if (!bucket || bucket.resetAt <= now) { this.#buckets.set(key, { count: 1, resetAt: now + this.windowMs }); return true; }
    if (bucket.count >= this.maxRequests) return false;
    bucket.count += 1; return true;
  }
}
