/**
 * `mints.fetch-info` over a stubbed HttpClient: endpoint order, legacy
 * fallback, failure mapping (reachability), and snapshot parsing.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { fetchMintInfo } from "./fetchMintInfo.js";
import { mintsHttpStub, ok } from "./__tests__/mintsTestKit.js";

const MINT = "https://mint.example.com";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const INFO_BODY = {
  name: "Example Mint",
  icon_url: "/icon.png",
  nuts: { "15": { methods: [] } },
};

describe("fetchMintInfo", () => {
  it("fetches /v1/info first and parses the snapshot", async () => {
    const stub = mintsHttpStub([[`${MINT}/v1/info`, () => ok(INFO_BODY)]]);
    const snapshot = await run(fetchMintInfo(`${MINT}/`).pipe(Effect.provide(stub.layer)));

    expect(stub.requests.map((r) => r.url)).toEqual([`${MINT}/v1/info`]);
    expect(snapshot).toMatchObject({
      mintUrl: MINT, // canonicalized (trailing slash stripped)
      name: "Example Mint",
      iconUrl: `${MINT}/icon.png`, // resolved against the mint origin
      supportsMpp: "1",
      feesJson: null,
    });
    expect(snapshot.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(snapshot.infoJson ?? "")).toEqual(INFO_BODY);
  });

  it("falls back to the legacy /info endpoint (PoC order)", async () => {
    const stub = mintsHttpStub([
      [`${MINT}/v1/info`, () => ({ status: 404, body: { detail: "nope" } })],
      [`${MINT}/info`, () => ok({ name: "Legacy" })],
    ]);
    const snapshot = await run(fetchMintInfo(MINT).pipe(Effect.provide(stub.layer)));

    expect(stub.requests.map((r) => r.url)).toEqual([`${MINT}/v1/info`, `${MINT}/info`]);
    expect(snapshot.name).toBe("Legacy");
    expect(snapshot.supportsMpp).toBeNull();
  });

  it("fails typed when both endpoints fail — the unreachable signal", async () => {
    const stub = mintsHttpStub([
      [`${MINT}/v1/info`, () => ({ status: 502, body: {} })],
      [`${MINT}/info`, () => ({ status: -1, body: null })],
    ]);
    const result = await run(
      fetchMintInfo(MINT).pipe(Effect.provide(stub.layer), Effect.flip),
    );
    expect(result._tag).toBe("MintInfoFetchError");
  });

  it("rejects non-URLs before any network traffic", async () => {
    const stub = mintsHttpStub([]);
    const result = await run(
      fetchMintInfo("not a url").pipe(Effect.provide(stub.layer), Effect.flip),
    );
    expect(result._tag).toBe("InvalidMintUrlError");
    expect(stub.requests).toHaveLength(0);
  });
});
