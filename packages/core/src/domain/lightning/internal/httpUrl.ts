/**
 * Minimal http(s) URL handling (internal). Core's build targets pure ES2023 —
 * no DOM `URL` global — and React Native's built-in URL is incomplete, so the
 * few operations the LNURL flows need are implemented over strings:
 * validation, duplicate-slash collapsing, host/path extraction and
 * query-parameter appending.
 */

export interface ParsedHttpUrl {
  /** Lowercased scheme: "http" | "https". */
  readonly scheme: string;
  /** Host (with port), userinfo stripped. */
  readonly host: string;
  /** Path starting with "/" (or "" when absent). */
  readonly path: string;
  /** Query including "?" (or ""). */
  readonly query: string;
  /** Fragment including "#" (or ""). */
  readonly fragment: string;
}

const HTTP_URL_RE = /^(https?):\/\/([^/?#\s]+)([^?#\s]*)(\?[^#\s]*)?(#\S*)?$/i;

export const parseHttpUrl = (value: string): ParsedHttpUrl | null => {
  const match = HTTP_URL_RE.exec(value.trim());
  if (match === null) return null;
  const authority = match[2] ?? "";
  const at = authority.lastIndexOf("@");
  const host = at >= 0 ? authority.slice(at + 1) : authority;
  if (host === "") return null;
  return {
    scheme: (match[1] ?? "").toLowerCase(),
    host,
    path: match[3] ?? "",
    query: match[4] ?? "",
    fragment: match[5] ?? "",
  };
};

export const isHttpUrl = (value: string): boolean => parseHttpUrl(value) !== null;

/** Collapses consecutive empty path segments, leaving everything else alone. */
export const collapseUrlPathSlashes = (value: string): string => {
  const match = /^(https?:\/\/[^/?#\s]+)([^?#]*)([\s\S]*)$/i.exec(value);
  if (match === null) return value;
  const path = (match[2] ?? "").replace(/\/{2,}/g, "/");
  return `${match[1] ?? ""}${path}${match[3] ?? ""}`;
};

/** Appends query parameters (percent-encoded), preserving existing ones. */
export const appendQueryParams = (
  url: string,
  params: ReadonlyArray<readonly [name: string, value: string]>,
): string => {
  if (params.length === 0) return url;
  const hashIndex = url.indexOf("#");
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const fragment = hashIndex >= 0 ? url.slice(hashIndex) : "";
  const encoded = params
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
  const separator = base.includes("?")
    ? base.endsWith("?") || base.endsWith("&")
      ? ""
      : "&"
    : "?";
  return `${base}${separator}${encoded}${fragment}`;
};
