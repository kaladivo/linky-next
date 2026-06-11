/**
 * Shared pieces of the deterministic-counter discipline (PoC
 * `utils/cashuDeterministic.ts` + per-flow retry loops).
 *
 * Counter contract (identical to the PoC):
 *
 * - every counter-consuming mint call runs under the per-keyset counter lock;
 * - the call uses the CURRENT counter as `counter` option;
 * - on success the counter advances by exactly the number of derivations the
 *   operation consumed;
 * - on a recoverable output collision (NUT 11004/11005) the counter is
 *   advanced past the colliding range (precisely via NUT-09 restore where
 *   possible, otherwise by the fixed {@link COLLISION_BUMP}) and the call is
 *   retried, at most {@link MAX_COLLISION_ATTEMPTS} times.
 */
import type { Token } from "@cashu/cashu-ts";
import { getDecodedToken, getTokenMetadata } from "@cashu/cashu-ts";
import { Effect } from "effect";

import type { KeysetRef } from "../../../ports/CounterStore.js";
import { normalizeMintUrl } from "../../../ports/CounterStore.js";
import { InvalidCashuTokenError, WrongMintError } from "../errors.js";
import type { WalletHandle } from "./wallet.js";

/**
 * The engine NEVER consumes counter slot 0.
 *
 * cashu-ts 2.9.0 has a falsy-counter quirk in `createSwapPayload`: the send
 * outputs' counter is computed as `counter ? counter + keep.length :
 * undefined`, so a literal counter of 0 silently produces RANDOM outputs in
 * receive/send/swap — proofs that NUT-09 restore can never find. The PoC
 * inherits this quirk on the first operation of every fresh keyset; this
 * engine deliberately diverges (funds-recovery correctness beats
 * bug-compatibility): every flow floors the stored counter to
 * {@link MIN_COUNTER} before use and ratchets it past the consumed range
 * afterwards. Restore still scans from 0, so PoC-migrated wallets (which may
 * have signatures at slot 0 from mint/melt flows, where 0 worked) lose
 * nothing.
 */
export const MIN_COUNTER = 1;

/** The counter value a flow actually passes to cashu-ts. */
export const effectiveCounter = (storedCounter: number): number =>
  Math.max(MIN_COUNTER, storedCounter);

/** Fixed counter bump when the colliding range cannot be measured (PoC). */
export const COLLISION_BUMP = 64;

/** Maximum retries for recoverable output collisions (PoC). */
export const MAX_COLLISION_ATTEMPTS = 5;

export const keysetRefOf = (handle: WalletHandle): KeysetRef => ({
  mintUrl: handle.mintUrl,
  unit: handle.unit,
  keysetId: handle.keysetId,
});

/**
 * Decodes a token string against a loaded wallet, structurally enforcing
 * that it belongs to the wallet's mint — one operation never mixes mints
 * (PoC `decodeCashuTokenForMint`, "Mixed mints not supported").
 */
export const decodeTokenForMint = (
  handle: WalletHandle,
  tokenText: string,
): Effect.Effect<Token, InvalidCashuTokenError | WrongMintError> =>
  Effect.suspend((): Effect.Effect<Token, InvalidCashuTokenError | WrongMintError> => {
    const raw = String(tokenText ?? "").trim();
    if (raw === "") return Effect.fail(new InvalidCashuTokenError({ reason: "empty" }));

    let tokenMintUrl: string;
    try {
      tokenMintUrl = normalizeMintUrl(getTokenMetadata(raw).mint ?? "");
    } catch {
      return Effect.fail(new InvalidCashuTokenError({ reason: "unparseable" }));
    }
    if (tokenMintUrl === "") {
      return Effect.fail(new InvalidCashuTokenError({ reason: "missing-mint" }));
    }
    if (tokenMintUrl !== handle.mintUrl) {
      return Effect.fail(
        new WrongMintError({ expectedMintUrl: handle.mintUrl, tokenMintUrl }),
      );
    }

    try {
      // Pass the wallet's keysets so short keyset ids (v2) can be mapped.
      return Effect.succeed(getDecodedToken(raw, handle.wallet.keysets));
    } catch {
      return Effect.fail(new InvalidCashuTokenError({ reason: "unparseable" }));
    }
  });

/**
 * Number of NUT-08 blank outputs cashu-ts emits for a fee reserve. Mirrors
 * cashu-ts `CashuWallet.createBlankOutputs` (and the PoC's copy in
 * `cashuMelt.ts`): every blank consumes a deterministic counter slot AND
 * lands in the mint's promises table before the LN payment — the counter
 * must advance past the FULL blank range, not just the signed change.
 */
export const computeNumberOfBlankOutputs = (feeReserve: number): number => {
  const fr = Number.isFinite(feeReserve) && feeReserve > 0 ? Math.trunc(feeReserve) : 0;
  if (fr <= 0) return 0;
  const r = Math.ceil(Math.log2(fr)) || 1;
  return r < 0 ? 0 : r;
};
