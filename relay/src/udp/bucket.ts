import { BURST_SECONDS } from "./config.ts";

export type Bucket = { rate: number; tokens: number; at: number };

export function bucket(rate: number): Bucket {
  return { rate, tokens: rate * BURST_SECONDS, at: Date.now() };
}

export function take(b: Bucket, amount: number, now = Date.now()): boolean {
  if (b.rate <= 0) return true;
  b.tokens = Math.min(b.rate * BURST_SECONDS, b.tokens + ((now - b.at) / 1000) * b.rate);
  b.at = now;
  if (b.tokens < amount) return false;
  b.tokens -= amount;
  return true;
}

export class WindowLimiter {
  private readonly hits = new Map<string, { n: number; since: number }>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string, now = Date.now()): boolean {
    if (this.limit <= 0) return true;
    const h = this.hits.get(key);
    if (!h || now - h.since >= this.windowMs) {
      this.hits.set(key, { n: 1, since: now });
      return true;
    }
    if (h.n >= this.limit) return false;
    h.n++;
    return true;
  }

  sweep(now = Date.now()) {
    for (const [k, h] of this.hits) if (now - h.since >= this.windowMs) this.hits.delete(k);
  }
}
