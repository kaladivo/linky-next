/**
 * Cashu token codec — parse/serialize raw tokens (V3 `cashuA…` / V4
 * `cashuB…`, delegated to cashu-ts) and the Linky wrapped-link formats
 * (`cashu.parse-token` / `cashu.share-token` in the feature map).
 *
 * Wrapped-link formats (PoC `utils/deepLinks.ts`, pinned by golden
 * fixtures):
 *
 * - share URL: `https://linky.fit/cashu/#<encodeURIComponent(token)>` — the
 *   token travels in the URL FRAGMENT, which browsers never send to the
 *   server, so the linky.fit server (or any proxy) never sees the token.
 * - deep link: `cashu://<token>`.
 *
 * `extractCashuTokenFromText` ports the PoC's scanner/paste extraction
 * (`app/lib/tokenText.ts`): raw tokens, `cashu:`/`web+cashu:` schemes,
 * URLs carrying the token in known query keys or the fragment, tokens
 * embedded in free text, and whitespace-mangled tokens. It is implemented
 * without the WHATWG `URL` global (core targets plain ES2023).
 *
 * Tokens are bearer instruments: never log them; parse failures carry only
 * a coarse reason, never the input text.
 */
import type { MintKeyset, Proof, Token } from "@cashu/cashu-ts";
import { getDecodedToken, getEncodedToken } from "@cashu/cashu-ts";
import { Effect, Either, Option } from "effect";

import { normalizeMintUrl } from "../../ports/CounterStore.js";
import { InvalidCashuTokenError } from "./errors.js";

/** A Cashu proof as carried in tokens (cashu-ts wire shape). */
export type CashuProof = Proof;

export interface ParsedCashuToken {
  readonly mintUrl: string;
  readonly unit: string;
  readonly amount: number;
  readonly memo: Option.Option<string>;
  readonly proofs: ReadonlyArray<CashuProof>;
}

export const sumProofAmounts = (proofs: ReadonlyArray<{ readonly amount: number }>): number =>
  proofs.reduce((sum, proof) => sum + (Number(proof.amount) || 0), 0);

// ---------------------------------------------------------------------------
// NUT-02 v2 keyset-id decode fallback (cashu-ts 2.9.0 limitation)
// ---------------------------------------------------------------------------

const V2_NO_KEYSETS_RE = /short keyset ID v2 was encountered/i;
const V2_UNMAPPED_RE = /map short keyset ID ([0-9a-fA-F]+) to any known/;

/** Pathological-input guard for the id-collection loop (one id per pass). */
const MAX_DISTINCT_KEYSET_IDS = 16;

/**
 * Decodes a serialized token, tolerating NUT-02 **v2 keyset ids** (version
 * byte `0x01` — what current cdk mints like testnut issue). cashu-ts 2.9.0
 * (pinned) refuses to decode such tokens without a mint keyset list to map
 * the ids against — but a PURE parse has no mint at hand, and every caller
 * here either only needs amount/mint/unit (chat token detection, #44) or
 * sends the proofs back to the SAME mint that produced these exact ids
 * (receive/check/melt — the mint accepts its own id form). So v2 ids are
 * identity-mapped: each id cashu-ts reports as unmappable is fed back as a
 * known keyset, which makes the prefix-match a no-op and preserves the ids
 * byte-for-byte. v1 (hex, `0x00`) tokens take the normal path.
 */
const decodeTokenLenient = (raw: string): Token => {
  try {
    return getDecodedToken(raw);
  } catch (error) {
    if (!V2_NO_KEYSETS_RE.test(String(error))) throw error;
  }
  const keysets: MintKeyset[] = [];
  for (let attempt = 0; attempt < MAX_DISTINCT_KEYSET_IDS; attempt += 1) {
    try {
      return getDecodedToken(raw, keysets);
    } catch (error) {
      const match = V2_UNMAPPED_RE.exec(String(error));
      const id = match?.[1];
      if (id === undefined) throw error;
      keysets.push({ id, unit: "sat", active: true });
    }
  }
  throw new Error("token carries too many distinct keyset ids");
};

/**
 * Strictly decodes a raw token string (V3 or V4). The mint URL is
 * normalized; the unit defaults to `sat` (Cashu convention).
 */
