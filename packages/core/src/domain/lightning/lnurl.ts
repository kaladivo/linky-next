/**
 * LNURL target parsing — pure. Ported from the PoC's `lnurlPay.ts` resolution
 * chain and pinned by `__fixtures__/lightning.golden.json`:
 *
 * - bech32 `lnurl1…` (LUD-01), case-insensitive, optional `lightning:` prefix;
 * - `lnurlp://…` / `lnurlw://…` schemes (LUD-17 style, as the PoC handles
 *   them: scheme swapped for `https://`), carrying a pay/withdraw kind hint;
 * - bare `http(s)://` URLs (kind unknown until the metadata fetch);
 * - lightning addresses resolve via `lightningAddress.ts` to the well-known
 *   LNURL-pay endpoint.
 *
 * Empty path segments are collapsed (`/lnurlp//AVH9zJ` → `/lnurlp/AVH9zJ`),
 * mirroring other LNURL wallets and the PoC.
 *
 * Intentional divergence from the PoC (see `__fixtures__/README.md`):
 * `lnurlp://user@domain` strips the scheme before the address check, so it
 * resolves to the address's well-known URL instead of a nonsense URL.
 */
import { bech32, utf8 } from "@scure/base";
import { Effect } from "effect";

import { InvalidLnurlError } from "./errors.js";
import { collapseUrlPathSlashes, isHttpUrl, parseHttpUrl } from "./internal/httpUrl.js";
import { lightningAddressOrNull, stripLightningPrefix } from "./lightningAddress.js";

const LNURL_BECH32_LIMIT = 2048;

/** "pay" / "withdraw" when the encoding says so; "unknown" until metadata. */
export type LnurlKind = "pay" | "withdraw" | "unknown";

export interface LnurlTarget {
  /** HTTPS(S) endpoint to fetch the LNURL metadata from. */
  readonly url: string;
  readonly kind: LnurlKind;
}

/** Collapses consecutive empty path segments, leaving authority/query alone. */
export const normalizeLnurlHttpUrl = (value: string): string =>
  isHttpUrl(value) ? collapseUrlPathSlashes(value) : value;

/** Decodes a bech32 `lnurl1…` string to its embedded http(s) URL, or null. */
export const decodeLnurlBech32Url = (value: string): string | null => {
  const normalized = stripLightningPrefix(value);
  if (!/^lnurl1/i.test(normalized)) return null;

  try {
    const decoded = bech32.decodeUnsafe(normalized.toLowerCase(), LNURL_BECH32_LIMIT);
    if (!decoded) return null;
    const bytes = Uint8Array.from(bech32.fromWords(decoded.words));
    const text = utf8.encode(bytes).trim();
    if (!isHttpUrl(text)) return null;
    return normalizeLnurlHttpUrl(text);
  } catch {
    return null;
  }
};

const schemeTargetToUrl = (rawTarget: string): string | null => {
  // Divergence from the PoC (intent-preserving fix): an address inside the
  // scheme resolves to its well-known URL.
  const address = lightningAddressOrNull(rawTarget);
  if (address !== null) return address.lnurlpUrl;
  const httpUrl = `https://${rawTarget}`;
  return isHttpUrl(httpUrl) ? httpUrl : null;
};

