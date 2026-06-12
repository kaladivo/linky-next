/**
 * useNotificationsState (#52) — loads the persisted notifications state and
 * re-loads it whenever an action bumps the notifications version (same
 * plain-async staleness pattern as useChatThread).
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import { runAppEffect } from "../runtime";
import { loadNotificationsState } from "./notificationsState";
import type { NotificationsState } from "./notificationsState";
import { getNotificationsVersion, subscribeToNotifications } from "./notificationsStore";

export type NotificationsStateView =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly state: NotificationsState };

export const useNotificationsState = (): NotificationsStateView => {
  const [view, setView] = useState<NotificationsStateView>({ status: "loading" });
  const version = useSyncExternalStore(subscribeToNotifications, getNotificationsVersion);

  useEffect(() => {
    let stale = false;
    void runAppEffect(loadNotificationsState).then((state) => {
      if (!stale) setView({ status: "ready", state });
    });
    return () => {
      stale = true;
    };
  }, [version]);

  return view;
};
