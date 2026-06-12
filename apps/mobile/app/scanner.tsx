/**
 * Scanner surface (#47; `scanner.camera`, `scanner.paste`,
 * `scanner.gallery`, `scanner.manual`) — ONE input surface for both pillars:
 * npubs for the messenger, payment targets for the wallet.
 *
 * Layout follows the PoC ScanModal: title per entry point + close, camera
 * window in the middle, Paste/Gallery as footer actions. Manual entry
 * diverges from the PoC on purpose (issue text): instead of a primary
 * scanner action it is the common-UX quiet escape hatch — a "Can't scan?"
 * text link under the actions that expands an inline input (and it is
 * front-and-center only when the camera is denied/unavailable, where it
 * actually is the fallback).
 *
 * Camera denied/unavailable NEVER blocks the surface: paste, gallery, and
 * manual entry stay usable (feature-map contract).
 *
 * Every input funnels into one `ScanCapture` handed to `handleScanCapture`
 * (#48's unified parser/router — src/scanner/scanContract.ts documents the
 * contract): handled captures navigate away and dismiss the scanner;
 * unsupported ones surface their message inline and scanning continues.
 */
import { Clipboard } from "@linky/core";
import { Button, Surface, Text } from "@linky/ui";
import { Effect, Option } from "effect";
import { CameraView, scanFromURLAsync, useCameraPermissions } from "expo-camera";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTranslator } from "../src/locales";
import { cancelNfcSession, readNfcTag } from "../src/nfc/nfcSession";
import { useNfcSupported } from "../src/nfc/nfcSupport";
import { runAppEffect } from "../src/runtime";
import type { ScanCapture, ScanSource } from "../src/scanner/scanContract";
import { handleScanCapture } from "../src/scanner/scanResultHandler";
import {
  normalizeCapturedValue,
  parseScanEntryPoint,
  scannerTitleKey,
} from "../src/scanner/scannerModel";

/** Ignore repeated camera fires of the same code within this window. */
const CAMERA_REPEAT_MS = 2000;

