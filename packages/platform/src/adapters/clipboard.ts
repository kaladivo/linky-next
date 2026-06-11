/**
 * Clipboard adapter — maps a pasteboard-style native module (expo-clipboard)
 * onto core's `Clipboard` port. An empty clipboard reads as `Option.none()`
 * per the port contract (expo returns `""` for empty/non-text content).
 */
import type { ClipboardService } from "@linky/core";
import { Clipboard, ClipboardError } from "@linky/core";
import { Effect, Layer, Option } from "effect";

/** The subset of `expo-clipboard` this adapter needs. */
export interface ClipboardNativeModule {
  readonly getStringAsync: () => Promise<string>;
  readonly setStringAsync: (text: string) => Promise<boolean>;
}

export const makeClipboard = (native: ClipboardNativeModule): ClipboardService => ({
  copy: (text) =>
    Effect.tryPromise({
      try: () => native.setStringAsync(text),
      catch: (cause) => new ClipboardError({ operation: "copy", cause }),
    }).pipe(Effect.asVoid),
  read: Effect.tryPromise({
    try: async () => {
      const text = await native.getStringAsync();
      return text === "" ? Option.none<string>() : Option.some(text);
    },
    catch: (cause) => new ClipboardError({ operation: "read", cause }),
  }),
});

export const layerClipboard = (native: ClipboardNativeModule): Layer.Layer<Clipboard> =>
  Layer.succeed(Clipboard, makeClipboard(native));
