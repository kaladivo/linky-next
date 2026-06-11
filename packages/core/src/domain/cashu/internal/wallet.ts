/**
 * Loaded cashu-ts wallet handles (PoC `utils/cashuWallet.ts` semantics),
 * including the mint-compatibility fallback for mints whose keyset ids
 * cannot be verified by cashu-ts (`createWalletFromFallbackMintData` in the
 * PoC): pick the cheapest active hex keyset for the unit, fetch its keys
 * manually, and construct the wallet with pre-loaded mint data.
 */
import type { Logger, MintKeyset } from "@cashu/cashu-ts";
import { CashuMint, CashuWallet } from "@cashu/cashu-ts";
import { Effect } from "effect";

import { normalizeMintUrl } from "../../../ports/CounterStore.js";
import type { HttpClient } from "../../../ports/index.js";
import type { CashuSeed } from "../../identity/DerivedIdentities.js";
import type { CashuMintFailure } from "../errors.js";
import { KeysetUnavailableError, sanitizeCashuFailure } from "../errors.js";
import { makeMintRequest } from "./transport.js";

/** No-op logger: nothing in core may write to the console (secrets rule). */
const silentLogger: Logger = {
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
  log: () => undefined,
};

export interface WalletHandle {
  readonly wallet: CashuWallet;
  readonly mintUrl: string;
  readonly unit: string;
  readonly keysetId: string;
}

/** Runs a cashu-ts promise, mapping any throw into a typed, secret-free failure. */
export const runMintCall = <A>(
  mintUrl: string,
  call: () => Promise<A>,
): Effect.Effect<A, CashuMintFailure> =>
  Effect.tryPromise({
    try: call,
    catch: (error) => sanitizeCashuFailure(mintUrl, error),
  });

const isHexString = (value: string): boolean => /^[0-9a-f]+$/i.test(value);

/**
 * Active keyset for the unit with the lowest input fee, hex ids only
 * (PoC `pickPreferredMintKeyset`).
 */
export const pickPreferredMintKeyset = (
  keysets: readonly MintKeyset[],
  unit: string,
): MintKeyset | null => {
  const matches = keysets
    .filter(
      (keyset) => keyset.active && keyset.unit === unit && isHexString(String(keyset.id ?? "")),
    )
    .sort((left, right) => (left.input_fee_ppk ?? 0) - (right.input_fee_ppk ?? 0));
  return matches[0] ?? null;
};

/** PoC `isCashuKeysetVerificationError` — message-based, cashu-ts throws plain Errors here. */
export const isKeysetVerificationFailure = (failure: CashuMintFailure): boolean => {
  const message = (
    failure._tag === "MintProtocolError" ? failure.detail : failure.reason
  ).toLowerCase();
  return (
    message.includes("couldn't verify keyset id") ||
    message.includes("short keyset id v2") ||
    message.includes("got no keysets to map it to") ||
    message.includes("couldn't map short keyset id")
  );
};

export interface LoadWalletArgs {
  readonly mintUrl: string;
  readonly unit?: string | undefined;
  readonly seed?: CashuSeed | undefined;
}

/**
 * Creates a loaded wallet for a mint: `loadMint()` on the happy path, the
 * manual keyset fallback when keyset-id verification fails. The deterministic
 * seed (when provided) makes every output derivation NUT-13 deterministic.
 */
export const loadWallet = (
  args: LoadWalletArgs,
): Effect.Effect<WalletHandle, CashuMintFailure | KeysetUnavailableError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const mintUrl = normalizeMintUrl(args.mintUrl);
    const request = yield* makeMintRequest;
    const mint = new CashuMint(mintUrl, request, undefined, { logger: silentLogger });

    const baseOptions: ConstructorParameters<typeof CashuWallet>[1] = {
      logger: silentLogger,
      ...(args.unit !== undefined && String(args.unit).trim() !== ""
        ? { unit: String(args.unit).trim() }
        : {}),
      ...(args.seed !== undefined ? { bip39seed: args.seed } : {}),
    };

    const wallet = new CashuWallet(mint, baseOptions);

    const loaded = yield* runMintCall(mintUrl, () => wallet.loadMint()).pipe(
      Effect.as(wallet),
      Effect.catchAll((failure) =>
        isKeysetVerificationFailure(failure)
          ? loadWalletFallback(mint, mintUrl, baseOptions)
          : Effect.fail(failure),
      ),
    );

    return {
      wallet: loaded,
      mintUrl,
      unit: loaded.unit,
      keysetId: loaded.keysetId,
    };
  });

/** Mint-compatibility fallback (PoC `createWalletFromFallbackMintData`). */
const loadWalletFallback = (
  mint: CashuMint,
  mintUrl: string,
  baseOptions: ConstructorParameters<typeof CashuWallet>[1],
): Effect.Effect<CashuWallet, CashuMintFailure | KeysetUnavailableError> =>
  Effect.gen(function* () {
    const [mintInfo, keysetsResponse] = yield* Effect.all(
      [
        runMintCall(mintUrl, () => mint.getInfo()),
        runMintCall(mintUrl, () => mint.getKeySets()),
      ],
      { concurrency: 2 },
    );

    const unit = baseOptions?.unit ?? "sat";
    const keyset = pickPreferredMintKeyset(keysetsResponse.keysets, unit);
    if (keyset === null) {
      return yield* Effect.fail(new KeysetUnavailableError({ mintUrl, unit }));
    }

    const keysResponse = yield* runMintCall(mintUrl, () => mint.getKeys(keyset.id));
    const keys =
      keysResponse.keysets.find(
        (candidate) => candidate.id === keyset.id && candidate.unit === keyset.unit,
      ) ?? null;
    if (keys === null) {
      return yield* Effect.fail(new KeysetUnavailableError({ mintUrl, unit }));
    }

    const wallet = new CashuWallet(mint, {
      ...baseOptions,
      mintInfo,
      keysets: keysetsResponse.keysets,
      keys,
    });
    wallet.keysetId = keyset.id;
    return wallet;
  });