/** `lnurlp://…` → https pay endpoint, or null. */
export const decodeLnurlPaySchemeUrl = (value: string): string | null => {
  const normalized = stripLightningPrefix(value);
  if (!/^lnurlp:\/\//i.test(normalized)) return null;
  return schemeTargetToUrl(normalized.replace(/^lnurlp:\/\//i, "").trim());
};

/** `lnurlw://…` → https withdraw endpoint, or null. */
export const decodeLnurlWithdrawSchemeUrl = (value: string): string | null => {
  const normalized = stripLightningPrefix(value);
  if (!/^lnurlw:\/\//i.test(normalized)) return null;
  const rawTarget = normalized.replace(/^lnurlw:\/\//i, "").trim();
  const httpUrl = `https://${rawTarget}`;
  return isHttpUrl(httpUrl) ? httpUrl : null;
};

/** Resolves any LNURL spelling to its endpoint + kind hint, or null. */
export const lnurlTargetOrNull = (value: string): LnurlTarget | null => {
  const normalized = stripLightningPrefix(value);

  const payScheme = decodeLnurlPaySchemeUrl(normalized);
  if (payScheme !== null) return { url: payScheme, kind: "pay" };

  const withdrawScheme = decodeLnurlWithdrawSchemeUrl(normalized);
  if (withdrawScheme !== null) return { url: withdrawScheme, kind: "withdraw" };

  const address = lightningAddressOrNull(normalized);
  if (address !== null) return { url: address.lnurlpUrl, kind: "pay" };

  const bech32Url = decodeLnurlBech32Url(normalized);
  if (bech32Url !== null) return { url: bech32Url, kind: "unknown" };

  if (isHttpUrl(normalized)) return { url: normalized, kind: "unknown" };

  return null;
};

export const parseLnurl = (value: string): Effect.Effect<LnurlTarget, InvalidLnurlError> =>
  Effect.suspend(() => {
    const target = lnurlTargetOrNull(value);
    return target === null
      ? Effect.fail(new InvalidLnurlError({ reason: "unrecognized" }))
      : Effect.succeed(target);
  });

/** A target usable for LNURL-pay (anything except an explicit withdraw). */
export const resolveLnurlPayUrl = (value: string): Effect.Effect<string, InvalidLnurlError> =>
  Effect.suspend(() => {
    const target = lnurlTargetOrNull(value);
    if (target === null) return Effect.fail(new InvalidLnurlError({ reason: "unrecognized" }));
    if (target.kind === "withdraw") {
      return Effect.fail(new InvalidLnurlError({ reason: "not-pay-target" }));
    }
    return Effect.succeed(target.url);
  });

/** A target usable for LNURL-withdraw (kind resolved by the metadata tag). */
export const resolveLnurlWithdrawUrl = (
  value: string,
): Effect.Effect<string, InvalidLnurlError> =>
  Effect.suspend(() => {
    const target = lnurlTargetOrNull(value);
    if (target === null) return Effect.fail(new InvalidLnurlError({ reason: "unrecognized" }));
    if (target.kind === "pay") {
      return Effect.fail(new InvalidLnurlError({ reason: "not-withdraw-target" }));
    }
    return Effect.succeed(target.url);
  });

/** Human-facing text for an LNURL target (PoC `getLnurlPayDisplayText`). */
export const lnurlDisplayText = (value: string): string => {
  const normalized = stripLightningPrefix(value);
  const address = lightningAddressOrNull(normalized);
  if (address !== null) return address.address;

  const target = lnurlTargetOrNull(normalized);
  if (target === null) return normalized;

  const url = parseHttpUrl(target.url);
  if (url === null) return target.url;
  const path = url.path === "/" ? "" : url.path;
  return `${url.host}${path}`;
};

/**
 * Best-effort lightning address for an LNURL-pay endpoint
 * (`…/.well-known/lnurlp/<user>` or `…/lnurlp/<user>` → `user@host`), used to
 * match scanned LNURLs against saved contacts. PoC
 * `inferLightningAddressFromLnurlTarget`.
 */
export const inferLightningAddressFromLnurl = (value: string): string | null => {
  const normalized = stripLightningPrefix(value);
  const address = lightningAddressOrNull(normalized);
  if (address !== null) return address.address;

  const target = lnurlTargetOrNull(normalized);
  if (target === null || target.kind === "withdraw") return null;

  const url = parseHttpUrl(target.url);
  if (url === null) return null;
  try {
    const pathSegments = url.path
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));

    if (
      pathSegments.length >= 3 &&
      pathSegments[0] === ".well-known" &&
      pathSegments[1]?.toLowerCase() === "lnurlp"
    ) {
      return `${pathSegments[2] ?? ""}@${url.host}`;
    }

    if (pathSegments.length >= 2 && pathSegments[0]?.toLowerCase() === "lnurlp") {
      return `${pathSegments[1] ?? ""}@${url.host}`;
    }

    return null;
  } catch {
    return null;
  }
};
