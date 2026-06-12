/**
 * Collision-classification patterns (#32/#44): which mint failures the
 * deterministic-counter retry ladders may recover from.
 */
import { describe, expect, it } from "vitest";

import {
  isOutputsAlreadySignedFailure,
  isOutputsPendingFailure,
  isRecoverableOutputCollision,
  MintProtocolError,
} from "./errors.js";

const protocolError = (detail: string, code: number | null = null) =>
  new MintProtocolError({ mintUrl: "https://mint.example", code, status: 400, detail });

describe("isOutputsAlreadySignedFailure", () => {
  it("matches NUT code 11005 regardless of message", () => {
    expect(isOutputsAlreadySignedFailure(protocolError("whatever", 11005))).toBe(true);
  });

  it("matches nutshell-style message variants", () => {
    expect(isOutputsAlreadySignedFailure(protocolError("outputs have already been signed"))).toBe(
      true,
    );
  });

  it("matches cdk's 'Duplicate outputs' (testnut since cdk 0.17, #44)", () => {
    expect(isOutputsAlreadySignedFailure(protocolError("Duplicate outputs"))).toBe(true);
    expect(isRecoverableOutputCollision(protocolError("Duplicate outputs"))).toBe(true);
  });

  it("does not match unrelated protocol errors", () => {
    expect(isOutputsAlreadySignedFailure(protocolError("Token Already Spent"))).toBe(false);
    expect(isRecoverableOutputCollision(protocolError("Token Already Spent"))).toBe(false);
  });
});

describe("isOutputsPendingFailure", () => {
  it("matches NUT code 11004 and message variants", () => {
    expect(isOutputsPendingFailure(protocolError("x", 11004))).toBe(true);
    expect(isOutputsPendingFailure(protocolError("outputs are pending"))).toBe(true);
    expect(isOutputsPendingFailure(protocolError("nope"))).toBe(false);
  });
});
