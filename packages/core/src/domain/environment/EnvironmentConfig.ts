/**
 * Environment profiles (rewrite-spec.md "Environments").
 *
 * Three build-time profiles — development / staging / production — each with
 * its own validated endpoint configuration. Endpoints are NEVER literals in
 * feature code; they enter through an `EnvironmentConfig` decoded here.
 *
 * Structural mainnet guard
 * ------------------------
 * `EnvironmentConfig` is a discriminated union on `network: "test" | "main"`,
 * derived from the profile (only `production` is `"main"`). The guard works
 * on two levels:
 *
 * 1. Schema level — decoding refuses mainnet endpoints for non-production
 *    profiles: the test branch only accepts Cashu mint URLs from a known
 *    test-mint allowlist (plus localhost), and refuses the production-only
 *    Evolu sync host. A `{ profile: "development", cashuMintUrl:
 *    "https://cashu.cz" }` config cannot be constructed through the schema.
 * 2. Type level — code that moves real funds can require the narrowed
 *    `MainEnvironmentConfig` (`network: "main"`); a test-profile config is
 *    not assignable to it, so a non-production build cannot even type-check
 *    its way into a mainnet code path.
 */
import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Profile and network discriminant
// ---------------------------------------------------------------------------

/** Build-time profile, selected via APP_ENV in the app's config. */
export const AppProfile = Schema.Literal("development", "staging", "production");
export type AppProfile = typeof AppProfile.Type;

/** Decode an unknown value (e.g. expo `extra.appEnv`) into an AppProfile. */
export const decodeAppProfile = Schema.decodeUnknownSync(AppProfile);

/** Funds network discriminant. Only production builds run on "main". */
export type Network = "test" | "main";

export const networkForProfile = (profile: AppProfile): Network =>
  profile === "production" ? "main" : "test";

// ---------------------------------------------------------------------------
// URL primitives
// ---------------------------------------------------------------------------

// Minimal URL handling without the WHATWG `URL` global: core targets plain
// ES2023 (no DOM or Node type libs), and React Native's URL polyfill is
// unreliable anyway. `scheme://host[:port][/path...]` covers every endpoint
// this config ever holds.
const URL_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#]|$)/i;

const hostOf = (url: string): string | undefined => URL_PATTERN.exec(url)?.[2]?.toLowerCase();

const urlWithProtocol = (scheme: string) => (url: string) =>
  URL_PATTERN.exec(url)?.[1]?.toLowerCase() === scheme;

const HttpsUrl = Schema.String.pipe(
  Schema.filter(urlWithProtocol("https"), {
    identifier: "HttpsUrl",
    description: "an https:// URL",
  }),
);

const WssUrl = Schema.String.pipe(
  Schema.filter(urlWithProtocol("wss"), {
    identifier: "WssUrl",
    description: "a wss:// URL",
  }),
);

// ---------------------------------------------------------------------------
// Mainnet guard predicates
// ---------------------------------------------------------------------------

/** Hosts recognized as test mints (fake funds). Extend deliberately. */
export const TEST_MINT_HOSTS: ReadonlyArray<string> = [
  "testnut.cashu.space",
  "nofees.testnut.cashu.space",
  "localhost",
  "127.0.0.1",
];

/** True when the mint URL points at a known test mint (or a local one). */
export const isTestMintUrl = (url: string): boolean => {
  const host = hostOf(url);
  return host !== undefined && TEST_MINT_HOSTS.includes(host);
};

/** Sync hosts that must only ever be reached by production builds. */
export const PRODUCTION_ONLY_SYNC_HOSTS: ReadonlyArray<string> = ["evolu.linky.fit"];

const isProductionOnlySyncUrl = (url: string): boolean => {
  const host = hostOf(url);
  return host !== undefined && PRODUCTION_ONLY_SYNC_HOSTS.includes(host);
};