export default function ScannerScreen() {
  const t = useTranslator();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ entry?: string }>();
  const entry = parseScanEntryPoint(params.entry);

  const [permission, requestPermission] = useCameraPermissions();
  const [cameraBroken, setCameraBroken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");

  /** `scanner.nfc-read` (#50): gated on device support, like every NFC UI. */
  const nfcSupported = useNfcSupported();
  const [nfcReading, setNfcReading] = useState(false);

  /** One capture in flight at a time (the #48 handler may be async). */
  const busyRef = useRef(false);
  const requestedRef = useRef(false);
  const lastCameraRef = useRef<{ value: string; at: number } | null>(null);

  // Ask for the camera once when the status is still undetermined. A denial
  // is final here — the denied panel routes the user to system settings.
  useEffect(() => {
    if (permission === null || permission.granted || requestedRef.current) return;
    requestedRef.current = true;
    void requestPermission();
  }, [permission, requestPermission]);

  const deliver = (raw: string, source: ScanSource) => {
    const value = normalizeCapturedValue(raw);
    if (value === null) {
      setError(t(source === "paste" ? "pasteEmpty" : "scanUnsupported"));
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    const capture: ScanCapture = { value, source, entry };
    void handleScanCapture(capture, { router, t })
      .then((outcome) => {
        switch (outcome.kind) {
          case "handled":
            // The handler navigated/dismissed itself (scanContract.ts).
            setError(null);
            return;
          case "unsupported":
            // Feature-map contract: unsupported scans fail VISIBLY and the
            // surface keeps accepting input so the user can retry.
            setError(outcome.message);
            return;
        }
      })
      .finally(() => {
        busyRef.current = false;
      });
  };

  const onCameraScanned = (data: string) => {
    if (busyRef.current) return;
    const now = Date.now();
    const last = lastCameraRef.current;
    if (last !== null && last.value === data && now - last.at < CAMERA_REPEAT_MS) return;
    lastCameraRef.current = { value: data, at: now };
    deliver(data, "camera");
  };

  const paste = () => {
    void runAppEffect(
      Clipboard.pipe(
        Effect.flatMap((clipboard) => clipboard.read),
        Effect.catchAll(() => Effect.succeed(Option.none<string>())),
      ),
    ).then((value) => {
      deliver(Option.getOrNull(value) ?? "", "paste");
    });
  };

  const pickFromGallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
    });
    if (result.canceled) return;
    const uri = result.assets[0]?.uri;
    if (uri === undefined) return;
    try {
      const codes = await scanFromURLAsync(uri, ["qr"]);
      const data = normalizeCapturedValue(codes[0]?.data ?? "");
      if (data === null) {
        setError(t("scanImageUnsupported"));
        return;
      }
      deliver(data, "gallery");
    } catch {
      setError(t("scanImageUnsupported"));
    }
  };

  /**
   * One-tag NFC read feeding the SAME parse path as every other source
   * (feature-map contract). Cancel (system sheet on iOS, the inline cancel
   * below on Android) is a silent non-event; everything else fails visibly.
   */
  const readTag = async () => {
    if (nfcReading || busyRef.current) return;
    setError(null);
    setNfcReading(true);
    try {
      const outcome = await readNfcTag({
        prompt: t("nfcReadPrompt"),
        success: t("nfcReadSuccess"),
      });
      switch (outcome.kind) {
        case "value":
          deliver(outcome.value, "nfc");
          return;
        case "empty":
          setError(t("nfcReadEmpty"));
          return;
        case "cancelled":
          return;
        case "busy":
          setError(t("nfcWriteBusy"));
          return;
        case "disabled":
          setError(t("nfcWriteDisabled"));
          return;
        case "unavailable":
          setError(t("nfcWriteUnsupported"));
          return;
        case "failed":
          setError(outcome.message ?? t("nfcReadFailed"));
          return;
      }
    } finally {
      setNfcReading(false);
    }
  };

  const cameraGranted = permission?.granted === true && !cameraBroken;
  const cameraPending =
    !cameraBroken && (permission === null || (!permission.granted && permission.canAskAgain));

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {/* Custom header (PoC scan-sheet header): title per entry + close. */}
      <View className="flex-row items-center justify-between px-6 py-3">
        <Text weight="bold" className="text-2xl" testID="scanner-title">
          {t(scannerTitleKey(entry))}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("close")}
          hitSlop={12}
          onPress={() => router.back()}
          testID="scanner-close"
        >
          <Text className="text-2xl leading-7">✕</Text>
        </Pressable>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-6"
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Camera window — or its denied/unavailable fallback. The
            actions below stay rendered in every branch. */}
        {cameraGranted ? (
          <View className="overflow-hidden rounded-2xl" style={{ aspectRatio: 1 }}>
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={(scanned) => onCameraScanned(scanned.data)}
              onMountError={() => setCameraBroken(true)}
            />
          </View>
        ) : cameraPending ? (
          <Surface className="items-center py-12">
            <Text className="text-sm opacity-70">{t("scannerRequestingCamera")}</Text>
          </Surface>
        ) : (
          <Surface className="gap-3" testID="scanner-camera-fallback">
            <Text weight="semibold">{t("scanCameraError")}</Text>
            <Text className="text-sm opacity-70">{t("scannerPermissionHint")}</Text>
            {permission?.granted !== true && (
              <Button
                label={t("scannerOpenSettings")}
                variant="secondary"
                onPress={() => void Linking.openSettings()}
                testID="scanner-open-settings"
              />
            )}
          </Surface>
        )}

        {error !== null && (
          <Text className="text-sm text-danger" testID="scanner-error">
            {error}
          </Text>
        )}

        {/* Fallback actions (scanner.paste / scanner.gallery) — always
            available, camera or not (PoC scan-footer-actions). */}
        <View className="flex-row gap-3">
          <Button
            label={t("paste")}
            variant="secondary"
            className="flex-1"
            onPress={paste}
            testID="scanner-paste"
          />
          <Button
            label={t("scanGallery")}
            variant="secondary"
            className="flex-1"
            onPress={() => void pickFromGallery()}
            testID="scanner-gallery"
          />
          {/* scanner.nfc-read: rendered ONLY on NFC-capable devices. */}
          {nfcSupported && (
            <Button
              label={t("nfcReadTag")}
              variant="secondary"
              className="flex-1"
              disabled={nfcReading}
              onPress={() => void readTag()}
              testID="scanner-nfc"
            />
          )}
        </View>

        {/* While a read session runs: iOS shows the system sheet; Android
            scans silently, so this inline prompt (with cancel) is its UI. */}
        {nfcReading && (
          <Surface className="gap-3" testID="scanner-nfc-pending">
            <Text className="text-sm opacity-70">{t("nfcReadPrompt")}</Text>
            <Button label={t("cancel")} variant="secondary" onPress={() => cancelNfcSession()} />
          </Surface>
        )}

        {/* Manual entry (scanner.manual): quiet "can't scan?" escape
            hatch per common UX practice (PoC divergence, per issue). */}
        {manualOpen ? (
          <Surface className="gap-3" testID="scanner-manual">
            <Text weight="semibold">{t("scanTypeManually")}</Text>
            <View className="rounded-xl bg-background px-4">
              <TextInput
                value={manualText}
                onChangeText={(next) => {
                  setManualText(next);
                  setError(null);
                }}
                placeholder={t("scannerManualPlaceholder")}
                placeholderTextColor="#94a3b8"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                multiline
                testID="scanner-manual-input"
                className="min-h-[72px] py-3 font-sans text-base text-foreground"
              />
            </View>
            <Button
              label={t("scannerManualSubmit")}
              disabled={manualText.trim() === ""}
              onPress={() => deliver(manualText, "manual")}
              testID="scanner-manual-submit"
            />
          </Surface>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => setManualOpen(true)}
            hitSlop={8}
            className="items-center py-2"
            testID="scanner-manual-link"
          >
            <Text className="text-sm underline opacity-70">{t("scannerManualLink")}</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}
