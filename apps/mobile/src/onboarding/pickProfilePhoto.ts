/**
 * Custom profile photo for onboarding (#17) — RN port of the PoC's
 * `createSquareAvatarDataUrl(file, 160)` (web `<canvas>` center-crop):
 * pick from the library with the system square cropper, downscale to
 * 160x160, encode as JPEG (quality 0.85, like the PoC) and return a
 * `data:image/jpeg;base64,...` URL — the exact shape the PoC stores and
 * publishes as `picture`.
 *
 * Resolves `null` when the user cancels. Rejections are picker/codec
 * failures; callers treat them as "no photo chosen".
 */
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

/** PoC avatar export size (square). */
export const PROFILE_PHOTO_SIZE = 160;

export const pickProfilePhoto = async (): Promise<string | null> => {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true, // system square cropper = the PoC's center-crop step
    aspect: [1, 1],
    quality: 1, // full quality into the resize; compression happens below
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!asset) return null;

  const context = ImageManipulator.manipulate(asset.uri);
  context.resize({ width: PROFILE_PHOTO_SIZE, height: PROFILE_PHOTO_SIZE });
  const image = await context.renderAsync();
  const saved = await image.saveAsync({
    format: SaveFormat.JPEG,
    compress: 0.85,
    base64: true,
  });

  return saved.base64 ? `data:image/jpeg;base64,${saved.base64}` : null;
};
