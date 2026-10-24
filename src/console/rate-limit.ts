// At most `limit` attempts per client in any `windowMs`. Kept in memory: one
// console process serves the whole stack, and a restart forgetting the counts
// is acceptable for a limit whose job is to slow down token guessing and
// runaway scripts.

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const MAX_TRACKED_CLIENTS = 10_000;

export class RateLimiter {
  // Times of the allowed attempts in the current window, oldest first.
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(client: string): RateDecision {
    const t = this.now();
    const recent = (this.attempts.get(client) ?? []).filter((at) => at > t - this.windowMs);
    if (recent.length >= this.limit) {
      this.attempts.set(client, recent);
      // A refused attempt does not extend the window.
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + this.windowMs - t) / 1000)) };
    }
    recent.push(t);
    this.attempts.set(client, recent);
    if (this.attempts.size > MAX_TRACKED_CLIENTS) this.forgetIdle(t);
    return { allowed: true };
  }

  private forgetIdle(t: number): void {
    for (const [client, times] of this.attempts) {
      if (times.every((at) => at <= t - this.windowMs)) this.attempts.delete(client);
    }
  }
}
