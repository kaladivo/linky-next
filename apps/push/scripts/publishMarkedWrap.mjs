#!/usr/bin/env node
/**
 * Dev verification helper (#52): publishes ONE push-marked NIP-59 gift wrap
 * (kind-14 chat message rumor, `["linky","push"]` wrap marker — exactly what
 * the app's send path produces) from alice to a recipient pubkey, on the
 * default dev relays. Used to verify a locally-running apps/push picks the
 * event up live and attempts Expo delivery for a registered identity.
 *
 * Usage (repo root):
 *   node apps/push/scripts/publishMarkedWrap.mjs <recipientPubkeyHex> ["message"]
 *
 * Sender: the committed throwaway alice identity (dev/test-identities).
 * NEVER use with real identities or real funds.
 */
import { Effect, Layer } from "effect";
import { webcrypto } from "node:crypto";
import {
  createGiftWrap,
  createRumor,
  deriveNostrIdentity,
  LINKY_PUSH_MARKER_TAG,
  makeChatMessageTemplate,
  Randomness,
} from "@linky/core";

const ALICE_MASTER_SECRET_HEX = "a55f0daa6a56b47237b5e9dd747e235e";
const RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.0xchat.com"];

const recipient = process.argv[2];
if (!/^[0-9a-f]{64}$/.test(recipient ?? "")) {
  console.error("usage: publishMarkedWrap.mjs <recipientPubkeyHex> [message]");
  process.exit(1);
}
const content = process.argv[3] ?? `e2e push test ${new Date().toISOString()}`;

const hexToBytes = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((p) => parseInt(p, 16)));

const RandomnessNode = Layer.succeed(Randomness, {
  nextBytes: (count) =>
    Effect.sync(() => webcrypto.getRandomValues(new Uint8Array(count))),
});

const publishTo = (url, wrap) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    const finish = (outcome) => {
      try {
        ws.close();
      } catch {}
      resolve(`${url}: ${outcome}`);
    };
    const timer = setTimeout(() => finish("timeout"), 8000);
    ws.onopen = () => ws.send(JSON.stringify(["EVENT", wrap]));
    ws.onerror = (err) => {
      clearTimeout(timer);
      finish(`error ${err?.message ?? ""}`);
    };
    ws.onmessage = (msg) => {
      try {
        const frame = JSON.parse(String(msg.data));
        if (frame[0] === "OK" && frame[1] === wrap.id) {
          clearTimeout(timer);
          finish(frame[2] ? "accepted" : `rejected: ${frame[3] ?? ""}`);
        }
      } catch {}
    };
  });

const main = async () => {
  const alice = await Effect.runPromise(
    deriveNostrIdentity(hexToBytes(ALICE_MASTER_SECRET_HEX)),
  );
  const nowSec = Math.floor(Date.now() / 1000);
  const rumor = createRumor(
    makeChatMessageTemplate({
      senderPublicKeyHex: alice.publicKeyHex,
      recipientPublicKeyHex: recipient,
      content,
      createdAtSec: nowSec,
      clientTag: `e2e-${Date.now()}`,
    }),
    alice.publicKeyHex,
  );
  const wrap = await Effect.runPromise(
    createGiftWrap(rumor, alice.secretKey, recipient, [LINKY_PUSH_MARKER_TAG]).pipe(
      Effect.provide(RandomnessNode),
    ),
  );
  console.log(`sender (alice): ${alice.publicKeyHex}`);
  console.log(`recipient:      ${recipient}`);
  console.log(`wrap id:        ${wrap.id}`);
  console.log(`rumor id:       ${rumor.id}`);
  const results = await Promise.all(RELAYS.map((url) => publishTo(url, wrap)));
  for (const line of results) console.log(line);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
