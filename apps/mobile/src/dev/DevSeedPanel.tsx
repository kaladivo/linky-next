/**
 * TEMPORARY dev-only seed panel (#26): inserts a few demo contacts,
 * messages and an unknown thread through the real repositories so the
 * Contacts tab (and later the chat work, #29) has data to render. Remove
 * once real add-contact (#27) + messaging (#22/#29) make it redundant.
 *
 * Dev-panel convention (see DevLogoutPanel): hardcoded copy, hidden in
 * production builds.
 */
import {
  createContactsRepository,
  createMessagesRepository,
} from "@linky/evolu-store";
import { Button, Surface, Text } from "@linky/ui";
import { useState } from "react";

import { appProfile } from "../environment";
import { invalidateStoreData } from "../store/storeManager";
import { useLinkyStore } from "../store/useLinkyStore";
import type { LinkyStore } from "@linky/evolu-store";

/** Bob — the committed second dev identity (dev/test-identities/bob.json). */
const BOB_NPUB = "npub1swl0lmqxtuz75j6chdq9p3lntq5ruf792458fhdty7wlm4kw7ecq47mgja";
/** Arbitrary throwaway npubs for the other demo rows. */
const CAROL_NPUB = "npub1carolcarolcarolcarolcarolcarolcarolcarolcarolcarolcaseed";
const DAN_NPUB = "npub1dandandandandandandandandandandandandandandandandanseed";
const EVE_NPUB = "npub1eveeveeveeveeveeveeveeveeveeveeveeveeveeveeveeveeveseed";
const STRANGER_NPUB = "npub1strangerstrangerstrangerstrangerstrangerstrangerseed";
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

export function DevSeedPanel() {
  const storeState = useLinkyStore();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (appProfile === "production") return null;

  const ready = storeState.status === "ready";

  const onSeed = () => {
    if (storeState.status !== "ready") return;
    setBusy(true);
    setStatus(null);
    seedDemoData(storeState.store)
      .then((outcome) =>
        setStatus(outcome === "seeded" ? "Demo data inserted." : "Already seeded."),
      )
      .catch((error: unknown) => setStatus(`Seeding failed: ${String(error)}`))
      .finally(() => setBusy(false));
  };

  return (
    <Surface className="gap-3" testID="dev-seed-panel">
      <Text weight="bold">Demo data (dev only)</Text>
      <Text className="text-sm opacity-70">
        TEMPORARY: inserts demo contacts, messages and an unknown sender through the repositories
        so the Contacts tab has something to show.
      </Text>
      <Button
        label={busy ? "Seeding…" : "Seed demo data"}
        variant="secondary"
        disabled={busy || !ready}
        onPress={onSeed}
        testID="dev-seed-demo-data"
      />
      {status !== null && <Text className="text-sm opacity-70">{status}</Text>}
    </Surface>
  );
}
