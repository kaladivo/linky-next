/**
 * TEMPORARY dev/test route for the storage spike (issue #9).
 *
 * Open via deep link: linky:///dev/evolu-spike
 *
 * Verifies on-device that:
 * - Evolu runs in the Expo custom dev client with expo-sqlite,
 * - rows persist across app restarts (local SQLite),
 * - the app owner is derived from an external mnemonic (derived-identity
 *   scheme), and
 * - the Evolu relay (wss://free.evoluhq.com) accepts a connection for that
 *   owner (Evolu 7.4.1 exposes no public sync-state API — `useSyncState` is
 *   disabled upstream — so like the PoC we probe the relay WebSocket).
 *
 * Issue #15 replaced the spike's `spikeNote` table with the real six-domain
 * schema; this screen now writes `metaEntry` rows (meta domain) instead.
 */
// MUST stay the first import: installs crypto.getRandomValues for Evolu.
import "../../lib/cryptoPolyfill";

import { SimpleName } from "@evolu/common";
import { evoluReactNativeDeps } from "@evolu/react-native/expo-sqlite";
import { appOwnerFromMnemonic, createLinkyEvolu } from "@linky/evolu-store";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

const RELAY_URL = "wss://free.evoluhq.com";

/**
 * Dev-only test mnemonic (standard BIP-39 test vector). Stands in for a
 * lane mnemonic derived from the SLIP-39 master identity (issue #13).
 */
const DEV_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const appOwner = appOwnerFromMnemonic(DEV_MNEMONIC);

const evolu = createLinkyEvolu(evoluReactNativeDeps, {
  name: SimpleName.orThrow("linky-evolu-spike"),
  transports: [{ type: "WebSocket", url: RELAY_URL }],
  ...(appOwner ? { externalAppOwner: appOwner } : {}),
});

const notesQuery = evolu.createQuery((db) =>
  db
    .selectFrom("metaEntry")
    .selectAll()
    .where("isDeleted", "is not", 1)
    .orderBy("createdAt", "asc"),
);

type RelayStatus = "checking" | "connected" | "disconnected";

export default function EvoluSpikeScreen() {
  const [rows, setRows] = useState<ReadonlyArray<{ value: string | null }>>([]);
  const [relayStatus, setRelayStatus] = useState<RelayStatus>("checking");
  const [lastError, setLastError] = useState<string | null>(null);

  // Load + subscribe to the notes query.
  useEffect(() => {
    let mounted = true;
    void evolu.loadQuery(notesQuery).then((r) => {
      if (mounted) setRows(r);
    });
    const unsubscribe = evolu.subscribeQuery(notesQuery)(() => {
      setRows(evolu.getQueryRows(notesQuery));
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  // Surface Evolu errors.
  useEffect(() => {
    const unsubscribe = evolu.subscribeError(() => {
      const error = evolu.getError();
      setLastError(error ? JSON.stringify(error) : null);
    });
    return unsubscribe;
  }, []);

  // Probe the relay WebSocket for this owner (PoC-style status check).
  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;

    const probe = () => {
      if (cancelled) return;
      setRelayStatus("checking");
      const url = appOwner ? `${RELAY_URL}?ownerId=${appOwner.id}` : RELAY_URL;
      try {
        socket = new WebSocket(url);
      } catch {
        setRelayStatus("disconnected");
        return;
      }
      socket.onopen = () => {
        if (!cancelled) setRelayStatus("connected");
        socket?.close();
      };
      socket.onerror = () => {
        if (!cancelled) setRelayStatus("disconnected");
      };
    };

    probe();
    const interval = setInterval(probe, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      socket?.close();
    };
  }, []);

  const addNote = useCallback(() => {
    const result = evolu.insert("metaEntry", {
      key: "dev.note",
      value: `note ${new Date().toISOString()}`,
    });
    if (!result.ok) setLastError(JSON.stringify(result.error));
  }, []);

  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 20, fontWeight: "600" }}>Evolu spike</Text>

      <Text testID="evolu-owner-id">
        ownerId: {appOwner ? appOwner.id : "owner derivation FAILED"}
      </Text>

      <Text testID="evolu-relay-status">relay: {relayStatus}</Text>

      <Text testID="evolu-row-count">rows: {rows.length}</Text>

      <Text testID="evolu-last-error">error: {lastError ?? "none"}</Text>

      <Pressable
        testID="evolu-add-note"
        accessibilityRole="button"
        onPress={addNote}
        style={{
          backgroundColor: "#2dd4bf",
          borderRadius: 8,
          padding: 12,
          alignItems: "center",
        }}
      >
        <Text style={{ fontWeight: "600" }}>Add note</Text>
      </Pressable>

      <View style={{ gap: 4 }}>
        {rows.map((row, i) => (
          <Text key={i} style={{ fontVariant: ["tabular-nums"] }}>
            {row.value}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}
