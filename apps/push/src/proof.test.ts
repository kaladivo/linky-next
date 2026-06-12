import { Effect, Encoding, ManagedRuntime } from "effect";
import { signNostrEvent } from "@linky/core";
import { afterAll, describe, expect, it } from "vitest";

import type { ProofRejectionReason } from "./proof.js";
import { verifyRegistrationProof } from "./proof.js";
import { layerSqliteStorage } from "./storage.js";
import { alice, bob, proofHeader, RandomnessCounter } from "./testKit.js";

const URL_REGISTER = "http://push.test/registrations";

describe("verifyRegistrationProof", () => {
  const runtime = ManagedRuntime.make(layerSqliteStorage(":memory:"));
  afterAll(() => runtime.dispose());

  const body = {
    recipientPubkey: alice.publicKeyHex,
    installationId: "install-1",
    expoPushToken: "ExponentPushToken[aaaa]",
  };
  const rawBody = JSON.stringify(body);
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  const verify = (args: {
    authorization: string | undefined;
    rawBody?: string;
    expectedUrl?: string;
    expectedMethod?: string;
    expectedPubkey?: string;
    nowMs?: number;
  }) =>
    runtime.runPromise(
      Effect.either(
        verifyRegistrationProof({
          authorization: args.authorization,
          expectedUrl: args.expectedUrl ?? URL_REGISTER,
          expectedMethod: args.expectedMethod ?? "POST",
          rawBody: args.rawBody ?? rawBody,
          expectedPubkey: args.expectedPubkey ?? alice.publicKeyHex,
          nowMs: args.nowMs ?? nowMs,
          proofMaxAgeSec: 60,
        }),
      ),
    );

  const expectRejection = async (
    promise: ReturnType<typeof verify>,
    reason: ProofRejectionReason,
  ) => {
    const result = await promise;
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left.reason).toBe(reason);
  };

  const header = (overrides: Partial<Parameters<typeof proofHeader>[0]> = {}) =>
    proofHeader({
      identity: alice,
      url: URL_REGISTER,
      method: "POST",
      body,
      nowSec,
      ...overrides,
    });

  it("accepts a valid proof", async () => {
    const result = await verify({ authorization: header() });
    expect(result._tag).toBe("Right");
  });

  it("rejects a replayed proof (same signed event twice)", async () => {
    const authorization = header({ nowSec: nowSec - 1 });
    const first = await verify({ authorization });
    expect(first._tag).toBe("Right");
    await expectRejection(verify({ authorization }), "replayed");
  });

  it("rejects an expired proof", async () => {
    await expectRejection(verify({ authorization: header({ nowSec: nowSec - 61 }) }), "expired");
  });

  it("rejects a far-future proof", async () => {
    await expectRejection(verify({ authorization: header({ nowSec: nowSec + 120 }) }), "expired");
  });

  it("rejects a proof signed for another action (URL)", async () => {
    await expectRejection(
      verify({ authorization: header({ url: "http://push.test/other" }) }),
      "wrong-url",
    );
  });

  it("rejects a proof signed for another method (register proof on unregister)", async () => {
    await expectRejection(
      verify({ authorization: header(), expectedMethod: "DELETE" }),
      "wrong-method",
    );
  });

  it("rejects when the body was tampered with after signing", async () => {
    const tampered = JSON.stringify({ ...body, expoPushToken: "ExponentPushToken[evil]" });
    await expectRejection(verify({ authorization: header(), rawBody: tampered }), "wrong-payload");
  });

  it("rejects a proof signed by a different identity than claimed", async () => {
    await expectRejection(verify({ authorization: header({ identity: bob }) }), "pubkey-mismatch");
  });

  it("rejects a missing or non-Nostr Authorization header", async () => {
    await expectRejection(verify({ authorization: undefined }), "missing-header");
    await expectRejection(verify({ authorization: "Bearer xyz" }), "missing-header");
  });

  it("rejects garbage after the Nostr scheme", async () => {
    await expectRejection(verify({ authorization: "Nostr ###" }), "bad-encoding");
    const notJson = Buffer.from("not json").toString("base64");
    await expectRejection(verify({ authorization: `Nostr ${notJson}` }), "bad-encoding");
  });

  it("rejects a wrong-kind event even with valid NIP-98 tags", async () => {
    const event = await Effect.runPromise(
      signNostrEvent(
        {
          kind: 1,
          created_at: nowSec,
          tags: [
            ["u", URL_REGISTER],
            ["method", "POST"],
          ],
          content: "",
        },
        alice.secretKey,
      ).pipe(Effect.provide(RandomnessCounter)),
    );
    const authorization = `Nostr ${Encoding.encodeBase64(Buffer.from(JSON.stringify(event)))}`;
    await expectRejection(verify({ authorization }), "wrong-kind");
  });

  it("rejects a tampered signature", async () => {
    const valid = header();
    const json = JSON.parse(
      Buffer.from(valid.slice("Nostr ".length), "base64").toString("utf8"),
    ) as Record<string, unknown>;
    json["content"] = "tampered";
    const authorization = `Nostr ${Buffer.from(JSON.stringify(json)).toString("base64")}`;
    await expectRejection(verify({ authorization }), "bad-signature");
  });
});
