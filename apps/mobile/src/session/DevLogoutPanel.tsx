/**
 * Dev-only logout panel (#14), rendered on Settings next to the other dev
 * panels. Invokes core's `clearIdentitySession`; the boot gate then swaps
 * the tabs for the onboarding placeholder. The production logout UI ships
 * with the settings feature.
 *
 * Copy contract (account-identity.md): logout must NOT imply remote
 * deletion — only local keys are removed.
 */
// TODO(#17): copy via @linky/locales once the mobile app wires i18n.
import { Button, Surface, Text } from "@linky/ui";
import { useState } from "react";

import { appProfile } from "../environment";
import { logout } from "./sessionActions";

export function DevLogoutPanel() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  if (appProfile === "production") {
    return null;
  }

  const onLogout = () => {
    setBusy(true);
    setFailed(false);
    logout()
      .catch(() => {
        // Never log the error object: it can wrap native keychain errors.
        setFailed(true);
      })
      .finally(() => setBusy(false));
  };

  return (
    <Surface className="gap-3" testID="dev-logout-panel">
      <Text weight="bold">Session (dev only)</Text>
      <Text className="text-sm opacity-70">
        Log out removes the keys from this device only. Your synced data and funds stay recoverable
        with your 20-word backup phrase.
      </Text>
      <Button
        label={busy ? "Logging out…" : "Log out"}
        variant="danger"
        disabled={busy}
        onPress={onLogout}
        testID="dev-logout"
      />
      {failed && <Text className="text-sm text-danger">Logout failed. Try again.</Text>}
    </Surface>
  );
}