const TestMintUrl = HttpsUrl.pipe(
  Schema.filter((url) => isTestMintUrl(url), {
    identifier: "TestMintUrl",
    description: "a known test-mint URL (non-production profiles must not touch mainnet mints)",
  }),
);

const TestSyncUrl = WssUrl.pipe(
  Schema.filter((url) => !isProductionOnlySyncUrl(url), {
    identifier: "TestSyncUrl",
    description: "a sync URL that is not reserved for production builds",
  }),
);

// ---------------------------------------------------------------------------
// EnvironmentConfig — discriminated union on `network`
// ---------------------------------------------------------------------------

const sharedFields = {
  nostrRelayUrls: Schema.NonEmptyArray(WssUrl),
} as const;

/** Non-production config: test funds only, enforced by the schema itself.
 * Preset mints (`mints.presets`) are part of the guard: a dev/staging build
 * cannot even OFFER a mainnet mint in its preset list. */
export const TestEnvironmentConfig = Schema.Struct({
  profile: Schema.Literal("development", "staging"),
  network: Schema.Literal("test"),
  cashuMintUrl: TestMintUrl,
  presetMintUrls: Schema.NonEmptyArray(TestMintUrl),
  evoluSyncUrls: Schema.NonEmptyArray(TestSyncUrl),
  ...sharedFields,
});
export type TestEnvironmentConfig = typeof TestEnvironmentConfig.Type;

/** Production config: mainnet defaults. Only `profile: "production"` decodes here. */
export const MainEnvironmentConfig = Schema.Struct({
  profile: Schema.Literal("production"),
  network: Schema.Literal("main"),
  cashuMintUrl: HttpsUrl,
  presetMintUrls: Schema.NonEmptyArray(HttpsUrl),
  evoluSyncUrls: Schema.NonEmptyArray(WssUrl),
  ...sharedFields,
});
export type MainEnvironmentConfig = typeof MainEnvironmentConfig.Type;

export const EnvironmentConfig = Schema.Union(TestEnvironmentConfig, MainEnvironmentConfig);
export type EnvironmentConfig = typeof EnvironmentConfig.Type;

export const decodeEnvironmentConfig = Schema.decodeUnknownSync(EnvironmentConfig);

// ---------------------------------------------------------------------------
// Defaults (rewrite-spec.md "Default Endpoints")
// ---------------------------------------------------------------------------

const DEFAULT_NOSTR_RELAY_URLS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.0xchat.com",
] as const;

/**
 * Default preset mints (`mints.presets`). Production mirrors the PoC's
 * PRESET_MINTS verbatim (incl. the test mint — the UI separates it);
 * non-production profiles only offer known test mints, because the
 * structural mainnet guard above refuses anything else for them.
 */
const PRODUCTION_PRESET_MINT_URLS = [
  "https://cashu.cz",
  "https://testnut.cashu.space",
  "https://mint.minibits.cash/Bitcoin",
  "https://kashu.me",
  "https://cashu.21m.lol",
] as const;

const TEST_PRESET_MINT_URLS = [
  "https://testnut.cashu.space",
  "https://nofees.testnut.cashu.space",
] as const;

/**
 * The default, spec-mandated configuration for a profile. Runs through the
 * schema, so a defaults/spec mismatch fails loudly instead of shipping.
 */
export const environmentForProfile = (profile: AppProfile): EnvironmentConfig =>
  decodeEnvironmentConfig({
    profile,
    network: networkForProfile(profile),
    cashuMintUrl: profile === "production" ? "https://cashu.cz" : "https://testnut.cashu.space",
    presetMintUrls:
      profile === "production" ? PRODUCTION_PRESET_MINT_URLS : TEST_PRESET_MINT_URLS,
    nostrRelayUrls: DEFAULT_NOSTR_RELAY_URLS,
    evoluSyncUrls:
      profile === "production"
        ? ["wss://evolu.linky.fit", "wss://free.evoluhq.com"]
        : ["wss://free.evoluhq.com"],
  });
