/**
 * DeepLinks adapter — maps a Linking-style native module (expo-linking) onto
 * core's `DeepLinks` port: launch URL as an Effect, live URL events as a
 * Stream. Each stream consumer gets its own native subscription, registered
 * on consumption and removed when the consumer stops (acquireRelease).
 */
import type { DeepLinksService } from "@linky/core";
import { DeepLinks, DeepLinksError } from "@linky/core";
import { Effect, Layer, Option, Stream } from "effect";

/** The subset of `expo-linking` this adapter needs. */
export interface LinkingNativeModule {
  readonly getInitialURL: () => Promise<string | null>;
  readonly addEventListener: (
    type: "url",
    handler: (event: { url: string }) => void,
  ) => { remove: () => void };
}

export const makeDeepLinks = (native: LinkingNativeModule): DeepLinksService => ({
  initialUrl: Effect.tryPromise({
    try: async () => Option.fromNullable(await native.getInitialURL()),
    catch: (cause) => new DeepLinksError({ cause }),
  }),
  urls: Stream.asyncPush<string>((emit) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        native.addEventListener("url", (event) => {
          emit.single(event.url);
        }),
      ),
      (subscription) => Effect.sync(() => subscription.remove()),
    ),
  ),
});

export const layerDeepLinks = (native: LinkingNativeModule): Layer.Layer<DeepLinks> =>
  Layer.succeed(DeepLinks, makeDeepLinks(native));
