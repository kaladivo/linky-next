/**
 * TEMPORARY dev-only scaffolding (issue #8): visual harness for the
 * @linky/platform smoke tests. Rendered on the Settings screen for
 * non-production profiles only; delete once real features cover the ports.
 */
import { Button, Surface, Text } from "@linky/ui";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import { appProfile } from "../environment";
import type { SmokeTestResult } from "./platformSmokeTest";
import { runPlatformSmokeTests } from "./platformSmokeTest";

export function PlatformSmokeTestPanel() {
  const [results, setResults] = useState<readonly SmokeTestResult[] | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(() => {
    setRunning(true);
    runPlatformSmokeTests()
      .then(setResults)
      .catch((error: unknown) => {
        setResults([{ name: "Runtime", pass: false, detail: String(error) }]);
      })
      .finally(() => setRunning(false));
  }, []);

  useEffect(run, [run]);

  if (appProfile === "production") {
    return null;
  }

  return (
    <Surface className="gap-3" testID="platform-smoke-test">
      <Text weight="bold">Platform smoke test (temporary, dev only)</Text>
      {results === null ? (
        <Text className="text-sm opacity-70">Running…</Text>
      ) : (
        results.map((result) => (
          <View key={result.name} testID={`smoke-${result.name}`}>
            <Text weight="semibold" className={result.pass ? "text-primary" : "text-danger"}>
              {result.pass ? "PASS" : "FAIL"} — {result.name}
            </Text>
            <Text className="text-xs opacity-70">{result.detail}</Text>
          </View>
        ))
      )}
      <Button
        label={running ? "Running…" : "Re-run smoke test"}
        variant="secondary"
        disabled={running}
        onPress={run}
        testID="smoke-rerun"
      />
    </Surface>
  );
}
