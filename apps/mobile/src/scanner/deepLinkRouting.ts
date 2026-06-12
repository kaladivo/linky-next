/**
 * Incoming deep-link normalization (#49; `scanner.links` +
 * `shell.link-fallbacks`) — pure, vitest-covered.
 *
 * `app/+native-intent.tsx` feeds every URL the OS hands the app (cold start
 * AND warm arrival — Expo Router calls `redirectSystemPath` for both)
 * through `redirectIncomingPath`. External value-carrying links (`cashu:`,
 * `nostr:`, `lightning:`, `lnurl*:`, linky.fit share links) are rewritten to
 * the `/link` landing screen, which funnels the value into #48's ONE
 * parse+route path (`routeScannedValue` with the generic `scan` entry).
 * Internal paths (own `linky-dev://` scheme, plain router paths) pass
 * through untouched; whatever the router can't match lands on
 * `app/+not-found.tsx` — never a blank screen.
 *
 * Accepted linky.fit forms (PoC `utils/deepLinks.ts` / site contract):
 * - `https://linky.fit/cashu/#<encodeURIComponent(token)>` — the canonical
 *   share link. The token travels in the URL FRAGMENT, which browsers never
 *   send to servers; the parser also accepts query-key (`?token=`) and
 *   path-embedded variants via core's `extractCashuTokenFromText`.
 * - old PoC web-app hash routes (`https://app.linky.fit/#wallet…`,
 *   `…/#contacts`) — cheap acceptance: they land on the matching tab.
 * - anything else on linky.fit hosts → `/link` with no value → the landing
 *   screen toasts "unsupported link" and settles on the tabs (fallback).
 *
 * Values may be bearer instruments (Cashu tokens) — never log them here.
 */

import { extractCashuTokenFromText } from "@linky/core";
import { Option } from "effect";

export type IncomingLinkDecision =
  /** Feed `value` into the unified scan parser via the /link screen. */
  | { readonly kind: "scan"; readonly value: string }
  /** Map straight to a known router path (old PoC web-app routes). */
  | { readonly kind: "navigate"; readonly path: string }
  /** Known-ours but value-less/unknown → /link fallback (toast + tabs). */
  | { readonly kind: "fallback" }
  /** Not ours to interpret — let Expo Router try (then +not-found). */
  | { readonly kind: "pass" };

/** Schemes whose whole URL is already a valid #48 scan value. */
const SCAN_VALUE_SCHEME = /^(?:web\+)?cashu:|^nostr:|^lightning:|^lnurlp:\/\/|^lnurlw:\/\//i;

/** Bare `lnurl:` wrapper (issue scope) — strip it, the payload is the value. */
const LNURL_WRAPPER = /^lnurl:(?:\/\/)?/i;

/** Hosts serving Linky share links (universal-link domain + variants). */
const SHARE_HOSTS = new Set(["linky.fit", "www.linky.fit"]);

/** The PoC web app's host — its old hash routes get cheap acceptance. */
const POC_APP_HOST = "app.linky.fit";

interface SplitUrl {
  readonly host: string;
  readonly path: string;
  readonly hash: string;
}

/** Minimal http(s) splitter (no WHATWG URL — keep this module RN-agnostic). */
const splitHttpUrl = (value: string): SplitUrl | null => {
  const match = /^https?:\/\/([^/?#]*)([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/i.exec(value);
  if (match === null) return null;
  return {
    host: (match[1] ?? "").toLowerCase(),
    path: match[2] ?? "",
    hash: match[3] ?? "",
  };
};

const hasCashuToken = (value: string): boolean =>
  Option.isSome(extractCashuTokenFromText(value));

const decodeURIComponentSafe = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Old PoC hash routes (`#wallet…` / `#contacts` / empty) → tab paths. */
const pocHashRoute = (hash: string): string | null => {
  const route = decodeURIComponentSafe(hash).replace(/^\/+/, "").toLowerCase();
  if (route === "" || route === "contacts") return "/(tabs)";
  if (route === "wallet" || route.startsWith("wallet/")) return "/(tabs)/wallet";
  return null;
};

/**
 * Classifies one incoming OS URL. Pure; safe to call with anything the
 * native layer produces (never throws).
 */
export const decideIncomingUrl = (rawUrl: string): IncomingLinkDecision => {
  const url = String(rawUrl ?? "").trim();
  if (url === "") return { kind: "pass" };

  // Payment/contact schemes: the raw URL is already a valid scan value —
  // core's parsers accept `cashu:`/`web+cashu:` (incl. `?token=` query
  // forms), `nostr:` URIs (incl. the PoC's `//contact/<npub>` and
  // `?npub=<npub>` forms), `lightning:`-prefixed BOLT11 / addresses /
  // bech32 LNURLs, and `lnurlp://`/`lnurlw://` endpoints.
  if (SCAN_VALUE_SCHEME.test(url)) return { kind: "scan", value: url };

  // Bare `lnurl:` wrapper: core has no such prefix-stripper, so unwrap here
  // (`lnurl:lnurl1…` → `lnurl1…`).
  if (LNURL_WRAPPER.test(url)) {
    const payload = url.replace(LNURL_WRAPPER, "").trim();
    return payload === "" ? { kind: "fallback" } : { kind: "scan", value: payload };
  }

  const http = splitHttpUrl(url);
  if (http !== null) {
    if (SHARE_HOSTS.has(http.host) || http.host === POC_APP_HOST) {
      // Share links carry the token in the fragment (or legacy query keys);
      // hand the WHOLE URL to the parser so every wrapped form works.
      if (hasCashuToken(url)) return { kind: "scan", value: url };
      if (http.host === POC_APP_HOST) {
        const route = pocHashRoute(http.hash);
        if (route !== null) return { kind: "navigate", path: route };
      }
      // Known-ours but unknown/value-less (e.g. a share link whose fragment
      // got stripped, or an outdated path) → visible fallback, never a
      // dead end.
      return { kind: "fallback" };
    }
    // http(s) on foreign hosts is not ours to interpret as a link arrival.
    return { kind: "pass" };
  }

  // Universal links can reach the router already host-stripped ("/cashu/#…").
  if (url.startsWith("/cashu")) {
    return hasCashuToken(url) ? { kind: "scan", value: url } : { kind: "fallback" };
  }

  // Own scheme (linky-dev:///dev/restore…), plain router paths, dev-client
  // URLs — pass through; unmatched ones land on +not-found.
  return { kind: "pass" };
};

/**
 * The `+native-intent` transform: incoming OS URL → router path. Total —
 * a crash here would dead-end the arrival, so unexpected inputs degrade to
 * the /link fallback instead.
 */
export const redirectIncomingPath = (rawUrl: string): string => {
  try {
    const decision = decideIncomingUrl(rawUrl);
    switch (decision.kind) {
      case "scan":
        return `/link?url=${encodeURIComponent(decision.value)}`;
      case "navigate":
        return decision.path;
      case "fallback":
        return "/link";
      case "pass":
        return rawUrl;
    }
  } catch {
    return "/link";
  }
};
