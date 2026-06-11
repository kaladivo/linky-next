/**
 * ContactListRow — one row of the Contacts tab (#26): avatar, name,
 * conversation preview, timestamp. PoC's ContactCard, RN edition.
 *
 * Avatar: the deterministic generated avatar for the row's npub (core's
 * `deriveGeneratedAvatar`, #17), displayed via the DiceBear png endpoint
 * (`toAvatarDisplayUrl` — RN Image cannot rasterize the canonical SVG URL).
 * Rows without an npub fall back to initials. Unknown threads carry the
 * PoC's "?" badge.
 */
import { deriveGeneratedAvatar } from "@linky/core";
import { Text } from "@linky/ui";
import { useMemo } from "react";
import { Image, Pressable, View } from "react-native";

import { toAvatarDisplayUrl } from "../onboarding/avatarDisplay";
import { formatPreviewText, formatPreviewTimestamp } from "./contactsListModel";
import type { ContactRowModel } from "./contactsListModel";

/** 48pt avatar; 144px covers @3x. */
const AVATAR_PX = 144;

const initialsOf = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part.slice(0, 1).toUpperCase());
  return letters.join("") || "?";
};

export interface ContactListRowProps {
  readonly row: ContactRowModel;
  readonly locale: string;
  readonly onPress: (row: ContactRowModel) => void;
}

export function ContactListRow({ row, locale, onPress }: ContactListRowProps) {
  const avatarUrl = useMemo(
    () =>
      row.npub === null
        ? null
        : toAvatarDisplayUrl(deriveGeneratedAvatar(row.npub).pictureUrl, AVATAR_PX),
    [row.npub],
  );

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onPress(row)}
      testID={`contact-row-${row.id}`}
      className="flex-row items-center gap-3 rounded-2xl bg-surface px-4 py-3 active:opacity-80"
    >
      <View className="h-12 w-12">
        <View className="h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-background">
          {avatarUrl !== null ? (
            <Image source={{ uri: avatarUrl }} className="h-12 w-12" resizeMode="cover" />
          ) : (
            <Text weight="semibold" className="text-sm">
              {initialsOf(row.displayName)}
            </Text>
          )}
        </View>
        {row.kind === "unknown" && (
          <View className="absolute -bottom-0.5 -right-0.5 h-5 w-5 items-center justify-center rounded-full bg-danger">
            <Text weight="bold" className="text-xs leading-4 text-background">
              ?
            </Text>
          </View>
        )}
      </View>

      <View className="flex-1 gap-0.5">
        <View className="flex-row items-center justify-between gap-2">
          <Text weight="semibold" numberOfLines={1} className="flex-1">
            {row.displayName}
          </Text>
          {row.preview !== null && (
            <Text className="text-xs opacity-60">
              {formatPreviewTimestamp(row.preview.sentAtSec, Date.now(), locale)}
            </Text>
          )}
        </View>
        {row.preview !== null && (
          <Text numberOfLines={1} className="text-sm opacity-70">
            {formatPreviewText(row.preview)}
          </Text>
        )}
      </View>
    </Pressable>
  );
}
