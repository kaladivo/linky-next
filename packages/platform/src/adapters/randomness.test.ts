import { RandomnessError } from "@linky/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeRandomness } from "./randomness";

describe("makeRandomness", () => {
  it("returns the native module's bytes", async () => {
    const randomness = makeRandomness({
      getRandomBytesAsync: (byteCount) =>
        Promise.resolve(Uint8Array.from({ length: byteCount }, (_, i) => i)),
    });

    const bytes = await Effect.runPromise(randomness.nextBytes(4));
    expect(bytes).toEqual(Uint8Array.from([0, 1, 2, 3]));
  });

  it("maps native rejections to RandomnessError with the requested size", async () => {
    const randomness = makeRandomness({
      getRandomBytesAsync: () => Promise.reject(new Error("no entropy")),
    });

    const failure = await Effect.runPromise(Effect.flip(randomness.nextBytes(32)));
    expect(failure).toBeInstanceOf(RandomnessError);
    expect(failure.requestedBytes).toBe(32);
    expect(failure.cause).toEqual(new Error("no entropy"));
  });
});
