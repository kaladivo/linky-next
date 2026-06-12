/**
 * TEMPORARY dev-only seed panel (#26, wallet seed unified by #37, extended
 * by #28): inserts demo contacts/messages, an unknown thread, and demo
 * wallet token records through the real repositories so the Contacts tab,
 * the wallet home, and the chat work (#29) have data to render. Remove
 * once real flows make it redundant.
 *
 * #28 additions for unknown-sender verification:
 * - the stranger is a REAL (throwaway) npub, so promote/block can decode
 *   it to a hex pubkey and the kind-10000 mute-list publish works;
 * - "Inbound from stranger" replays an inbound chat event through
 *   `applyChatEvent` — after blocking, the outcome must be "blocked" and
 *   no thread may reappear;
 * - "List blocked senders" surfaces `BlocksRepository.list()` (the dev
 *   verification window into the blocked list).
 *
 * Dev-panel convention (see DevLogoutPanel): hardcoded copy, hidden in
 * production builds.
 */
import {
  createBlocksRepository,
  createContactsRepository,
  createMessagesRepository,
} from "@linky/evolu-store";
import { Button, Surface, Text } from "@linky/ui";
import { useState } from "react";

import { appProfile } from "../environment";
import { invalidateStoreData } from "../store/storeManager";
import { useLinkyStore } from "../store/useLinkyStore";
import { seedDevForeignMint, seedDevWallet } from "./devWalletSeed";
import type { LinkyStore } from "@linky/evolu-store";

/** Bob — the committed second dev identity (dev/test-identities/bob.json). */
const BOB_NPUB = "npub1swl0lmqxtuz75j6chdq9p3lntq5ruf792458fhdty7wlm4kw7ecq47mgja";
/** Arbitrary throwaway npubs for the other demo rows. */
const CAROL_NPUB = "npub1carolcarolcarolcarolcarolcarolcarolcarolcarolcarolcaseed";
const DAN_NPUB = "npub1dandandandandandandandandandandandandandandandandanseed";
const EVE_NPUB = "npub1eveeveeveeveeveeveeveeveeveeveeveeveeveeveeveeveeveseed";
/**
 * The unknown sender — a VALID throwaway npub (secret key 0x7f×32, pubkey
 * hex 142715675faf8da1ecc4d51e0b9e539fa0d52fdd96ed60dbe99adb15d6b05ad9) so
 * the #28 promote/block flows can decode it; never a real identity.
 */
const STRANGER_NPUB = "npub1zsn32e6l47x6rmxy650qh8jnn7sd2t7ajmkkpklfntd3t44sttvsgg5m7h";
const SELF_NPUB = "npub1selfselfselfselfselfselfselfselfselfselfselfselfseed";

const seedDemoData = async (store: LinkyStore): Promise<"seeded" | "already-seeded"> => {
  const contacts = createContactsRepository(store);
  const messages = createMessagesRepository(store);

  if ((await contacts.findByNpub(BOB_NPUB)) !== null) return "already-seeded";

  const insertContact = (contact: Parameters<typeof contacts.insert>[0]) => {
    const result = contacts.insert(contact);
    if (!result.ok) throw new Error(`seed contact failed: ${result.error.reason}`);
    return result.value.id;
  };

  insertContact({ name: "Bob", npub: BOB_NPUB });
  insertContact({ npub: CAROL_NPUB, groupName: "Friends" }); // no name: derived default shows
  insertContact({ name: "Dan", npub: DAN_NPUB, groupName: "Work" });
  const eveId = insertContact({ name: "Eve (archived)", npub: EVE_NPUB });

  const nowSec = Math.floor(Date.now() / 1000);
  const archived = contacts.update(eveId, { archivedAtSec: nowSec - 7 * 24 * 3600 });
  if (!archived.ok) throw new Error("seed archive failed");

  const event = async (
    peerNpub: string,
    direction: "in" | "out",
    content: string,
    sentAtSec: number,
    rumorId: string,
  ) => {
    const applied = await messages.applyChatEvent({
      kind: "message",
      rumorId,
      peerNpub,
      senderNpub: direction === "in" ? peerNpub : SELF_NPUB,
      direction,
      content,
      sentAtSec,
    });
    if (!applied.ok) throw new Error(`seed message failed: ${applied.error.reason}`);
  };

  // Conversation order target: stranger (newest) > Bob > Carol; Dan and
  // Eve stay conversation-less ("Other contacts" / archive sections).
  await event(CAROL_NPUB, "in", "Ahoj! Are we still on for Friday?", nowSec - 3 * 24 * 3600, "seed-carol-1");
  await event(CAROL_NPUB, "out", "Yes — see you at 8.", nowSec - 3 * 24 * 3600 + 120, "seed-carol-2");
  await event(BOB_NPUB, "out", "Sent you the sats for lunch, check your wallet", nowSec - 3600, "seed-bob-1");
  await event(BOB_NPUB, "in", "Got them, thanks! This message is intentionally long so the list preview gets truncated with an ellipsis.", nowSec - 3000, "seed-bob-2");
  // Inbound from a non-contact -> creates the local-only unknown thread.
  await event(STRANGER_NPUB, "in", "hey, we met at the conference — this is my new key", nowSec - 600, "seed-stranger-1");

  invalidateStoreData();
  return "seeded";
};

