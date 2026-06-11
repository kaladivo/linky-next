import { ClipboardError } from "@linky/core";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { ClipboardNativeModule } from "./clipboard";
import { makeClipboard } from "./clipboard";

const memoryNative = (): ClipboardNativeModule => {
  let contents = "";
  return {
    getStringAsync: () => Promise.resolve(contents),
    setStringAsync: (text) => {
      contents = text;
      return Promise.resolve(true);
    },
  };
};

const failingNative: ClipboardNativeModule = {
  getStringAsync: () => Promise.reject(new Error("pasteboard unavailable")),
  setStringAsync: () => Promise.reject(new Error("pasteboard unavailable")),
};

describe("makeClipboard", () => {
  it("round-trips text", async () => {
    const clipboard = makeClipboard(memoryNative());
    await Effect.runPromise(clipboard.copy("cashuA..."));
    expect(await Effect.runPromise(clipboard.read)).toEqual(Option.some("cashuA..."));
  });

  it("reads an empty clipboard as Option.none", async () => {
    const clipboard = makeClipboard(memoryNative());
    expect(await Effect.runPromise(clipboard.read)).toEqual(Option.none());
  });

  it("maps copy rejections to ClipboardError", async () => {
    const clipboard = makeClipboard(failingNative);
    const failure = await Effect.runPromise(Effect.flip(clipboard.copy("x")));
    expect(failure).toBeInstanceOf(ClipboardError);
    expect(failure.operation).toBe("copy");
  });

  it("maps read rejections to ClipboardError", async () => {
    const clipboard = makeClipboard(failingNative);
    const failure = await Effect.runPromise(Effect.flip(clipboard.read));
    expect(failure).toBeInstanceOf(ClipboardError);
    expect(failure.operation).toBe("read");
  });
});
