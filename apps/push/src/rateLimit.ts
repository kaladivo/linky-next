/**
 * In-memory fixed-window rate limiter (notifications.abuse-limits).
 *
 * Deliberately not persisted: limits bound abuse rates, they are not
 * accounting state — a restart resetting the windows is fine. Buckets prune
 * themselves on every check, so the map stays bounded by the number of
 * distinct keys per window.
 */
import { Context, Effect, Layer } from "effect";

export interface RateLimiterService {
  /** True when the hit is allowed (and counted); false = limited. */
  readonly check: (
    key: string,
    maxHits: number,
    windowMs: number,
    nowMs: number,
  ) => Effect.Effect<boolean>;
}

export class RateLimiter extends Context.Tag("@linky/push/RateLimiter")<
  RateLimiter,
  RateLimiterService
>() {}

interface Bucket {
  resetAt: number;
  hits: number;
}

export const makeRateLimiter = (): RateLimiterService => {
  const buckets = new Map<string, Bucket>();
  let lastPruneMs = 0;

  const prune = (nowMs: number): void => {
    if (nowMs - lastPruneMs < 10_000) return;
    lastPruneMs = nowMs;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= nowMs) buckets.delete(key);
    }
  };

  return {
    check: (key, maxHits, windowMs, nowMs) =>
      Effect.sync(() => {
        prune(nowMs);
        const bucket = buckets.get(key);
        if (bucket === undefined || bucket.resetAt <= nowMs) {
          buckets.set(key, { hits: 1, resetAt: nowMs + windowMs });
          return true;
        }
        if (bucket.hits >= maxHits) return false;
        bucket.hits += 1;
        return true;
      }),
  };
};

export const layerRateLimiter: Layer.Layer<RateLimiter> = Layer.sync(RateLimiter, makeRateLimiter);
