/**
 * Active-thread tracker (#52) — which chat the user is currently viewing.
 *
 * The in-app rich notification path (chatInboxRunner → local notification)
 * stays quiet for the OPEN conversation: its messages render live in the
 * thread, so alerting would be the "duplicate alert" the feature map
 * forbids. `app/chat/[id].tsx` registers itself on focus.
 */
let activeChatId: string | null = null;

export const setActiveChatThread = (chatId: string | null): void => {
  activeChatId = chatId;
};

export const getActiveChatThread = (): string | null => activeChatId;
