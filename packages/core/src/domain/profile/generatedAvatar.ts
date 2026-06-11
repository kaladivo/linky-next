/**
 * Deterministic generated avatar (`onboarding.customize-avatar`).
 *
 * Ported from `linky-poc/apps/web-app/src/derivedProfile.ts` — same value
 * tables, same FNV-1a seeding, same DiceBear avataaars URL, so the same
 * npub renders the same avatar as the PoC. Pinned by
 * `__fixtures__/generatedAvatar.golden.json` (generated from the PoC code
 * itself, see `__fixtures__/README.md`).
 *
 * The avatar is a plain HTTPS URL to DiceBear's avataaars renderer; this is
 * also exactly what the PoC publishes as the Nostr `picture`. The PoC
 * renders the `svg` endpoint directly in `<img>`; React Native's `Image`
 * cannot rasterize SVG, so the app derives a `png` variant of the same URL
 * for display while keeping the canonical `svg` URL in stored/published
 * metadata (see `apps/mobile/src/onboarding/avatarDisplay.ts`).
 *
 * Pure module: no ports, no effects — just hashing and string building.
 */
import { hash32, normalizeSeed } from "./avatarHash.js";

/** The eight customization dimensions the avatar editor exposes. */
export type AvatarEditorControlId =
  | "top"
  | "hairColor"
  | "accessories"
  | "face"
  | "mouth"
  | "facialHair"
  | "skin"
  | "clothing";

/** Editor controls in the PoC's display order. Labels/icons are UI copy. */
export const AVATAR_EDITOR_CONTROL_IDS: readonly AvatarEditorControlId[] = [
  "top",
  "hairColor",
  "accessories",
  "face",
  "mouth",
  "facialHair",
  "skin",
  "clothing",
];

/**
 * One concrete avatar: the seed plus an index per dimension. Indices may be
 * any integer; they are normalized into each dimension's range.
 */
export interface AvatarSelection {
  readonly accessoriesIndex: number;
  readonly clothingIndex: number;
  readonly faceIndex: number;
  readonly facialHairIndex: number;
  readonly hairColorIndex: number;
  readonly mouthIndex: number;
  readonly seed: string;
  readonly skinIndex: number;
  readonly topIndex: number;
}

export interface GeneratedAvatar {
  readonly pictureUrl: string;
  readonly selection: AvatarSelection;
}

const HAIR_TOP_VALUES: readonly string[] = [
  "bob",
  "bun",
  "curly",
  "curvy",
  "dreads",
  "frida",
  "fro",
  "froBand",
  "longButNotTooLong",
  "miaWallace",
  "shavedSides",
  "straight02",
  "straight01",
  "straightAndStrand",
  "dreads01",
  "dreads02",
  "frizzle",
  "shaggy",
  "shaggyMullet",
  "shortCurly",
  "shortFlat",
  "shortRound",
  "shortWaved",
  "sides",
  "theCaesar",
  "theCaesarAndSidePart",
  "bigHair",
];

const HAT_TOP_VALUES: readonly string[] = [
  "hat",
  "hijab",
  "turban",
  "winterHat1",
  "winterHat02",
  "winterHat03",
  "winterHat04",
];

const TOP_VALUES: readonly string[] = [...HAIR_TOP_VALUES, ...HAT_TOP_VALUES];

const HAIR_COLOR_VALUES: readonly string[] = [
  "a55728",
  "2c1b18",
  "b58143",
  "d6b370",
  "724133",
  "4a312c",
  "f59797",
  "ecdcbf",
  "c93305",
  "e8e1e1",
];

const HAT_COLOR_VALUES: readonly string[] = [
  "262e33",
  "65c9ff",
  "5199e4",
  "25557c",
  "e6e6e6",
  "929598",
  "3c4f5c",
  "b1e2ff",
  "a7ffc4",
  "ffdeb5",
  "ffafb9",
  "ffffb1",
  "ff488e",
  "ff5c5c",
  "ffffff",
];

const ACCESSORIES_VALUES: readonly string[] = [
  "kurt",
  "prescription01",
  "prescription02",
  "round",
  "sunglasses",
  "wayfarers",
  "eyepatch",
];

const ACCESSORIES_COLOR_VALUES: readonly string[] = [
  "262e33",
  "65c9ff",
  "5199e4",
  "25557c",
  "e6e6e6",
  "929598",
  "3c4f5c",
  "b1e2ff",
  "a7ffc4",
  "ffdeb5",
  "ffafb9",
  "ffffb1",
  "ff488e",
  "ff5c5c",
  "ffffff",
];

