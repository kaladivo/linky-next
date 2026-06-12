/**
 * Mint URL canonicalization (`mints.add-custom`: "URL normalization
 * matters") — the PoC's `normalizeMintUrl` from `utils/mint.ts`, pinned by
 * `__fixtures__/mints.golden.json`.
 *
 * TWO normalizations exist on purpose, exactly like in the PoC:
 *
 * - `normalizeMintUrl` (ports/CounterStore.ts): trim + strip trailing
 *   slashes. Part of the deterministic-counter FUND-SAFETY contract and of
 *   token-row identity. NEVER change it.
 * - `canonicalizeMintUrl` (here): the mint-MANAGEMENT identity — lowercased
 *   scheme/host, default port dropped, query/hash dropped, dot segments
 *   resolved, trailing slashes stripped, and the minibits mint pinned to its
 *   `/Bitcoin` variant. Mint rows and the main-mint preference store this
 *   form; since its output is always a fixed point of `normalizeMintUrl`,
 *   both identities agree for canonicalized inputs.
 *
 * Core targets plain ES2023 (no WHATWG `URL` global — see
 * environment/EnvironmentConfig.ts), so the PoC's `new URL(...)` behavior is
 * re-implemented over strings and verified against the golden fixture.
 *
 * Documented divergence from the PoC (asserted in mints.golden.test.ts):
 * for parseable non-http(s) URLs the PoC leaks WHATWG internals
 * (`new URL("foo://bar/baz")` → origin `"null"` → `"null/baz"`); we return
 * the trimmed/slash-stripped input unchanged instead. For http(s) inputs —
 * the only ones a mint can actually live on — behavior is byte-identical.
 */

/** The PoC's canonical main-mint alias: any minibits host form maps here. */
const MINIBITS_CANONICAL_URL = "https://mint.minibits.cash/Bitcoin";
const MINIBITS_HOST = "mint.minibits.cash";

interface ParsedHttpishUrl {
  /** Lowercased "http" | "https". */
  readonly scheme: string;
  /** Lowercased host, userinfo stripped, default port dropped. */
  readonly host: string;
  /** Path starting with "/" (or ""), dot segments resolved, case kept. */
  readonly path: string;
}

const HTTPISH_RE = /^(https?):\/\/([^/?#\s]+)([^?#\s]*)(?:[?#]\S*)?$/i;

/** WHATWG-style dot-segment resolution over a "/"-led path (case kept). */
const resolveDotSegments = (path: string): string => {
  if (path === "") return "";
  const out: string[] = [];
  for (const segment of path.split("/").slice(1)) {
    if (segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? "" : `/${out.join("/")}`;
};

const parseHttpishUrl = (value: string): ParsedHttpishUrl | null => {
  const match = HTTPISH_RE.exec(value);
  if (match === null) return null;
  const scheme = (match[1] ?? "").toLowerCase();
  const authority = match[2] ?? "";
  const at = authority.lastIndexOf("@");
  let host = (at >= 0 ? authority.slice(at + 1) : authority).toLowerCase();
  if (host === "") return null;
  const defaultPort = scheme === "https" ? ":443" : ":80";
  if (host.endsWith(defaultPort)) host = host.slice(0, -defaultPort.length);
  return { scheme, host, path: resolveDotSegments(match[3] ?? "") };
};

/** Host (with non-default port) of an http(s) URL, or null. */
export const mintUrlHost = (value: string): string | null =>
  parseHttpishUrl(String(value ?? "").trim())?.host ?? null;

/**
 * The mint-management canonical form of a mint URL (PoC `normalizeMintUrl`):
 * `""` for blank input, the canonical http(s) form for parseable URLs, the
 * trimmed/trailing-slash-stripped input otherwise.
 */
export const canonicalizeMintUrl = (value: string): string => {
  const raw = String(value ?? "").trim();
  if (raw === "") return "";
  const stripped = raw.replace(/\/+$/, "");

  const parsed = parseHttpishUrl(stripped);
  if (parsed === null) return stripped;

  // Canonicalize the minibits mint: always the /Bitcoin variant (PoC rule).
  if (parsed.host === MINIBITS_HOST) return MINIBITS_CANONICAL_URL;

  const path = parsed.path.replace(/\/+$/, "");
  return `${parsed.scheme}://${parsed.host}${path}`.replace(/\/+$/, "");
};

/**
 * Origin and host for icon/display purposes (PoC `getMintOriginAndHost`):
 * tolerates scheme-less input by retrying with `https://` prepended; a
 * scheme'd but non-http(s) input yields the PoC's `{ "null", "" }` shape.
 */
export const mintOriginAndHost = (
  value: string,
): { readonly origin: string | null; readonly host: string | null } => {
  const raw = String(value ?? "").trim();
  if (raw === "") return { origin: null, host: null };

  const direct = parseHttpishUrl(raw);
  if (direct !== null) {
    return { origin: `${direct.scheme}://${direct.host}`, host: direct.host };
  }

  // A non-http(s) scheme still parses as a URL in the PoC — WHATWG reports
  // origin "null" and (without an authority) an empty host. Pinned verbatim.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) {
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]*)/i.exec(raw)?.[1] ?? "";
    return { origin: "null", host: authority.toLowerCase() };
  }

  const candidate = parseHttpishUrl(`https://${raw}`);
  if (candidate !== null) {
    return { origin: `https://${candidate.host}`, host: candidate.host };
  }
  return { origin: null, host: raw };
};

/**
 * Short display name for a mint (PoC `getMintSelectionDisplayName`): the
 * host of the canonical URL, falling back to the protocol-stripped text.
 */
export const mintDisplayName = (value: string): string => {
  const cleaned = canonicalizeMintUrl(value);
  if (cleaned === "") return "";
  const parsed = parseHttpishUrl(cleaned);
  if (parsed !== null && parsed.host !== "") return parsed.host;
  return cleaned.replace(/^https?:\/\//i, "");
};

/** True when the canonicalized value parses as an http(s) URL — the
 * `mints.select-main` / `mints.add-custom` validity gate. */
export const isValidMintUrl = (value: string): boolean =>
  parseHttpishUrl(canonicalizeMintUrl(value)) !== null;
