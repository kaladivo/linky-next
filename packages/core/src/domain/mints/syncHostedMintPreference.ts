/**
 * `mints.sync-hosted` — push the chosen main mint to the hosted
 * npub.cash-compatible Lightning-address service, exactly like the PoC's
 * `updateNpubCashMint`: `PUT {base}/api/v1/info/mint` with body
 * `{"mintUrl": <canonical>}` and a NIP-98 Authorization header. The request
 * shape (URL, body bytes, event tags/serialization) is pinned by the golden
 * fixture.
 *
 * FAIL-SAFE CONTRACT (feature map): this workflow only talks to the
 * service. It never persists anything; callers persist the local main-mint
 * preference ONLY after this effect succeeds, so a failed sync can never
 * leave the local choice and the hosted choice disagreeing in the dangerous
 * direction (hosted pointing at a mint the wallet no longer prefers).
 *
 * Server selection follows the PoC: the user's effective Lightning-address
 * domain picks the hosted base URL (npub.linky.fit for linky.fit addresses,
 * npub.cash otherwise). The PoC's `resolveMintSyncServerBaseUrl` extra —
 * preferring the claim server once an address was CLAIMED there — collapses
 * to the same value here because both bases resolve from the same domain
 * mapping; the claim flow itself is out of scope for the rewrite's #41.
 */
import { Clock, Effect } from "effect";

import { HttpClient, HttpClientRequest } from "../../ports/Http.js";
import type { Randomness } from "../../ports/Randomness.js";
import type { RandomnessError } from "../../ports/Randomness.js";
import { HostedMintSyncError, InvalidMintUrlError } from "./errors.js";
import { buildNip98Token } from "./nip98.js";
import { canonicalizeMintUrl, isValidMintUrl } from "./mintUrl.js";
import { NPUB_CASH_MINT_ENDPOINT_PATH, resolveNpubCashServerBaseUrl } from "./npubCashServer.js";

export interface SyncHostedMintPreferenceArgs {
  /** The mint the user picked; canonicalized before sending. */
  readonly mintUrl: string;
  /** The user's effective Lightning address — selects the hosted server. */
  readonly lightningAddress: string | null;
  /** 32-byte secret key of the ACTIVE Nostr identity (NIP-98 author). */
  readonly nostrSecretKey: Uint8Array;
}

export interface SyncHostedMintPreferenceResult {
  /** Hosted server that acknowledged the update. */
  readonly baseUrl: string;
  /** The canonical mint URL the server now routes to — what callers persist. */
  readonly mintUrl: string;
}

export const syncHostedMintPreference = (
  args: SyncHostedMintPreferenceArgs,
): Effect.Effect<
  SyncHostedMintPreferenceResult,
  HostedMintSyncError | InvalidMintUrlError | RandomnessError,
  HttpClient.HttpClient | Randomness
> =>
  Effect.gen(function* () {
    const cleaned = canonicalizeMintUrl(args.mintUrl);
    if (cleaned === "" || !isValidMintUrl(cleaned)) {
      return yield* Effect.fail(new InvalidMintUrlError({ url: args.mintUrl }));
    }

    const baseUrl = resolveNpubCashServerBaseUrl(args.lightningAddress);
    const url = `${baseUrl}${NPUB_CASH_MINT_ENDPOINT_PATH}`;
    const payload = { mintUrl: cleaned };
    const body = JSON.stringify(payload); // exact bytes the PoC sends

    const nowMs = yield* Clock.currentTimeMillis;
    const authorization = yield* buildNip98Token({
      url,
      method: "PUT",
      payload,
      secretKey: args.nostrSecretKey,
      nowSec: Math.round(nowMs / 1000),
    });

    const http = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.put(url).pipe(
      HttpClientRequest.setHeaders({
        Authorization: authorization,
        "Content-Type": "application/json",
      }),
      HttpClientRequest.bodyText(body, "application/json"),
    );

    const response = yield* http.execute(request).pipe(
      Effect.scoped,
      // Transport failure → typed error; nothing was acknowledged.
      Effect.mapError(
        (error) =>
          new HostedMintSyncError({ url, reason: String(error.reason), status: null }),
      ),
    );

    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new HostedMintSyncError({
          url,
          reason: `HTTP ${String(response.status)}`,
          status: response.status,
        }),
      );
    }

    return { baseUrl, mintUrl: cleaned };
  });
