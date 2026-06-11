import { describeEnvironment } from "@linky/core";
import { Button, Surface, Text } from "@linky/ui";
import { Link } from "expo-router";
import { ScrollView } from "react-native";

import { PlatformSmokeTestPanel } from "../../src/dev/PlatformSmokeTestPanel";
import { DevLogoutPanel } from "../../src/session/DevLogoutPanel";

import { useEffectQuery } from "../../src/runtime";

/**
 * The "Environment" card is the reference example for the Effect ↔ React
 * bridge (docs/effect-react-bridge.md): a core workflow
 * (describeEnvironment) runs on the app ManagedRuntime via useEffectQuery
 * and its result renders through the status union. describeEnvironment
 * cannot fail (E = never), but the error branch is written out anyway as
 * the canonical shape every query consumer follows.
 */
function EnvironmentSummary() {
  const summary = useEffectQuery(describeEnvironment);

  return (
    <Surface className="gap-2" testID="environment-summary">
      <Text weight="semibold" className="text-primary">
        Environment
      </Text>
      {summary.status === "loading" && <Text className="text-sm">Loading…</Text>}
      {summary.status === "error" && (
        <Text className="text-sm text-danger">Could not read environment.</Text>
      )}
      {summary.status === "success" && <Text className="text-sm">{summary.data}</Text>}
    </Surface>
  );
}

export default function SettingsScreen() {
  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 px-6 pb-8 pt-4">
      <Text weight="bold" className="text-2xl">
        Settings
      </Text>
      <EnvironmentSummary />
      <Surface className="gap-3">
        <Text>Placeholder — settings land with the settings feature.</Text>
        <Button label="Backup" variant="secondary" />
        <Button label="Delete account" variant="danger" />
      </Surface>
      {/* Dev-only logout (#14); production logout UI ships with settings. */}
      <DevLogoutPanel />
      {/* TEMPORARY: storage-spike dev screen (issue #9), removed with #15. */}
      <Link href="/dev/evolu-spike" className="p-4">
        <Text className="text-primary">Evolu spike (dev)</Text>
      </Link>
      {/* TEMPORARY (#8): dev-only platform port smoke test; renders null in production. */}
      <PlatformSmokeTestPanel />
    </ScrollView>
  );
}
