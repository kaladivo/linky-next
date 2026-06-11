/**
 * Lightning address (LUD-16) parsing — pure. `user@domain` resolves to the
 * LNURL-pay well-known endpoint `https://domain/.well-known/lnurlp/<user>`,
 * exactly as the PoC's `getLnurlpUrlFromLightningAddress` (pinned by the
 * golden fixture, e.g. `satoshi+tips@…` → `…/lnurlp/satoshi%2Btips`).
 */
import { Effect } from "effect";

import { InvalidLightningAddressError } from "./errors.js";

/** PoC pattern: one `@`, no whitespace, domain contains a dot. */
const LIGHTNING_ADDRESS_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const stripLightningPrefix = (value: string): string =>
  value.replace(/^lightning:/i, "").trim();

export interface LightningAddress {
  /** Canonical `user@domain` text (prefix-stripped, trimmed). */
  readonly address: string;
  readonly user: string;
  readonly domain: string;
  /** LNURL-pay well-known endpoint for the address. */
  readonly lnurlpUrl: string;
}

export const isLightningAddress = (value: string): boolean =>
  LIGHTNING_ADDRESS_PATTERN.test(stripLightningPrefix(value));

/** Pure variant used by other parsers; `null` when not an address. */
export const lightningAddressOrNull = (value: string): LightningAddress | null => {
  const address = stripLightningPrefix(value);
  if (!LIGHTNING_ADDRESS_PATTERN.test(address)) return null;
  const at = address.lastIndexOf("@");
  const user = address.slice(0, at);
  const domain = address.slice(at + 1);
  return {
    address,
    user,
    domain,
    lnurlpUrl: `https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`,
  };
};

export const parseLightningAddress = (
  value: string,
): Effect.Effect<LightningAddress, InvalidLightningAddressError> =>
  Effect.suspend(() => {
    const parsed = lightningAddressOrNull(value);
    return parsed === null
      ? Effect.fail(new InvalidLightningAddressError({ reason: "format" }))
      : Effect.succeed(parsed);
  });
