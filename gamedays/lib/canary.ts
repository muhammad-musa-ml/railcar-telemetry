import { randomInt, randomUUID } from "node:crypto";
import { urls } from "./clients";

// A black-box probe of the whole pipeline. Every couple of seconds it posts
// a read for its own car through ingest and watches the query API until that
// read shows up. The time between the two is the delay a real user would
// see. Both timestamps come from this machine's clock.

export interface CanaryRead {
  seq: number;
  observedAt: string;
  postedAtMs: number;
  visibleAtMs: number | null;
  postFailed: boolean;
}

export class Canary {
  readonly carId = `CNRY ${randomInt(100000, 999999)}`;
  readonly reads: CanaryRead[] = [];
  private postTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  private polling = false;

  start(postEveryMs = 2000, pollEveryMs = 500): void {
    this.postTimer = setInterval(() => void this.post(), postEveryMs);
    this.pollTimer = setInterval(() => void this.poll(), pollEveryMs);
  }

  stop(): void {
    if (this.postTimer) clearInterval(this.postTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  // Posts one read now and returns it, so a caller can wait for exactly it.
  async post(): Promise<CanaryRead> {
    // Observed times must increase strictly, or the tracker would treat a
    // read as a duplicate of the previous one.
    const last = this.reads.at(-1);
    const nowMs = Math.max(Date.now(), last ? Date.parse(last.observedAt) + 1 : 0);
    const read: CanaryRead = {
      seq: this.seq++,
      observedAt: new Date(nowMs).toISOString(),
      postedAtMs: Date.now(),
      visibleAtMs: null,
      postFailed: false,
    };
    this.reads.push(read);
    try {
      const res = await fetch(`${urls.ingest}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [{ event_id: randomUUID(), car_id: this.carId, reader_id: "AEI-YD01-E", location: "YD01", observed_at: read.observedAt }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      read.postFailed = !res.ok;
    } catch {
      read.postFailed = true;
    }
    return read;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const res = await fetch(`${urls.query}/v1/cars/${encodeURIComponent(this.carId)}`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return;
      const body = (await res.json()) as { last_seen_at: string };
      const seenMs = Date.parse(body.last_seen_at);
      const now = Date.now();
      for (const read of this.reads) {
        if (read.visibleAtMs === null && !read.postFailed && Date.parse(read.observedAt) <= seenMs) {
          read.visibleAtMs = now;
        }
      }
    } catch {
      // The query API being unreachable is part of some drills.
    } finally {
      this.polling = false;
    }
  }

  async waitVisible(read: CanaryRead, timeoutMs: number): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (read.postFailed) {
        // Ingest refused it; post a fresh one and wait for that instead.
        read = await this.post();
      }
      if (read.visibleAtMs !== null) return read.visibleAtMs;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  // Largest post-to-visible delay among reads posted in [fromMs, toMs]. A
  // read that never became visible counts as delayed until `toMs`.
  maxDelaySeconds(fromMs: number, toMs: number): number | null {
    const window = this.reads.filter((r) => !r.postFailed && r.postedAtMs >= fromMs && r.postedAtMs <= toMs);
    if (window.length === 0) return null;
    return Math.max(...window.map((r) => ((r.visibleAtMs ?? toMs) - r.postedAtMs) / 1000));
  }
}
