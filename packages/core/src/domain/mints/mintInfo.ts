/**
 * Mint info (NUT-06) parsing — `mints.fetch-info`. Ports of the PoC's
 * `parseMintInfoPayload` / `extractPpk` / `getMintInfoIconUrl`
 * (mintInfoHelpers.ts, utils/mint.ts), pinned by
 * `__fixtures__/mints.golden.json`:
 *
 * - fee hints: a `ppk` number found up to 3 levels deep in `fees`/`fee` (or
 *   the whole payload) wins as `{ ppk, raw }`, otherwise the raw fee value;
 * - stored JSON is capped at 1000 chars (PoC storage cap — kept for parity,
 *   so a restored PoC-sized cache renders identically);
 * - the icon URL is the first non-empty string under a known icon key,
 *   resolved against the mint URL exactly like `new URL(raw, base)`.
 */
import { canonicalizeMintUrl } from "./mintUrl.js";

const isSearchBranch = (value: unknown): value is Record<string, unknown> | unknown[] =>
  typeof value === "object" && value !== null;

const entriesOf = (value: Record<string, unknown> | unknown[]): Array<[string, unknown]> =>
  Array.isArray(value)
    ? value.map((inner, index) => [String(index), inner] as [string, unknown])
    : Object.entries(value);

/**
 * Breadth-first `ppk` search, max depth 3, cycle-safe (PoC `extractPpk`).
 * Returns the first finite number under a key spelled `ppk` (any case).
 */
export const extractPpk = (value: unknown): number | null => {
  const seen = new Set<Record<string, unknown> | unknown[]>();
  const queue: Array<{ depth: number; value: unknown }> = [{ value, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    const { depth, value: current } = item;
    if (!isSearchBranch(current)) continue;
    if (seen.has(current)) continue;
    seen.add(current);

    for (const [key, inner] of entriesOf(current)) {
      if (key.toLowerCase() === "ppk") {
        if (typeof inner === "number" && Number.isFinite(inner)) return inner;
        const num = Number(String(inner ?? "").trim());
        if (Number.isFinite(num)) return num;
      }
      if (depth < 3 && isSearchBranch(inner)) {
        queue.push({ value: inner, depth: depth + 1 });
      }
    }
  }
  return null;
};

/** PoC `toJson`: serialized, empty-ish collapsed to null, capped at 1000. */
const toCappedJson = (value: unknown): string | null => {
  try {
    const text = JSON.stringify(value);
    const trimmed = String(text ?? "").trim();
    if (trimmed === "" || trimmed === "null" || trimmed === "{}" || trimmed === "[]") return null;
    return trimmed.slice(0, 1000);
  } catch {
    return null;
  }
};

export interface ParsedMintInfo {
  readonly feesJson: string | null;
  readonly infoJson: string | null;
  /** "1" when NUT-15 (MPP) is advertised, else null (PoC convention). */
  readonly supportsMpp: string | null;
}

/** PoC `parseMintInfoPayload` over a decoded `/v1/info` body. */
export const parseMintInfoPayload = (info: unknown): ParsedMintInfo => {
  // PoC reads properties off the payload unguarded; tolerate primitives.
  const record = isSearchBranch(info) && !Array.isArray(info) ? (info as Record<string, unknown>) : {};
  const nuts = record["nuts"] ?? record["NUTS"] ?? null;
  const nut15 = (() => {
    if (!isSearchBranch(nuts) || Array.isArray(nuts)) return null;
    const rec = nuts as Record<string, unknown>;
    return rec["15"] ?? rec["nut15"] ?? rec["NUT15"] ?? null;
  })();

  const feesRaw = record["fees"] ?? record["fee"] ?? null;
  const ppk = extractPpk(feesRaw) ?? extractPpk(info);
  const fees = ppk !== null ? { ppk, raw: feesRaw } : feesRaw;

  return {
    supportsMpp: nut15 ? "1" : null,
    feesJson: toCappedJson(fees),
    infoJson: toCappedJson(info),
  };
};

/** Display name from a NUT-06 payload (rewrite extension: the PoC shows the
 * host only; we also cache `name` on the mint row for offline rendering). */
export const mintNameFromInfo = (info: unknown): string | null => {
  if (!isSearchBranch(info) || Array.isArray(info)) return null;
  const name = (info as Record<string, unknown>)["name"];
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed === "" ? null : trimmed;
};

const MINT_INFO_ICON_KEYS = [
  "icon_url",
  "iconUrl",
  "icon",
  "logo",
  "image",
  "image_url",
  "imageUrl",
] as const;

const findIconValue = (
  value: unknown,
  seen: Set<Record<string, unknown> | unknown[]>,
): string | null => {
  if (!isSearchBranch(value)) return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (!Array.isArray(value)) {
    for (const key of MINT_INFO_ICON_KEYS) {
      const raw = value[key];
      if (typeof raw !== "string") continue;
      const trimmed = raw.trim();
      if (trimmed !== "") return trimmed;
    }
  }

  for (const inner of Object.values(value)) {
    const found = findIconValue(inner, seen);
    if (found !== null) return found;
  }
  return null;
};

const BASE_RE = /^(https?):\/\/([^/?#\s]+)([^?#\s]*)$/i;

/** `new URL(raw, base).toString()` for the cases mint icons hit, sans the
 * WHATWG global (core targets plain ES2023). Base must be canonical. */
const resolveAgainstMint = (raw: string, canonicalBase: string): string | null => {
  const base = BASE_RE.exec(canonicalBase);
  if (base === null) return null; // invalid base: `new URL` throws regardless
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw; // absolute (incl. data:)
  const scheme = (base[1] ?? "").toLowerCase();
  if (raw.startsWith("//")) return `${scheme}:${raw}`; // protocol-relative
  const origin = `${scheme}://${base[2] ?? ""}`;
  if (raw.startsWith("/")) return `${origin}${raw}`;
  // Relative: replace everything after the last "/" of the base path.
  const basePath = base[3] ?? "";
  const dir = basePath.slice(0, basePath.lastIndexOf("/") + 1) || "/";
  return `${origin}${dir}${raw}`;
};

/** PoC `getMintInfoIconUrl`: icon URL out of cached info JSON, or null. */
export const mintInfoIconUrl = (mintUrl: string, infoJson: string | null): string | null => {
  const infoText = String(infoJson ?? "").trim();
  if (infoText === "") return null;

  const canonical = canonicalizeMintUrl(mintUrl);
  if (canonical === "") return null;

  let info: unknown;
  try {
    info = JSON.parse(infoText);
  } catch {
    return null;
  }

  const rawIcon = findIconValue(info, new Set());
  if (rawIcon === null) return null;
  return resolveAgainstMint(rawIcon, canonical);
};