// One extra "no accessories" slot, exactly like the PoC.
const ACCESSORIES_SLOT_COUNT = ACCESSORIES_VALUES.length + 1;

const EYEBROWS_VALUES: readonly string[] = [
  "angryNatural",
  "defaultNatural",
  "flatNatural",
  "frownNatural",
  "raisedExcitedNatural",
  "sadConcernedNatural",
  "unibrowNatural",
  "upDownNatural",
  "angry",
  "default",
  "raisedExcited",
  "sadConcerned",
  "upDown",
];

const EYES_VALUES: readonly string[] = [
  "closed",
  "cry",
  "default",
  "eyeRoll",
  "happy",
  "hearts",
  "side",
  "squint",
  "surprised",
  "winkWacky",
  "wink",
  "xDizzy",
];

const MOUTH_VALUES: readonly string[] = [
  "concerned",
  "default",
  "disbelief",
  "eating",
  "grimace",
  "sad",
  "screamOpen",
  "serious",
  "smile",
  "tongue",
  "twinkle",
  "vomit",
];

const FACIAL_HAIR_VALUES: readonly string[] = [
  "beardLight",
  "beardMajestic",
  "beardMedium",
  "moustacheFancy",
  "moustacheMagnum",
];

const FACIAL_HAIR_PROBABILITY_VALUES: readonly number[] = [0, 100];

const SKIN_COLOR_VALUES: readonly string[] = [
  "614335",
  "d08b5b",
  "ae5d29",
  "edb98a",
  "ffdbb4",
  "fd9841",
  "f8d25c",
];

const CLOTHES_COLOR_VALUES: readonly string[] = [
  "262e33",
  "65c9ff",
  "5199e4",
  "25557c",
  "e6e6e6",
  "929598",
  "3c4f5c",
  "b1e2ff",
  "a7ffc4",
  "ffafb9",
  "ffffb1",
  "ff488e",
  "ff5c5c",
  "ffffff",
];

const CLOTHING_VALUES: readonly string[] = [
  "blazerAndShirt",
  "blazerAndSweater",
  "collarAndSweater",
  "graphicShirt",
  "hoodie",
  "overall",
  "shirtCrewNeck",
  "shirtScoopNeck",
  "shirtVNeck",
];

const CLOTHING_GRAPHIC_VALUES: readonly string[] = [
  "bat",
  "bear",
  "cumbia",
  "deer",
  "diamond",
  "hola",
  "pizza",
  "resist",
  "skull",
  "skullOutline",
];

const normalizeIndex = (value: number, max: number): number => {
  if (max <= 0) return 0;
  return ((Math.trunc(value) % max) + max) % max;
};

const pickIndexedValue = <T>(values: readonly T[], index: number): T | undefined => {
  return values[normalizeIndex(index, values.length)];
};

/**
 * The PoC's "pseudo-random next" cycling used for the clothing control:
 * deterministic in (seed, current index) but jumps around the combination
 * space instead of stepping sequentially.
 */
const nextPseudoRandomIndex = (
  seed: string,
  scope: string,
  currentIndex: number,
  total: number,
): number => {
  if (total <= 1) return 0;

  const current = normalizeIndex(currentIndex, total);
  const candidate = hash32(`${normalizeSeed(seed)}:${scope}:${current + 1}`) % total;

  return candidate === current ? (candidate + 1) % total : candidate;
};

const getCombinationSize = (dimensions: readonly number[]): number => {
  return dimensions.reduce((size, length) => size * Math.max(length, 1), 1);
};

const splitCombinationIndex = (
  value: number,
  dimensions: readonly number[],
): readonly number[] => {
  const totalSize = getCombinationSize(dimensions);
  let remaining = normalizeIndex(value, totalSize);
  const indexes = Array.from({ length: dimensions.length }, () => 0);

  for (let index = dimensions.length - 1; index >= 0; index -= 1) {
    const length = Math.max(dimensions[index] ?? 1, 1);
    indexes[index] = remaining % length;
    remaining = Math.floor(remaining / length);
  }

  return indexes;
};

const ACCESSORIES_DIMENSIONS = [
  ACCESSORIES_COLOR_VALUES.length,
  ACCESSORIES_SLOT_COUNT,
] as const;

const FACE_DIMENSIONS = [EYEBROWS_VALUES.length, EYES_VALUES.length] as const;

const FACIAL_HAIR_DIMENSIONS = [
  FACIAL_HAIR_PROBABILITY_VALUES.length,
  FACIAL_HAIR_VALUES.length,
] as const;

