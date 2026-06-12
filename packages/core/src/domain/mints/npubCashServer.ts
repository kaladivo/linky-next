/**
 * Hosted npub.cash-compatible server resolution (`mints.sync-hosted`) — the
 * PoC's `utils/npubCashServer.ts`, pinned by the golden fixture.
 *
 * The base URL is a function of the USER's Lightning-address domain (which
 * hosted service serves their address), not of the build environment — a
 * `linky.fit` address is served by `npub.linky.fit` in every profile. That
 * is why this mapping lives here as protocol data instead of in
 * `EnvironmentConfig` (whose endpoints describe the build target).
 */

export const DEFAULT_NPUB_CASH_SERVER_BASE_URL = "https://npub.cash";

const HOSTED_NPUB_CASH_SERVER_BASE_URLS: Readonly<Record<string, string>> = {
  "linky.fit": "https://npub.linky.fit",
  "npub.cash": DEFAULT_NPUB_CASH_SERVER_BASE_URL,
};

/** The PUT endpoint updating the hosted main-mint preference (PoC shape). */
export const NPUB_CASH_MINT_ENDPOINT_PATH = "/api/v1/info/mint";

const lightningAddressDomain = (lightningAddress: string | null | undefined): string | null => {
  const normalized = String(lightningAddress ?? "").trim();
  if (normalized === "") return null;
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0 || atIndex >= normalized.length - 1) return null;
  const domain = normalized
    .slice(atIndex + 1)
    .trim()
    .toLowerCase();
  return domain === "" ? null : domain;
};

/** Hosted server base URL for the user's Lightning address (PoC parity). */
export const resolveNpubCashServerBaseUrl = (
  lightningAddress: string | null | undefined,
): string => {
  const domain = lightningAddressDomain(lightningAddress);
  if (domain === null) return DEFAULT_NPUB_CASH_SERVER_BASE_URL;
  return HOSTED_NPUB_CASH_SERVER_BASE_URLS[domain] ?? DEFAULT_NPUB_CASH_SERVER_BASE_URL;
};
