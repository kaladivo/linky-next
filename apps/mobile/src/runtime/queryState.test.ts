/**
 * Tests for the runtime-agnostic part of the Effect ↔ React bridge — no
 * React, no device, just Exit → UI-state mapping.
 */
import { Cause, Data, Exit, FiberId } from "effect";
import { describe, expect, it } from "vitest";

import { outcomeFromExit } from "./queryState";

class ExampleError extends Data.TaggedError("ExampleError")<{ readonly reason: string }> {}

describe("outcomeFromExit", () => {
  it("maps success to the success state", () => {
    expect(outcomeFromExit(Exit.succeed("hello"))).toEqual({
      type: "state",
      state: { status: "success", data: "hello" },
    });
  });

  it("maps a typed failure to the error state, preserving the tagged error", () => {
    const error = new ExampleError({ reason: "expected" });
    const outcome = outcomeFromExit(Exit.fail(error));
    expect(outcome).toEqual({
      type: "state",
      state: { status: "error", error },
    });
    if (outcome.type === "state" && outcome.state.status === "error") {
      expect(outcome.state.error._tag).toBe("ExampleError");
    }
  });

  it("maps interruption to 'interrupted' (not an error state)", () => {
    const exit = Exit.failCause(Cause.interrupt(FiberId.none));
    expect(outcomeFromExit(exit)).toEqual({ type: "interrupted" });
  });

  it("maps defects to 'defect' so the hook can rethrow them", () => {
    const boom = new Error("bug, not a typed error");
    const outcome = outcomeFromExit(Exit.die(boom));
    expect(outcome).toEqual({ type: "defect", defect: boom });
  });

  it("prefers the typed failure when a cause mixes failure and interruption", () => {
    const error = new ExampleError({ reason: "raced" });
    const cause = Cause.sequential(Cause.fail(error), Cause.interrupt(FiberId.none));
    expect(outcomeFromExit(Exit.failCause(cause))).toEqual({
      type: "state",
      state: { status: "error", error },
    });
  });
});