const CLOTHING_DIMENSIONS = [
  CLOTHING_VALUES.length,
  CLOTHES_COLOR_VALUES.length,
  CLOTHING_GRAPHIC_VALUES.length,
] as const;

/**
 * Builds the DiceBear avataaars URL for a selection. Query parameters are
 * appended in the PoC's exact insertion order; values are plain
 * alphanumerics, so simple `encodeURIComponent` matches `URLSearchParams`
 * output byte for byte (golden-tested).
 */
const buildAvatarUrl = (selection: AvatarSelection): string => {
  const top = pickIndexedValue(TOP_VALUES, selection.topIndex);
  const hairColor = pickIndexedValue(HAIR_COLOR_VALUES, selection.hairColorIndex);
  const hatColor = pickIndexedValue(HAT_COLOR_VALUES, selection.topIndex);

  const [accessoriesColorIndex, accessoriesSlotIndex] = splitCombinationIndex(
    selection.accessoriesIndex,
    ACCESSORIES_DIMENSIONS,
  );
  const accessoriesAreVisible = (accessoriesSlotIndex ?? 0) < ACCESSORIES_VALUES.length;
  const accessories = {
    accessories:
      pickIndexedValue(ACCESSORIES_VALUES, accessoriesSlotIndex ?? 0) ??
      ACCESSORIES_VALUES[0] ??
      "round",
    accessoriesColor:
      pickIndexedValue(ACCESSORIES_COLOR_VALUES, accessoriesColorIndex ?? 0) ?? "262e33",
    accessoriesProbability: accessoriesAreVisible ? 100 : 0,
  };

  const [eyebrowsIndex, eyesIndex] = splitCombinationIndex(selection.faceIndex, FACE_DIMENSIONS);
  const face = {
    eyebrows:
      EYEBROWS_VALUES[normalizeIndex(eyebrowsIndex ?? 0, EYEBROWS_VALUES.length)] ??
      EYEBROWS_VALUES[0] ??
      "default",
    eyes: EYES_VALUES[normalizeIndex(eyesIndex ?? 0, EYES_VALUES.length)] ?? EYES_VALUES[0] ?? "default",
  };

  const mouth = pickIndexedValue(MOUTH_VALUES, selection.mouthIndex) ?? "smile";

  const [facialHairProbabilityIndex, facialHairIndex] = splitCombinationIndex(
    selection.facialHairIndex,
    FACIAL_HAIR_DIMENSIONS,
  );
  const facialHair = {
    facialHair: pickIndexedValue(FACIAL_HAIR_VALUES, facialHairIndex ?? 0) ?? "beardLight",
    facialHairProbability:
      pickIndexedValue(FACIAL_HAIR_PROBABILITY_VALUES, facialHairProbabilityIndex ?? 0) ?? 0,
  };

  const skinColor = pickIndexedValue(SKIN_COLOR_VALUES, selection.skinIndex) ?? "614335";

  const [clothingIndex, clothesColorIndex, clothingGraphicIndex] = splitCombinationIndex(
    selection.clothingIndex,
    CLOTHING_DIMENSIONS,
  );
  const clothing = {
    clothing: pickIndexedValue(CLOTHING_VALUES, clothingIndex ?? 0) ?? "hoodie",
    clothesColor: pickIndexedValue(CLOTHES_COLOR_VALUES, clothesColorIndex ?? 0) ?? "262e33",
    clothingGraphic:
      pickIndexedValue(CLOTHING_GRAPHIC_VALUES, clothingGraphicIndex ?? 0) ?? "bat",
  };

  const params: readonly (readonly [string, string])[] = [
    ["seed", normalizeSeed(selection.seed)],
    ["top", top ?? TOP_VALUES[0] ?? "shortWaved"],
    ["hairColor", hairColor ?? HAIR_COLOR_VALUES[0] ?? "2c1b18"],
    ["hatColor", hatColor ?? HAT_COLOR_VALUES[0] ?? "3c4f5c"],
    ["accessories", accessories.accessories],
    ["accessoriesColor", accessories.accessoriesColor],
    ["accessoriesProbability", String(accessories.accessoriesProbability)],
    ["eyebrows", face.eyebrows],
    ["eyes", face.eyes],
    ["mouth", mouth],
    ["facialHair", facialHair.facialHair],
    ["facialHairColor", hairColor ?? HAIR_COLOR_VALUES[0] ?? "2c1b18"],
    ["facialHairProbability", String(facialHair.facialHairProbability)],
    ["skinColor", skinColor],
    ["clothing", clothing.clothing],
    ["clothesColor", clothing.clothesColor],
    ["clothingGraphic", clothing.clothingGraphic],
  ];

  const query = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");

  return `https://api.dicebear.com/9.x/avataaars/svg?${query}`;
};