/**
 * #28 verification action: replays a fresh inbound chat event from the
 * stranger through `applyChatEvent` — exactly what the NIP-17 engine will
 * do. While the stranger is blocked the outcome is "blocked" and no
 * unknown thread may (re)appear.
 */
const seedInboundFromStranger = async (store: LinkyStore): Promise<string> => {
  const messages = createMessagesRepository(store);
  const nowSec = Math.floor(Date.now() / 1000);
  const applied = await messages.applyChatEvent({
    kind: "message",
    rumorId: `dev-stranger-${Date.now()}`,
    peerNpub: STRANGER_NPUB,
    senderNpub: STRANGER_NPUB,
    direction: "in",
    content: `dev ping at ${new Date().toISOString()}`,
    sentAtSec: nowSec,
  });
  invalidateStoreData();
  if (!applied.ok) return `applyChatEvent failed: ${applied.error.reason}`;
  return `outcome=${applied.value.outcome}, unknownThreadCreated=${String(
    applied.value.unknownThreadCreated,
  )}`;
};

/** #28 verification window: the active blocked-sender rows. */
const listBlockedSenders = async (store: LinkyStore): Promise<string> => {
  const blocks = createBlocksRepository(store);
  const records = await blocks.list();
  if (records.length === 0) return "Blocked senders: none";
  return `Blocked senders (${records.length}): ${records
    .map((record) => `${record.npub.slice(0, 12)}…${record.npub.slice(-6)}`)
    .join(", ")}`;
};

export function DevSeedPanel() {
  const storeState = useLinkyStore();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (appProfile === "production") return null;

  const ready = storeState.status === "ready";

  const runSeed = (seed: (store: LinkyStore) => Promise<"seeded" | "already-seeded">) => {
    if (storeState.status !== "ready") return;
    setBusy(true);
    setStatus(null);
    seed(storeState.store)
      .then((outcome) => {
        invalidateStoreData();
        setStatus(outcome === "seeded" ? "Demo data inserted." : "Already seeded.");
      })
      .catch((error: unknown) => setStatus(`Seeding failed: ${String(error)}`))
      .finally(() => setBusy(false));
  };

  const runAction = (action: (store: LinkyStore) => Promise<string>) => {
    if (storeState.status !== "ready") return;
    setBusy(true);
    setStatus(null);
    action(storeState.store)
      .then(setStatus)
      .catch((error: unknown) => setStatus(`Action failed: ${String(error)}`))
      .finally(() => setBusy(false));
  };

  return (
    <Surface className="gap-3" testID="dev-seed-panel">
      <Text weight="bold">Demo data (dev only)</Text>
      <Text className="text-sm opacity-70">
        TEMPORARY: inserts demo contacts/messages and demo wallet token records through the real
        repositories (wallet rows persist across relaunches).
      </Text>
      <Button
        label={busy ? "Seeding…" : "Seed demo contacts"}
        variant="secondary"
        disabled={busy || !ready}
        onPress={() => runSeed(seedDemoData)}
        testID="dev-seed-demo-data"
      />
      <Button
        label={busy ? "Seeding…" : "Seed demo wallet"}
        variant="secondary"
        disabled={busy || !ready}
        onPress={() => runSeed(seedDevWallet)}
        testID="dev-seed-demo-wallet"
      />
      <Button
        label={busy ? "Seeding…" : "Seed foreign-mint balance (#42)"}
        variant="secondary"
        disabled={busy || !ready}
        onPress={() => runSeed(seedDevForeignMint)}
        testID="dev-seed-foreign-mint"
      />
      <Button
        label="Inbound from stranger"
        variant="secondary"
        disabled={busy || !ready}
        onPress={() => runAction(seedInboundFromStranger)}
        testID="dev-seed-stranger-message"
      />
      <Button
        label="List blocked senders"
        variant="secondary"
        disabled={busy || !ready}
        onPress={() => runAction(listBlockedSenders)}
        testID="dev-list-blocked"
      />
      {status !== null && <Text className="text-sm opacity-70">{status}</Text>}
    </Surface>
  );
}
