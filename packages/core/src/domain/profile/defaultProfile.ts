/**
 * Deterministic default profile for a fresh identity (`onboarding.setup-profile`,
 * `profile.default-linky-address`).
 *
 * Ported from `linky-poc/apps/web-app/src/derivedProfile.ts` +
 * `firstNames.ts`: the same npub picks the same first name (per language)
 * and the same default Lightning address as the PoC. Pinned by
 * `__fixtures__/generatedAvatar.golden.json`.
 *
 * Pure module: no ports, no effects.
 */
import { hash32 } from "./avatarHash.js";
import { deriveGeneratedAvatar } from "./generatedAvatar.js";

/**
 * Languages with a name list. Deliberately a local union, NOT a dependency
 * on @linky/locales (core imports no workspace packages); the app maps its
 * SupportedLocale onto this.
 */
export type NameLanguage = "cs" | "en";

export const DEFAULT_LIGHTNING_ADDRESS_DOMAIN = "linky.fit";

// Name lists copied verbatim from linky-poc/apps/web-app/src/firstNames.ts —
// keep byte-identical so the deterministic pick matches the PoC.
export const CZECH_FIRST_NAMES: readonly string[] = [
  "Alžběta",
  "Adéla",
  "Adriana",
  "Anežka",
  "Aneta",
  "Anna",
  "Barbora",
  "Beáta",
  "Bohdana",
  "Bohumila",
  "Břetislava",
  "Daniela",
  "Darina",
  "Denisa",
  "Diana",
  "Dominika",
  "Dorota",
  "Eliška",
  "Emma",
  "Eva",
  "Františka",
  "Gabriela",
  "Hana",
  "Helena",
  "Ilona",
  "Irena",
  "Ivana",
  "Jana",
  "Jarmila",
  "Jaroslava",
  "Jitka",
  "Johanka",
  "Julie",
  "Justýna",
  "Karolína",
  "Kateřina",
  "Klára",
  "Kristýna",
  "Laura",
  "Lenka",
  "Ludmila",
  "Lucie",
  "Magdaléna",
  "Markéta",
  "Martina",
  "Michaela",
  "Monika",
  "Natálie",
  "Nela",
  "Nikola",
  "Olga",
  "Pavla",
  "Petra",
  "Radka",
  "Renata",
  "Romana",
  "Růžena",
  "Sabina",
  "Simona",
  "Soňa",
  "Šárka",
  "Tereza",
  "Veronika",
  "Viktorie",
  "Vlasta",
  "Zdeňka",
  "Zuzana",

  "Adam",
  "Adrian",
  "Albert",
  "Aleš",
  "Alex",
  "Andrej",
  "Antonín",
  "Bohumír",
  "Daniel",
  "David",
  "Dominik",
  "Filip",
  "František",
  "Hynek",
  "Jakub",
  "Jan",
  "Jaroslav",
  "Jindřich",
  "Jirí",
  "Jonáš",
  "Josef",
  "Karel",
  "Kristián",
  "Lukáš",
  "Martin",
  "Matěj",
  "Mikuláš",
  "Milan",
  "Ondřej",
  "Patrik",
  "Pavel",
  "Petr",
  "Radek",
  "Robert",
  "Roman",
  "Stanislav",
  "Šimon",
  "Tomáš",
  "Václav",
  "Viktor",
  "Vojtěch",
  "Zdeněk",
];

export const ENGLISH_FIRST_NAMES: readonly string[] = [
  "Alice",
  "Amelia",
  "Ava",
  "Bella",
  "Charlotte",
  "Chloe",
  "Daisy",
  "Ella",
  "Emily",
  "Emma",
  "Grace",
  "Hannah",
  "Isabella",
  "Isla",
  "Ivy",
  "Layla",
  "Lily",
  "Lucy",
  "Mia",
  "Nora",
  "Olivia",
  "Ruby",
  "Sophia",
  "Violet",
  "Willow",
  "Zoe",

  "Aaron",
  "Alexander",
  "Benjamin",
  "Callum",
  "Charlie",
  "Daniel",
  "Ethan",
  "Felix",
  "Finn",
  "George",
  "Harry",
  "Henry",
  "Isaac",
  "Jack",
  "James",
  "Leo",
  "Liam",
  "Lucas",
  "Max",
  "Michael",
  "Noah",
  "Oliver",
  "Oscar",
  "Samuel",
  "Theodore",
  "Thomas",
  "William",
];

/** The PoC's deterministic onboarding name: FNV-1a over the npub, per-language list. */
export const pickDeterministicName = (npub: string, lang: NameLanguage): string => {
  const key = String(npub ?? "").trim();
  const list = lang === "cs" ? CZECH_FIRST_NAMES : ENGLISH_FIRST_NAMES;
  if (!key) return list[0] ?? "Linky";
  if (!list.length) return "Linky";
  const idx = hash32(key) % list.length;
  return list[idx] ?? list[0] ?? "Linky";
};

/** `${npub}@linky.fit` — the predictable hosted receive address for new profiles. */
export const deriveDefaultLightningAddress = (npub: string): string => {
  const normalized = String(npub ?? "").trim();
  return normalized ? `${normalized}@${DEFAULT_LIGHTNING_ADDRESS_DOMAIN}` : "";
};

export interface DefaultProfile {
  readonly lnAddress: string;
  readonly name: string;
  readonly pictureUrl: string;
}

/** Everything profile setup pre-fills for a fresh npub: name, avatar URL, ln address. */
export const deriveDefaultProfile = (npub: string, lang: NameLanguage = "en"): DefaultProfile => {
  const normalized = String(npub ?? "").trim();
  const name = pickDeterministicName(normalized, lang);
  const pictureUrl = deriveGeneratedAvatar(normalized).pictureUrl;
  const lnAddress = deriveDefaultLightningAddress(normalized);
  return { name, lnAddress, pictureUrl };
};
