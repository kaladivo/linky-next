import { describe, expect, it } from "vitest";

import type { BalanceTokenInput } from "./balances.js";
import {
  ZERO_BALANCE,
  computeWalletBalances,
  mintBalanceFor,
  splitByMainMint,
  unitBalanceFor,
} from "./balances.js";
import type { TokenState } from "./tokenState.js";
import { TOKEN_STATES } from "./tokenState.js";

const MAIN = "https://mint.main.example";
const FOREIGN = "https://mint.foreign.example";

const row = (
  state: TokenState,
  amount: number,
  mintUrl: string = MAIN,
  unit = "sat",
): BalanceTokenInput => ({ mintUrl, unit, amount, state });

describe("computeWalletBalances", () => {
  it("computes spendable vs total over a mixed-state fixture", () => {
    const balances = computeWalletBalances([
      row("accepted", 100),
      row("accepted", 25),
      row("issued", 30), // total only
      row("pending", 10), // total only
      row("reserved", 5), // total only
      row("externalized", 8), // total only
      row("spent", 1000), // never counts
      row("deleted", 500), // never counts
      row("error", 250), // never counts
    ]);

    expect(unitBalanceFor(balances, "sat")).toEqual({ total: 178, spendable: 125 });
  });

  it.each(["spent", "deleted", "error"] as const)(
    "a wallet holding only %s rows reports zero and an empty breakdown",
    (state) => {
      const balances = computeWalletBalances([row(state, 10), row(state, 20, FOREIGN)]);
      expect(balances.byUnit).toEqual([]);
      expect(balances.byMint).toEqual([]);
      expect(unitBalanceFor(balances, "sat")).toEqual(ZERO_BALANCE);
    },
  );

  it("breaks balances down per mint, sorted by mint URL", () => {
    const balances = computeWalletBalances([
      row("accepted", 100, MAIN),
      row("issued", 30, MAIN),
      row("accepted", 7, FOREIGN),
      row("externalized", 3, FOREIGN),
    ]);

    expect(balances.byMint.map((m) => m.mintUrl)).toEqual([FOREIGN, MAIN]);
    expect(mintBalanceFor(balances, MAIN, "sat")).toEqual({ total: 130, spendable: 100 });
    expect(mintBalanceFor(balances, FOREIGN, "sat")).toEqual({ total: 10, spendable: 7 });
    expect(mintBalanceFor(balances, "https://unknown.example", "sat")).toEqual(ZERO_BALANCE);
  });

  it("breaks balances down per unit and never sums across units", () => {
    const balances = computeWalletBalances([
      row("accepted", 100, MAIN, "sat"),
      row("accepted", 3, MAIN, "usd"),
      row("issued", 2, FOREIGN, "usd"),
    ]);

    expect(balances.byUnit).toEqual([
      { unit: "sat", total: 100, spendable: 100 },
      { unit: "usd", total: 5, spendable: 3 },
    ]);
    expect(mintBalanceFor(balances, MAIN, "usd")).toEqual({ total: 3, spendable: 3 });
    expect(mintBalanceFor(balances, FOREIGN, "sat")).toEqual(ZERO_BALANCE);
  });

  it("normalizes mint URLs and defaults blank units to sat", () => {
    const balances = computeWalletBalances([
      row("accepted", 10, `${MAIN}/`),
      row("accepted", 5, `  ${MAIN}//  `, "  "),
      row("accepted", 1, "   "), // unusable mint URL — skipped
    ]);
    expect(balances.byMint).toHaveLength(1);
    expect(mintBalanceFor(balances, MAIN, "sat")).toEqual({ total: 15, spendable: 15 });
  });

  it("treats non-finite and non-positive amounts as zero", () => {
    const balances = computeWalletBalances([
      row("accepted", Number.NaN),
      row("accepted", Number.POSITIVE_INFINITY),
      row("accepted", -5),
      row("accepted", 0),
      row("accepted", 2),
    ]);
    expect(unitBalanceFor(balances, "sat")).toEqual({ total: 2, spendable: 2 });
  });

  it("returns empty breakdowns for an empty wallet", () => {
    expect(computeWalletBalances([])).toEqual({ byUnit: [], byMint: [] });
  });
});

