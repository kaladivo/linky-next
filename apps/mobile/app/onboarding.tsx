/**
 * Onboarding route (#14): shown by the boot gate when no identity is
 * persisted. Real onboarding lands with #17/#18; this renders the
 * placeholder (plus the dev-only "Create dev identity" button) and redirects
 * back into the tabs as soon as an identity exists.
 */
import { Redirect } from "expo-router";

import { OnboardingPlaceholder } from "../src/session/OnboardingPlaceholder";
import { useSession } from "../src/session/useSession";

export default function OnboardingScreen() {
  const session = useSession();

  if (session.status === "success" && session.data._tag === "IdentityLoaded") {
    return <Redirect href="/(tabs)" />;
  }
  return <OnboardingPlaceholder />;
}
