/**
 * QrCode — the app's one QR rendering component (#37; reused by token
 * detail #38, contact QR later).
 *
 * Library choice (documented per the issue): `react-native-qrcode-svg` —
 * pure-JS QR generation rendered through `react-native-svg` (the Expo SDK
 * 56-pinned 15.x, New Architecture-compatible; RN 0.85 runs new-arch).
 * Rendered on a white card with padding (quiet zone) so dark-theme scans
 * work.
 */
import { View } from "react-native";
import QRCodeSvg from "react-native-qrcode-svg";

export interface QrCodeProps {
  readonly value: string;
  /** Module-area edge length in px (default 240). */
  readonly size?: number;
  /** QR error correction level. */
  readonly ecl?: "L" | "M" | "Q" | "H";
  readonly testID?: string;
}

export function QrCode({ value, size = 240, ecl = "M", testID }: QrCodeProps) {
  return (
    <View
      className="items-center justify-center self-center rounded-2xl bg-white p-4"
      testID={testID}
      accessibilityLabel="QR code"
    >
      <QRCodeSvg value={value} size={size} backgroundColor="#ffffff" color="#000000" ecl={ecl} />
    </View>
  );
}
