/**
 * `mints.fetch-info` — fetch and parse a mint's NUT-06 info, PoC semantics
 * (useMintInfoStore.fetchMintInfoPayload): try `/v1/info` first, fall back
 * to the legacy `/info`, 8s budget per attempt, and record latency from the
 * start of the first attempt. Parsing (fees/icon/MPP/1000-char caps) is the
 * golden-pinned `parseMintInfoPayload`.
 *
 * Reachability is the OUTCOME of this workflow: success = reachable (with
 * `latencyMs`), `MintInfoFetchError` = unreachable. The app keeps that
 * runtime status in memory (like the PoC) and persists only the parsed info
 * snapshot via `MintsRepository.recordInfo`.
 */
import { Clock, Effect } from "effect";

import { HttpClient } from "../../ports/Http.js";
import { InvalidMintUrlError, MintInfoFetchError } from "./errors.js";
import { mintInfoIconUrl, mintNameFromInfo, parseMintInfoPayload } from "./mintInfo.js";
import { canonicalizeMintUrl, isValidMintUrl } from "./mintUrl.js";

/** PoC `MINT_INFO_FETCH_TIMEOUT` equivalent: 8s abort per endpoint try. */
export const MINT_INFO_TIMEOUT_MS = 8000;

export interface MintInfoSnapshot {
  /** Canonical mint URL the info belongs to. */
  readonly mintUrl: string;
  readonly name: string | null;
  readonly iconUrl: string | null;
  readonly infoJson: string | null;
  readonly feesJson: string | null;
  /** "1" when NUT-15 (MPP) is advertised, else null. */
  readonly supportsMpp: string | null;
  /** Round-trip of the successful fetch, in ms. */
  readonly latencyMs: number;
}

const fetchJson = (
  url: string,
): Effect.Effect<unknown, MintInfoFetchError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.get(url).pipe(
      Effect.scoped,
      Effect.mapError(
        (error) => new MintInfoFetchError({ mintUrl: url, reason: String(error.reason) }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new MintInfoFetchError({ mintUrl: url, reason: `HTTP ${String(response.status)}` }),
      );
    }
    return yield* response.json.pipe(
      Effect.mapError(
        () => new MintInfoFetchError({ mintUrl: url, reason: "unparseable JSON body" }),
      ),
    );
  }).pipe(
    Effect.timeoutFail({
      duration: MINT_INFO_TIMEOUT_MS,
      onTimeout: () => new MintInfoFetchError({ mintUrl: url, reason: "timeout" }),
    }),
  );

export const fetchMintInfo = (
  mintUrl: string,
): Effect.Effect<
  MintInfoSnapshot,
  MintInfoFetchError | InvalidMintUrlError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const canonical = canonicalizeMintUrl(mintUrl);
    if (canonical === "" || !isValidMintUrl(canonical)) {
      return yield* Effect.fail(new InvalidMintUrlError({ url: mintUrl }));
    }

    const startedAt = yield* Clock.currentTimeMillis;
    // PoC order: NUT-06 path first, legacy `/info` as the fallback.
    const info = yield* fetchJson(`${canonical}/v1/info`).pipe(
      Effect.orElse(() => fetchJson(`${canonical}/info`)),
      Effect.mapError(
        (error) => new MintInfoFetchError({ mintUrl: canonical, reason: error.reason }),
      ),
    );
    const finishedAt = yield* Clock.currentTimeMillis;

    const parsed = parseMintInfoPayload(info);
    return {
      mintUrl: canonical,
      name: mintNameFromInfo(info),
      iconUrl: mintInfoIconUrl(canonical, parsed.infoJson),
      infoJson: parsed.infoJson,
      feesJson: parsed.feesJson,
      supportsMpp: parsed.supportsMpp,
      latencyMs: Math.max(0, Math.round(finishedAt - startedAt)),
    };
  });