/** The deterministic starting point for a seed (npub): one hash per dimension. */
export const deriveInitialAvatarSelection = (seedSource: string): AvatarSelection => {
  const seed = normalizeSeed(seedSource);

  return {
    accessoriesIndex: hash32(`${seed}:accessories`) % getCombinationSize(ACCESSORIES_DIMENSIONS),
    clothingIndex: hash32(`${seed}:clothing`) % getCombinationSize(CLOTHING_DIMENSIONS),
    faceIndex: hash32(`${seed}:face`) % getCombinationSize(FACE_DIMENSIONS),
    facialHairIndex: hash32(`${seed}:facialHair`) % getCombinationSize(FACIAL_HAIR_DIMENSIONS),
    hairColorIndex: hash32(`${seed}:hairColor`) % HAIR_COLOR_VALUES.length,
    mouthIndex: hash32(`${seed}:mouth`) % MOUTH_VALUES.length,
    seed,
    skinIndex: hash32(`${seed}:skin`) % SKIN_COLOR_VALUES.length,
    topIndex: hash32(`${seed}:top`) % TOP_VALUES.length,
  };
};

/** Normalizes a selection into range and renders its DiceBear URL. */
export const deriveGeneratedAvatar = (
  seedSource: string,
  selection: AvatarSelection = deriveInitialAvatarSelection(seedSource),
): GeneratedAvatar => {
  const normalizedSelection: AvatarSelection = {
    accessoriesIndex: normalizeIndex(
      selection.accessoriesIndex,
      getCombinationSize(ACCESSORIES_DIMENSIONS),
    ),
    clothingIndex: normalizeIndex(selection.clothingIndex, getCombinationSize(CLOTHING_DIMENSIONS)),
    faceIndex: normalizeIndex(selection.faceIndex, getCombinationSize(FACE_DIMENSIONS)),
    facialHairIndex: normalizeIndex(
      selection.facialHairIndex,
      getCombinationSize(FACIAL_HAIR_DIMENSIONS),
    ),
    hairColorIndex: normalizeIndex(selection.hairColorIndex, HAIR_COLOR_VALUES.length),
    mouthIndex: normalizeIndex(selection.mouthIndex, MOUTH_VALUES.length),
    seed: normalizeSeed(selection.seed || seedSource),
    skinIndex: normalizeIndex(selection.skinIndex, SKIN_COLOR_VALUES.length),
    topIndex: normalizeIndex(selection.topIndex, TOP_VALUES.length),
  };

  return {
    pictureUrl: buildAvatarUrl(normalizedSelection),
    selection: normalizedSelection,
  };
};

/**
 * Advances ONE dimension of the avatar (the editor's per-control tap).
 * Sequential `+1` for every control except clothing, which hops
 * pseudo-randomly through its large combination space — both exactly as in
 * the PoC.
 */
export const cycleGeneratedAvatar = (
  current: AvatarSelection,
  controlId: AvatarEditorControlId,
): GeneratedAvatar => {
  const nextSelection: AvatarSelection = {
    ...current,
    accessoriesIndex:
      controlId === "accessories" ? current.accessoriesIndex + 1 : current.accessoriesIndex,
    clothingIndex:
      controlId === "clothing"
        ? nextPseudoRandomIndex(
            current.seed,
            "clothing",
            current.clothingIndex,
            getCombinationSize(CLOTHING_DIMENSIONS),
          )
        : current.clothingIndex,
    faceIndex: controlId === "face" ? current.faceIndex + 1 : current.faceIndex,
    facialHairIndex:
      controlId === "facialHair" ? current.facialHairIndex + 1 : current.facialHairIndex,
    hairColorIndex:
      controlId === "hairColor" ? current.hairColorIndex + 1 : current.hairColorIndex,
    mouthIndex: controlId === "mouth" ? current.mouthIndex + 1 : current.mouthIndex,
    seed: normalizeSeed(current.seed),
    skinIndex: controlId === "skin" ? current.skinIndex + 1 : current.skinIndex,
    topIndex: controlId === "top" ? current.topIndex + 1 : current.topIndex,
  };

  return deriveGeneratedAvatar(nextSelection.seed, nextSelection);
};
