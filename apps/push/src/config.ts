/**
 * Service configuration — read once from the environment at startup and
 * provided to everything else through the `PushConfig` tag.
 *
 * Every value has a safe default except nothing: the service boots with no
 * env at all (sqlite file under ./data, public relay defaults from the
 * rewrite spec, localhost public URL). Production deployments override
 * `PUSH_PUBLIC_URL` (proof `u`-tag check), `PUSH_DB_PATH` and the relay set.
 */
import { Context, Data, Layer } from "effect";

/** Same default relay set as the rewrite spec / mobile app. */
const DEFAULT_RELAY_URLS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.0xchat.com",
] as const;

export interface PushConfigData {
  /** HTTP listen port. */
  readonly port: number;
  /**
   * Public base URL clients used when signing their NIP-98 proofs (the `u`
   * tag must equal `${publicBaseUrl}${path}`). Defaults to
   * `http://localhost:${port}` for local development.
   */
  readonly publicBaseUrl: string;
  /** sqlite database file; `:memory:` for ephemeral (tests/dev). */
  readonly dbPath: string;
  /** Relays watched for kind-1059 traffic. */
  readonly relayUrls: ReadonlyArray<string>;
  /** Max age (seconds, both directions) of a registration proof event. */
  readonly proofMaxAgeSec: number;
  /** Abuse limit: max identities (pubkeys) one install may register. */
  readonly maxIdentitiesPerInstall: number;
  /** Abuse limit: max installs one identity may be registered on. */
  readonly maxInstallsPerIdentity: number;
  /** Abuse limit: registration attempts per IP per window. */
  readonly registerRateLimitMax: number;
  readonly registerRateLimitWindowMs: number;
  /** Abuse limit: registration attempts per pubkey per window. */
  readonly perPubkeyRateLimitMax: number;
  readonly perPubkeyRateLimitWindowMs: number;
  /**
   * REQ lookback (`since = now - lookback`). Must exceed the NIP-59
   * timestamp jitter (2 days) or live wraps with back-dated `created_at`
   * would be invisible; 3 days matches the PoC.
   */
  readonly catchUpLookbackSec: number;
  /** How long processed event ids are remembered for dedupe. */
  readonly seenEventRetentionMs: number;
  /** Expo push HTTP API endpoint. */
  readonly expoPushUrl: string;
  /** Optional Expo access token (enhanced push security). */
  readonly expoAccessToken: string | null;
}

export class PushConfig extends Context.Tag("@linky/push/PushConfig")<
  PushConfig,
  PushConfigData
>() {}

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly key: string;
  readonly message: string;
}> {}

type Env = Record<string, string | undefined>;

const readInt = (env: Env, key: string, fallback: number): number => {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError({ key, message: "must be a positive integer" });
  }
  return value;
};

const readString = (env: Env, key: string, fallback: string): string => {
  const raw = env[key]?.trim();
  return raw === undefined || raw === "" ? fallback : raw;
};

const readRelayUrls = (env: Env): ReadonlyArray<string> => {
  const raw = env["PUSH_RELAYS"]?.trim();
  const source = raw === undefined || raw === "" ? DEFAULT_RELAY_URLS.join(",") : raw;
  const urls: Array<string> = [];
  for (const part of source.split(",")) {
    const candidate = part.trim();
    if (candidate === "") continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new ConfigError({ key: "PUSH_RELAYS", message: `invalid URL: ${candidate}` });
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new ConfigError({ key: "PUSH_RELAYS", message: `not a ws(s) URL: ${candidate}` });
    }
    if (!urls.includes(parsed.toString())) urls.push(parsed.toString());
  }
  if (urls.length === 0) {
    throw new ConfigError({ key: "PUSH_RELAYS", message: "must list at least one relay" });
  }
  return urls;
};

/** Throws `ConfigError` on malformed values; defaults cover absent ones. */
export const loadConfig = (env: Env): PushConfigData => {
  const port = readInt(env, "PUSH_PORT", 8787);
  return {
    port,
    publicBaseUrl: readString(env, "PUSH_PUBLIC_URL", `http://localhost:${port}`).replace(
      /\/+$/,
      "",
    ),
    dbPath: readString(env, "PUSH_DB_PATH", "./data/linky-push.sqlite"),
    relayUrls: readRelayUrls(env),
    proofMaxAgeSec: readInt(env, "PUSH_PROOF_MAX_AGE_SEC", 60),
    maxIdentitiesPerInstall: readInt(env, "PUSH_MAX_IDENTITIES_PER_INSTALL", 8),
    maxInstallsPerIdentity: readInt(env, "PUSH_MAX_INSTALLS_PER_IDENTITY", 10),
    registerRateLimitMax: readInt(env, "PUSH_RATE_LIMIT_IP_MAX", 30),
    registerRateLimitWindowMs: readInt(env, "PUSH_RATE_LIMIT_IP_WINDOW_MS", 60_000),
    perPubkeyRateLimitMax: readInt(env, "PUSH_RATE_LIMIT_PUBKEY_MAX", 60),
    perPubkeyRateLimitWindowMs: readInt(env, "PUSH_RATE_LIMIT_PUBKEY_WINDOW_MS", 3_600_000),
    catchUpLookbackSec: readInt(env, "PUSH_CATCH_UP_LOOKBACK_SEC", 3 * 24 * 60 * 60),
    seenEventRetentionMs: readInt(env, "PUSH_SEEN_EVENT_RETENTION_MS", 7 * 24 * 60 * 60 * 1000),
    expoPushUrl: readString(env, "PUSH_EXPO_URL", "https://exp.host/--/api/v2/push/send"),
    expoAccessToken: env["PUSH_EXPO_ACCESS_TOKEN"]?.trim() || null,
  };
};

export const layerConfig = (config: PushConfigData): Layer.Layer<PushConfig> =>
  Layer.succeed(PushConfig, config);

/** Test-friendly config: in-memory db, tight limits overridable per test. */
export const testConfig = (overrides: Partial<PushConfigData> = {}): PushConfigData => ({
  ...loadConfig({}),
  dbPath: ":memory:",
  publicBaseUrl: "http://push.test",
  relayUrls: ["wss://fake.relay.one", "wss://fake.relay.two"],
  ...overrides,
});
