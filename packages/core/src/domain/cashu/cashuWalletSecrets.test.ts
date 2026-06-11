/**
 * Secret-safety: no proof secret, wallet seed, or token string may appear in
 * any typed error the engine emits — not in the payload, not in a `cause`
 * chain (extends the README "Secrets" contract to the Cashu engine).
 *
 * Strategy: drive flows into every error-translation path (mint protocol
 * errors carrying our swap inputs, HTTP failures, transport failures) and
 * deep-serialize the failure, asserting it contains no secret material.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { Cause, Effect, Layer } from "effect";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { CounterStoreMemory } from "../../ports/CounterStore.js";
import { HttpClient, HttpClientError } from "../../ports/index.js";
import {
  ALICE_SEED,
  engineLayers,
  makeFundingToken,
} from "./__tests__/helpers.js";
import { FAKE_MINT_URL, FakeMint } from "./__tests__/fakeMint.js";
import { payInvoice } from "./meltToken.js";
import { receiveToken } from "./receiveToken.js";
import { createSendToken } from "./sendToken.js";

/** Every representation an error could leak through. */
const serializeDeep = (error: unknown): string => {
  const parts = [
    String(error),
    JSON.stringify(error),
    inspect(error, { depth: 20 }),
  ];
  let cause: unknown = (error as { cause?: unknown }).cause;
  let depth = 0;
  while (cause !== undefined && depth < 10) {
    parts.push(String(cause), inspect(cause, { depth: 20 }));
    cause = (cause as { cause?: unknown }).cause;
    depth += 1;
  }
  return parts.join("\n");
};

const SEED_HEX = bytesToHex(ALICE_SEED);

const expectNoSecrets = (
  failure: unknown,
  secrets: ReadonlyArray<string>,
  tokens: ReadonlyArray<string> = [],
): void => {
  const serialized = serializeDeep(failure);
  expect(serialized).not.toContain(SEED_HEX);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
  for (const token of tokens) expect(serialized).not.toContain(token.slice(0, 64));
};

describe("cashu engine secret-safety", () => {
  it("mint protocol errors never carry the submitted proof secrets", async () => {
    const mint = new FakeMint();
    const { failure, secrets, token } = await Effect.runPromise(
      Effect.gen(function* () {
        const funding = yield* makeFundingToken(mint, [4], "leak-check");
        mint.markSpent(funding.proofs[0]!.secret); // swap will 400 with code 11001
        const failed = yield* Effect.flip(
          createSendToken({
            seed: ALICE_SEED,
            mintUrl: FAKE_MINT_URL,
            amount: 4,
            tokens: [funding.token],
          }),
        );
        return {
          failure: failed,
          secrets: funding.proofs.map((proof) => proof.secret),
          token: funding.token,
        };
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    // Spent state is reported by checkstate first → insufficient funds here;
    // both paths must be clean.
    expectNoSecrets(failure, secrets, [token]);
  });

  it("melt failures keep change/inputs out of the error", async () => {
    const mint = new FakeMint();
    const { failure, secrets } = await Effect.runPromise(
      Effect.gen(function* () {
        const funding = yield* makeFundingToken(mint, [32, 2], "melt-leak");
        const failed = yield* Effect.flip(
          payInvoice({
            seed: ALICE_SEED,
            mintUrl: FAKE_MINT_URL,
            invoice: "lnbc-unparseable",
            tokens: [funding.token],
          }),
        );
        return { failure: failed, secrets: funding.proofs.map((proof) => proof.secret) };
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect((failure as { _tag: string })._tag).toBe("MintProtocolError");
    expectNoSecrets(failure, secrets);
  });

  it("transport failures collapse to reason strings (no request bodies)", async () => {
    const failingHttp = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.RequestError({
            request,
            reason: "Transport",
            description: "socket hang up",
          }),
        ),
      ),
    );
    const mint = new FakeMint();
    const { failure, token, secrets } = await Effect.runPromise(
      Effect.gen(function* () {
        const funding = yield* makeFundingToken(mint, [2], "transport-leak");
        const failed = yield* Effect.flip(
          receiveToken({ seed: ALICE_SEED, token: funding.token }),
        );
        return {
          failure: failed,
          token: funding.token,
          secrets: funding.proofs.map((proof) => proof.secret),
        };
      }).pipe(Effect.provide(failingHttp), Effect.provide(CounterStoreMemory)),
    );
    expect((failure as { _tag: string })._tag).toBe("MintConnectionError");
    expectNoSecrets(failure, secrets, [token]);
    expect(serializeDeep(failure)).toContain("socket hang up");
  });

  it("HTTP-status failures carry only the mint's message", async () => {
    const mint = new FakeMint();
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        // Valid token, but at an unrouted mint → 404 "unknown host".
        const funding = yield* makeFundingToken(mint, [2], "unrouted", "https://unrouted.test");
        return yield* Effect.flip(receiveToken({ seed: ALICE_SEED, token: funding.token }));
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(failure._tag).toBe("MintProtocolError");
    if (failure._tag === "MintProtocolError") {
      expect(failure.status).toBe(404);
    }
    expectNoSecrets(failure, []);
  });

  it("defect-free: failed flows leave no counter lock held", async () => {
    const mint = new FakeMint();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const funding = yield* makeFundingToken(mint, [1, 2, 4], "lock-release");
        mint.markSpent(funding.proofs[0]!.secret);
        mint.markSpent(funding.proofs[1]!.secret);
        mint.markSpent(funding.proofs[2]!.secret);
        // First receive fails (all inputs spent)…
        const first = yield* Effect.either(
          receiveToken({ seed: ALICE_SEED, token: funding.token }),
        );
        // …and the lock must be free for the next operation.
        const fresh = yield* makeFundingToken(mint, [2], "lock-release-2");
        const second = yield* receiveToken({ seed: ALICE_SEED, token: fresh.token });
        return { first, second };
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(result.first._tag).toBe("Left");
    expect(result.second.amount).toBe(2);
  });

  it("failure causes contain no defects smuggling secrets", async () => {
    const mint = new FakeMint();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const funding = yield* makeFundingToken(mint, [4], "exit-leak");
        mint.markSpent(funding.proofs[0]!.secret);
        return yield* createSendToken({
          seed: ALICE_SEED,
          mintUrl: FAKE_MINT_URL,
          amount: 4,
          tokens: [funding.token],
        });
      }).pipe(Effect.provide(engineLayers(mint))),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const pretty = Cause.pretty(exit.cause);
      expect(pretty).not.toContain(SEED_HEX);
      expect(pretty).not.toContain("exit-leak");
    }
  });
});
