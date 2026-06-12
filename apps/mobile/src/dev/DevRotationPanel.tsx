/**
 * Dev-only storage-rotation surface (#54, `sync.storage-rotation`).
 *
 * Rotation itself is invisible maintenance; this panel is the debug window
 * the feature map requires: a rotation-state inspector (current write lane
 * index, lane generations, row counts per lane) plus manual per-domain
 * rotation triggers that exercise the REAL rotation path end-to-end
 * (adopt -> derive next lane -> register -> record meta entry).
 *
 * Dev-panel convention (see DevSeedPanel/DevLogoutPanel): hardcoded copy,
 * hidden in production builds.
 */
import { Button, Surface, Text } from "@linky/ui";
import { useCallback, useEffect, useState } from "react";

import type { RotatingSyncDomain } from "@linky/core";
import type { RotationDomainStatus, StorageRotation } from "@linky/evolu-store";

import { appProfile } from "../environment";
import { invalidateStoreData } from "../store/storeManager";
import { useLinkyStore } from "../store/useLinkyStore";

const DOMAINS: ReadonlyArray<RotatingSyncDomain> = [
  "contacts",
  "wallet",
  "messages",
  "transactions",
];

const shortOwnerId = (ownerId: string): string => `${ownerId.slice(0, 6)}…`;

const describeDomain = (status: RotationDomainStatus): string => {
  const lanes = status.generations
    .map((generation) => `#${String(generation.index)}=${String(generation.rowCount)} rows`)
    .join(", ");
  const rotated =
    status.rotatedAtSec === null
      ? "never rotated"
      : `rotated ${new Date(status.rotatedAtSec * 1000).toISOString()}`;
  const writeOwner = status.generations.find(
    (generation) => generation.index === status.writeIndex,
  );
  return `${status.domain}: write lane #${String(status.writeIndex)}${
    writeOwner === undefined ? "" : ` (${shortOwnerId(writeOwner.ownerId)})`
  }, ${rotated}\n  lanes: ${lanes}`;
};

export function DevRotationPanel() {
  const storeState = useLinkyStore();
  const [statuses, setStatuses] = useState<ReadonlyArray<RotationDomainStatus> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rotation = storeState.status === "ready" ? storeState.rotation : null;

  const refresh = useCallback((target: StorageRotation) => {
    target
      .inspect()
      .then(setStatuses)
      .catch((error: unknown) => setMessage(`Inspect failed: ${String(error)}`));
  }, []);

  useEffect(() => {
    if (rotation !== null) refresh(rotation);
  }, [rotation, refresh]);

  if (appProfile === "production") return null;

  const rotate = (domain: RotatingSyncDomain) => {
    if (rotation === null) return;
    setBusy(true);
    setMessage(null);
    rotation
      .rotate(domain)
      .then((result) => {
        setMessage(
          `Rotated ${result.domain} -> lane #${String(result.index)} (${shortOwnerId(result.ownerId)})`,
        );
        invalidateStoreData();
        refresh(rotation);
      })
      .catch((error: unknown) => setMessage(`Rotate failed: ${String(error)}`))
      .finally(() => setBusy(false));
  };

  return (
    <Surface className="gap-3" testID="dev-rotation-panel">
      <Text weight="bold">Storage rotation (dev only)</Text>
      <Text className="text-sm opacity-70">
        sync.storage-rotation inspector: write-lane index + row counts per lane generation.
        Rotation never removes data — old lanes stay in the read set.
      </Text>
      {statuses !== null && (
        <Text className="text-xs opacity-70" testID="dev-rotation-state">
          {statuses.map(describeDomain).join("\n")}
        </Text>
      )}
      <Button
        label="Refresh rotation state"
        variant="secondary"
        disabled={busy || rotation === null}
        onPress={() => {
          if (rotation !== null) refresh(rotation);
        }}
        testID="dev-rotation-refresh"
      />
      {DOMAINS.map((domain) => (
        <Button
          key={domain}
          label={busy ? "Rotating…" : `Rotate ${domain} lane`}
          variant="secondary"
          disabled={busy || rotation === null}
          onPress={() => rotate(domain)}
          testID={`dev-rotation-rotate-${domain}`}
        />
      ))}
      {message !== null && (
        <Text className="text-sm opacity-70" testID="dev-rotation-message">
          {message}
        </Text>
      )}
    </Surface>
  );
}
