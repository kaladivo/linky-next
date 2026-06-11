/**
 * Unified Lightning input classification — the Lightning slice of the #48
 * unified parser. Pure: classifies pasted/scanned text into a discriminated
 * union without any network access. Kind hints for plain `lnurl1…` / http
 * targets stay `Lnurl` (unknown) until the metadata fetch reveals the tag,
 * exactly like the PoC scanner, which tries withdraw first and falls back to
 * pay on a tag mismatch.
 *
 * Classification order (PoC scanner semantics, scheme check hoisted):
 * explicit lnurl schemes → lightning address → bolt11 prefix → bech32
 * lnurl / bare http URL.
 */
import { Effect } from "effect";

import type { Bolt11Invoice } from "./bolt11.js";
import { isBolt11Invoice, parseBolt11Invoice } from "./bolt11.js";
import { UnrecognizedLightningInputError } from "./errors.js";
import type { LightningAddress } from "./lightningAddress.js";
import { lightningAddressOrNull, stripLightningPrefix } from "./lightningAddress.js";
import {
  decodeLnurlPaySchemeUrl,
  decodeLnurlWithdrawSchemeUrl,
  lnurlTargetOrNull,
} from "./lnurl.js";

export type LightningInput =
  | { readonly _tag: "LightningAddressInput"; readonly address: LightningAddress }
  | { readonly _tag: "Bolt11Input"; readonly invoice: Bolt11Invoice }
  | { readonly _tag: "LnurlPayInput"; readonly url: string }
  | { readonly _tag: "LnurlWithdrawInput"; readonly url: string }
  /** LNURL whose sub-protocol is unknown until the metadata fetch. */
  | { readonly _tag: "LnurlInput"; readonly url: string };

/**
 * Classifies a Lightning-ish string (`lightning:` prefix tolerated). Fails
 * with {@link UnrecognizedLightningInputError} for everything else — callers
 * (the future #48 parser) try other domains (cashu token, npub, …) first or
 * after, as the PoC scanner does.
 */
export const parseLightningInput = (
  raw: string,
): Effect.Effect<LightningInput, UnrecognizedLightningInputError> =>
  Effect.suspend(() => {
    const text = stripLightningPrefix(String(raw).trim());
    if (text === "") return Effect.fail(new UnrecognizedLightningInputError());

    const payScheme = decodeLnurlPaySchemeUrl(text);
    if (payScheme !== null) {
      return Effect.succeed<LightningInput>({ _tag: "LnurlPayInput", url: payScheme });
    }

    const withdrawScheme = decodeLnurlWithdrawSchemeUrl(text);
    if (withdrawScheme !== null) {
      return Effect.succeed<LightningInput>({ _tag: "LnurlWithdrawInput", url: withdrawScheme });
    }

    const address = lightningAddressOrNull(text);
    if (address !== null) {
      return Effect.succeed<LightningInput>({ _tag: "LightningAddressInput", address });
    }

    if (isBolt11Invoice(text)) {
      return parseBolt11Invoice(text).pipe(
        Effect.map((invoice): LightningInput => ({ _tag: "Bolt11Input", invoice })),
        Effect.mapError(() => new UnrecognizedLightningInputError()),
      );
    }

    const lnurl = lnurlTargetOrNull(text);
    if (lnurl !== null) {
      return Effect.succeed<LightningInput>({ _tag: "LnurlInput", url: lnurl.url });
    }

    return Effect.fail(new UnrecognizedLightningInputError());
  });
