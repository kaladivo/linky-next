import { Option } from "effect";
import { describe, expect, it } from "vitest";

import type { TokenState, TokenStateTransitionTag } from "./tokenState.js";
import {
  PURGEABLE_TOKEN_STATES,
  SPENDABLE_TOKEN_STATES,
  TOKEN_STATES,
  TOKEN_STATE_TRANSITIONS,
  TOTAL_BALANCE_TOKEN_STATES,
  canTransitionTokenState,
  countsTowardTotalBalance,
  isPurgeableTokenState,
  isSpendableTokenState,
  nextTokenState,
  normalizeTokenState,
} from "./tokenState.js";

const ALL_TRANSITIONS = Object.keys(TOKEN_STATE_TRANSITIONS) as TokenStateTransitionTag[];

/**
 * The legal-transition table, written out by hand and independently of the
 * implementation — guards against accidental edits to the production table.
 */
const EXPECTED: ReadonlyArray<readonly [TokenState, TokenStateTransitionTag, TokenState]> = [
  ["accepted", "Emit", "issued"],
  ["accepted", "Reserve", "reserved"],
  ["accepted", "Externalize", "externalized"],
  ["accepted", "MarkSpent", "spent"],
  ["accepted", "MarkError", "error"],
  ["accepted", "Delete", "deleted"],

  ["issued", "MarkInFlight", "pending"],
  ["issued", "Externalize", "externalized"],
  ["issued", "Return", "accepted"],
  ["issued", "MarkSpent", "spent"],
  ["issued", "MarkError", "error"],
  ["issued", "Delete", "deleted"],

  ["pending", "Return", "accepted"],
  ["pending", "MarkSpent", "spent"],
  ["pending", "MarkError", "error"],
  ["pending", "Delete", "deleted"],

  ["reserved", "Return", "accepted"],
  ["reserved", "MarkSpent", "spent"],
  ["reserved", "MarkError", "error"],
  ["reserved", "Delete", "deleted"],

  ["externalized", "Return", "accepted"],
  ["externalized", "MarkSpent", "spent"],
  ["externalized", "MarkError", "error"],
  ["externalized", "Delete", "deleted"],

  ["spent", "Delete", "deleted"],

  ["error", "Recover", "accepted"],
  ["error", "MarkSpent", "spent"],
  ["error", "Delete", "deleted"],

  // deleted is terminal — no rows.
];

const expectedTarget = (
  from: TokenState,
  transition: TokenStateTransitionTag,
): TokenState | undefined =>
  EXPECTED.find(([f, t]) => f === from && t === transition)?.[2];

describe("token state machine", () => {
  it("covers exactly the eight feature-map states", () => {
    expect([...TOKEN_STATES].sort()).toEqual(
      ["accepted", "deleted", "error", "externalized", "issued", "pending", "reserved", "spent"].sort(),
    );
  });

  it.each(
    TOKEN_STATES.flatMap((from) => ALL_TRANSITIONS.map((transition) => [from, transition] as const)),
  )("decides (%s, %s) exactly like the hand-written table", (from, transition) => {
    const expected = expectedTarget(from, transition);
    expect(canTransitionTokenState(from, transition)).toBe(expected !== undefined);
    const next = nextTokenState(from, transition);
    if (expected === undefined) {
      expect(Option.isNone(next)).toBe(true);
    } else {
      expect(next).toEqual(Option.some(expected));
    }
  });

  it("makes deleted terminal", () => {
    for (const transition of ALL_TRANSITIONS) {
      expect(canTransitionTokenState("deleted", transition)).toBe(false);
    }
  });

  it("allows nothing but Delete out of spent", () => {
    for (const transition of ALL_TRANSITIONS) {
      expect(canTransitionTokenState("spent", transition)).toBe(transition === "Delete");
    }
  });

  it("gives every non-terminal state a path to deletion (cleanup always possible)", () => {
    for (const state of TOKEN_STATES) {
      if (state === "deleted") continue;
      expect(canTransitionTokenState(state, "Delete")).toBe(true);
    }
  });

  it("gives every unavailable-but-live state a recovery path back to accepted", () => {
    expect(nextTokenState("issued", "Return")).toEqual(Option.some("accepted"));
    expect(nextTokenState("pending", "Return")).toEqual(Option.some("accepted"));
    expect(nextTokenState("reserved", "Return")).toEqual(Option.some("accepted"));
    expect(nextTokenState("externalized", "Return")).toEqual(Option.some("accepted"));
    expect(nextTokenState("error", "Recover")).toEqual(Option.some("accepted"));
  });
});

describe("normalizeTokenState", () => {
  it.each(TOKEN_STATES)("round-trips %s", (state) => {
    expect(normalizeTokenState(state)).toEqual(Option.some(state));
    expect(normalizeTokenState(`  ${state}  `)).toEqual(Option.some(state));
  });

  it.each(["", "  ", "ACCEPTED", "claimed", "unknown", null, undefined, 7, {}])(
    "rejects %j",
    (value) => {
      expect(Option.isNone(normalizeTokenState(value))).toBe(true);
    },
  );
});

describe("state classification", () => {
  it("accepted is the only spendable state", () => {
    expect([...SPENDABLE_TOKEN_STATES]).toEqual(["accepted"]);
    for (const state of TOKEN_STATES) {
      expect(isSpendableTokenState(state)).toBe(state === "accepted");
    }
  });

  it("spendable states are a subset of total-balance states", () => {
    for (const state of SPENDABLE_TOKEN_STATES) {
      expect(TOTAL_BALANCE_TOKEN_STATES.has(state)).toBe(true);
    }
  });

  it("total balance counts live value only — never spent/deleted/error", () => {
    for (const state of TOKEN_STATES) {
      expect(countsTowardTotalBalance(state)).toBe(
        !["spent", "deleted", "error"].includes(state),
      );
    }
  });

  it("purgeable states are exactly spent and deleted, disjoint from total balance", () => {
    expect([...PURGEABLE_TOKEN_STATES].sort()).toEqual(["deleted", "spent"]);
    for (const state of PURGEABLE_TOKEN_STATES) {
      expect(TOTAL_BALANCE_TOKEN_STATES.has(state)).toBe(false);
    }
    for (const state of TOKEN_STATES) {
      expect(isPurgeableTokenState(state)).toBe(state === "spent" || state === "deleted");
    }
  });
});
