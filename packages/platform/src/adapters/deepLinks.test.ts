import { DeepLinksError } from "@linky/core";
import { Effect, Option, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { LinkingNativeModule } from "./deepLinks";
import { makeDeepLinks } from "./deepLinks";

const eventNative = (initialUrl: string | null) => {
  const handlers = new Set<(event: { url: string }) => void>();
  let removals = 0;
  const native: LinkingNativeModule = {
    getInitialURL: () => Promise.resolve(initialUrl),
    addEventListener: (_type, handler) => {
      handlers.add(handler);
      return {
        remove: () => {
          handlers.delete(handler);
          removals += 1;
        },
      };
    },
  };
  return {
    native,
    emit: (url: string) => handlers.forEach((handler) => handler({ url })),
    subscriberCount: () => handlers.size,
    removalCount: () => removals,
  };
};

describe("makeDeepLinks", () => {
  it("exposes the launch URL as Option", async () => {
    const some = makeDeepLinks(eventNative("linky-dev://pay").native);
    expect(await Effect.runPromise(some.initialUrl)).toEqual(Option.some("linky-dev://pay"));

    const none = makeDeepLinks(eventNative(null).native);
    expect(await Effect.runPromise(none.initialUrl)).toEqual(Option.none());
  });

  it("maps getInitialURL rejections to DeepLinksError", async () => {
    const deepLinks = makeDeepLinks({
      getInitialURL: () => Promise.reject(new Error("bridge down")),
      addEventListener: () => ({ remove: () => {} }),
    });
    const failure = await Effect.runPromise(Effect.flip(deepLinks.initialUrl));
    expect(failure).toBeInstanceOf(DeepLinksError);
    expect(failure.cause).toEqual(new Error("bridge down"));
  });

  it("streams URL events and removes the native subscription when done", async () => {
    const fixture = eventNative(null);
    const deepLinks = makeDeepLinks(fixture.native);

    const urls = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Stream.runCollect(Stream.take(deepLinks.urls, 2)));
        // Wait until the stream consumer has registered its listener.
        yield* Effect.repeat(Effect.sync(fixture.subscriberCount), {
          until: (count) => count === 1,
        });
        fixture.emit("linky-dev://a");
        fixture.emit("linky-dev://b");
        fixture.emit("linky-dev://ignored-after-take");
        return yield* fiber.await.pipe(Effect.flatten);
      }),
    );

    expect([...urls]).toEqual(["linky-dev://a", "linky-dev://b"]);
    expect(fixture.subscriberCount()).toBe(0);
    expect(fixture.removalCount()).toBe(1);
  });
});