describe("splitByMainMint (wallet home #36)", () => {
  it("splits main vs foreign mint balances", () => {
    const balances = computeWalletBalances([
      row("accepted", 100, MAIN),
      row("accepted", 7, FOREIGN),
      row("accepted", 3, "https://mint.other.example"),
    ]);

    const split = splitByMainMint(balances, `${MAIN}/`);
    expect(split.main.mintUrl).toBe(MAIN);
    expect(split.main.byUnit).toEqual([{ unit: "sat", total: 100, spendable: 100 }]);
    expect(split.foreign.map((m) => m.mintUrl)).toEqual([
      FOREIGN,
      "https://mint.other.example",
    ]);
  });

  it("returns a zeroed main entry when the wallet holds nothing at the main mint", () => {
    const balances = computeWalletBalances([row("accepted", 7, FOREIGN)]);
    const split = splitByMainMint(balances, MAIN);
    expect(split.main).toEqual({ mintUrl: MAIN, byUnit: [] });
    expect(split.foreign.map((m) => m.mintUrl)).toEqual([FOREIGN]);
  });
});

// ---------------------------------------------------------------------------
// Property-style checks over randomized mixed-state fixtures (deterministic
// seeded PRNG — no environment-dependent randomness).
// ---------------------------------------------------------------------------

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SPENDABLE: ReadonlySet<TokenState> = new Set(["accepted"]);
const COUNTS_TOTAL: ReadonlySet<TokenState> = new Set([
  "accepted",
  "issued",
  "pending",
  "reserved",
  "externalized",
]);

const MINTS = [MAIN, FOREIGN, "https://mint.third.example"];
const UNITS = ["sat", "usd"];

const randomFixture = (random: () => number, size: number): BalanceTokenInput[] =>
  Array.from({ length: size }, () => {
    const state = TOKEN_STATES[Math.floor(random() * TOKEN_STATES.length)] ?? "accepted";
    return row(
      state,
      Math.floor(random() * 1000),
      MINTS[Math.floor(random() * MINTS.length)] ?? MAIN,
      UNITS[Math.floor(random() * UNITS.length)] ?? "sat",
    );
  });

describe("balance properties (seeded random fixtures)", () => {
  const random = mulberry32(0x1234_5678);

  it("spendable ≤ total for every slice; excluded states never count", () => {
    for (let run = 0; run < 200; run += 1) {
      const fixture = randomFixture(random, Math.floor(random() * 40));
      const balances = computeWalletBalances(fixture);

      // Reference sums computed naively and independently.
      const expectFor = (
        predicate: (input: BalanceTokenInput) => boolean,
        states: ReadonlySet<TokenState>,
      ): number =>
        fixture
          .filter((input) => predicate(input) && states.has(input.state))
          .reduce((sum, input) => sum + input.amount, 0);

      for (const unitEntry of balances.byUnit) {
        expect(unitEntry.spendable).toBeLessThanOrEqual(unitEntry.total);
        expect(unitEntry.total).toBe(expectFor((i) => i.unit === unitEntry.unit, COUNTS_TOTAL));
        expect(unitEntry.spendable).toBe(expectFor((i) => i.unit === unitEntry.unit, SPENDABLE));
      }

      for (const mintEntry of balances.byMint) {
        for (const unitEntry of mintEntry.byUnit) {
          expect(unitEntry.spendable).toBeLessThanOrEqual(unitEntry.total);
          expect(unitEntry.total).toBe(
            expectFor(
              (i) => i.mintUrl === mintEntry.mintUrl && i.unit === unitEntry.unit,
              COUNTS_TOTAL,
            ),
          );
          expect(unitEntry.spendable).toBe(
            expectFor(
              (i) => i.mintUrl === mintEntry.mintUrl && i.unit === unitEntry.unit,
              SPENDABLE,
            ),
          );
        }
      }

      // Per-mint slices sum exactly to the per-unit aggregates.
      for (const unitEntry of balances.byUnit) {
        const summed = balances.byMint
          .flatMap((mint) => mint.byUnit)
          .filter((entry) => entry.unit === unitEntry.unit)
          .reduce(
            (acc, entry) => ({
              total: acc.total + entry.total,
              spendable: acc.spendable + entry.spendable,
            }),
            { total: 0, spendable: 0 },
          );
        expect(summed).toEqual({ total: unitEntry.total, spendable: unitEntry.spendable });
      }
    }
  });

  it("is independent of record order", () => {
    for (let run = 0; run < 50; run += 1) {
      const fixture = randomFixture(random, 25);
      const shuffled = [...fixture].sort(() => (random() < 0.5 ? -1 : 1));
      expect(computeWalletBalances(shuffled)).toEqual(computeWalletBalances(fixture));
    }
  });

  it("adding a row in an excluded state never changes any balance", () => {
    for (const state of ["spent", "deleted", "error"] as const) {
      const fixture = randomFixture(random, 20);
      const before = computeWalletBalances(fixture);
      const after = computeWalletBalances([...fixture, row(state, 999_999)]);
      expect(after).toEqual(before);
    }
  });
});