export const parseCashuToken = (
  text: string,
): Effect.Effect<ParsedCashuToken, InvalidCashuTokenError> =>
  Effect.suspend(() => {
    const raw = String(text ?? "").trim();
    if (raw === "") return Effect.fail(new InvalidCashuTokenError({ reason: "empty" }));

    let decoded: Token;
    try {
      decoded = decodeTokenLenient(raw);
    } catch {
      return Effect.fail(new InvalidCashuTokenError({ reason: "unparseable" }));
    }

    const mintUrl = normalizeMintUrl(decoded.mint ?? "");
    if (mintUrl === "") return Effect.fail(new InvalidCashuTokenError({ reason: "missing-mint" }));

    return Effect.succeed({
      mintUrl,
      unit: String(decoded.unit ?? "").trim() || "sat",
      amount: sumProofAmounts(decoded.proofs),
      memo: Option.fromNullable(decoded.memo).pipe(
        Option.map((memo) => String(memo)),
        Option.filter((memo) => memo !== ""),
      ),
      proofs: decoded.proofs,
    });
  });

export interface EncodeCashuTokenArgs {
  readonly mintUrl: string;
  readonly proofs: ReadonlyArray<CashuProof>;
  readonly unit?: string | undefined;
  readonly memo?: string | undefined;
}

/**
 * Encodes a token (V4 `cashuB…` by default — cashu-ts falls back to V3
 * automatically for non-hex keyset ids; pass `version: 3` for explicit V3).
 */
export const encodeCashuToken = (
  args: EncodeCashuTokenArgs,
  options?: { readonly version?: 3 | 4 },
): Effect.Effect<string, InvalidCashuTokenError> =>
  Effect.suspend(() => {
    const token: Token = {
      mint: normalizeMintUrl(args.mintUrl),
      proofs: [...args.proofs],
      ...(args.unit !== undefined && args.unit !== "" ? { unit: args.unit } : {}),
      ...(args.memo !== undefined && args.memo !== "" ? { memo: args.memo } : {}),
    };
    try {
      return Effect.succeed(
        getEncodedToken(token, options?.version !== undefined ? { version: options.version } : {}),
      );
    } catch {
      return Effect.fail(new InvalidCashuTokenError({ reason: "unencodable" }));
    }
  });

// ---------------------------------------------------------------------------
// Wrapped links
// ---------------------------------------------------------------------------

const isValidTokenText = (value: string): boolean =>
  Either.isRight(Effect.runSync(Effect.either(parseCashuToken(value))));

const normalizeStrictToken = (value: string): string | null => {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "") return null;
  const normalized = trimmed.replace(/^cashu/i, "cashu");
  return isValidTokenText(normalized) ? normalized : null;
};

/** `https://linky.fit/cashu/#<token>` — fragment keeps the token off servers. */
export const buildCashuShareUrl = (
  token: string,
): Effect.Effect<string, InvalidCashuTokenError> =>
  Effect.suspend(() => {
    const normalized = normalizeStrictToken(token);
    return normalized === null
      ? Effect.fail(new InvalidCashuTokenError({ reason: "unparseable" }))
      : Effect.succeed(`https://linky.fit/cashu/#${encodeURIComponent(normalized)}`);
  });

/** `cashu://<token>` deep link (PoC `buildCashuDeepLink`). */
export const buildCashuDeepLink = (
  token: string,
): Effect.Effect<string, InvalidCashuTokenError> =>
  Effect.suspend(() => {
    const normalized = normalizeStrictToken(token);
    return normalized === null
      ? Effect.fail(new InvalidCashuTokenError({ reason: "unparseable" }))
      : Effect.succeed(`cashu://${normalized}`);
  });

// ---------------------------------------------------------------------------
// Token extraction from arbitrary text (PoC app/lib/tokenText.ts)
// ---------------------------------------------------------------------------

const QUERY_KEYS = ["token", "cashu", "cashutoken", "cashu_token", "t"] as const;
const CASHU_SCHEME_PREFIX = /^(web\+)?cashu:(\/\/)?/i;
const TOKEN_REGEX = /cashu[0-9A-Za-z_-]+={0,2}/gi;

const safeDecodeUriComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const tryToken = (value: string): string | null => normalizeStrictToken(value);

/** First value for a key in a raw query string (no URLSearchParams in core). */
const queryParam = (query: string, key: string): string | null => {
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    if (safeDecodeUriComponent(k.replace(/\+/g, " ")) !== key) continue;
    const v = eq >= 0 ? pair.slice(eq + 1) : "";
    return safeDecodeUriComponent(v.replace(/\+/g, " "));
  }
  return null;
};

interface SplitUrl {
  readonly host: string;
  readonly pathSegments: ReadonlyArray<string>;
  readonly query: string;
  readonly hash: string;
}

const splitHttpUrl = (value: string): SplitUrl | null => {
  const match = /^https?:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(value);
  if (match === null) return null;
  return {
    host: match[1] ?? "",
    pathSegments: (match[2] ?? "").split("/"),
    query: match[3] ?? "",
    hash: match[4] ?? "",
  };
};

const tryInText = (value: string): string | null => {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;

  const stripped = raw
    .replace(CASHU_SCHEME_PREFIX, "")
    .replace(/^nostr:/i, "")
    .replace(/^lightning:/i, "")
    .trim();

  const direct = tryToken(stripped);
  if (direct !== null) return direct;

  for (const match of stripped.matchAll(TOKEN_REGEX)) {
    const candidate = tryToken(String(match[0] ?? ""));
    if (candidate !== null) return candidate;
  }

  const compact = stripped.replace(/\s+/g, "");
  if (compact !== "" && compact !== stripped) {
    const compactDirect = tryToken(compact);
    if (compactDirect !== null) return compactDirect;
    for (const match of compact.matchAll(TOKEN_REGEX)) {
      const candidate = tryToken(String(match[0] ?? ""));
      if (candidate !== null) return candidate;
    }
  }

  const queryIndex = stripped.indexOf("?");
  if (queryIndex >= 0 && queryIndex < stripped.length - 1) {
    const query = stripped.slice(queryIndex + 1).split("#")[0] ?? "";
    for (const key of QUERY_KEYS) {
      const queryValue = queryParam(query, key);
      if (queryValue === null || queryValue === "") continue;
      const found = tryInText(queryValue);
      if (found !== null) return found;
    }
  }

  const url = /^https?:\/\//i.test(stripped) ? splitHttpUrl(stripped) : null;
  if (url !== null) {
    for (const key of QUERY_KEYS) {
      const value = queryParam(url.query, key);
      if (value === null || value === "") continue;
      const found = tryInText(value);
      if (found !== null) return found;
    }

    if (url.hash !== "") {
      const found = tryInText(safeDecodeUriComponent(url.hash));
      if (found !== null) return found;
    }

    const host = safeDecodeUriComponent(url.host.trim());
    if (host !== "") {
      const found = tryInText(host);
      if (found !== null) return found;
    }

    for (const segment of url.pathSegments) {
      const decoded = safeDecodeUriComponent(segment.trim());
      if (decoded === "") continue;
      const found = tryInText(decoded);
      if (found !== null) return found;
    }
  }

  const tokenField = /"token"\s*:\s*"([^"]+)"/i.exec(stripped);
  if (tokenField?.[1] !== undefined) {
    const found = tryInText(safeDecodeUriComponent(tokenField[1]));
    if (found !== null) return found;
  }

  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = stripped.slice(firstBrace, lastBrace + 1).trim();
    const maybe = tryToken(candidate);
    if (maybe !== null) return maybe;
  }

  return null;
};

/**
 * Extracts a valid Cashu token from arbitrary text (scan / paste / link).
 * Returns `Option.none()` when no decodable token is present.
 */
export const extractCashuTokenFromText = (text: string): Option.Option<string> => {
  const raw = String(text ?? "").trim();
  if (raw === "") return Option.none();

  const found = tryInText(raw);
  if (found !== null) return Option.some(found);

  if (/%[0-9A-Fa-f]{2}/.test(raw)) {
    try {
      const decoded = decodeURIComponent(raw);
      const foundDecoded = tryInText(decoded);
      if (foundDecoded !== null) return Option.some(foundDecoded);
    } catch {
      // not URI-encoded after all
    }
  }

  return Option.none();
};
