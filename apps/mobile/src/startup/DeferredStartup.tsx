/**
 * DeferredStartup — mounts the startup coordinator into the root layout.
 *
 * Renders nothing; after the first frame it hands the resolved translator
 * to runDeferredStartup (which is itself idempotent and defers further via
 * InteractionManager).
 */
import { useEffect } from "react";

import { useLocale } from "../locales";
import { runDeferredStartup } from "./startupCoordinator";

export function DeferredStartup() {
  const { t, locale } = useLocale();

  useEffect(() => {
    runDeferredStartup({ t, locale });
    // First mount only (`t`/`locale` intentionally untracked) — the
    // coordinator must not re-run on locale change, and runDeferredStartup
    // is idempotent anyway.
  }, []);

  return null;
}
