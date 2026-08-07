/**
 * OnePiece-specific dropdown options for the card create / edit flow.
 *
 * Rarity codes match the canonical OP TCG short codes (C / UC / R / L
 * / SR / SEC / SP / TR / P) — stored verbatim in `cards.rarity`. The
 * human label is what the dropdown shows; the value is what hits the
 * DB. Keep both columns aligned with the OP printing rules — when a
 * new rarity ships, add it here, don't fork the list per surface.
 *
 * Card-type options are the four official OP card classes; same value
 * = label since the DB stores them human-readable already.
 *
 * Both lists are `as const` so the server action can derive a Zod
 * enum directly from `.map(o => o.value)` without losing literal-type
 * narrowing.
 */

export const ONEPIECE_RARITY_OPTIONS = [
  { value: "C", label: "Common" },
  { value: "UC", label: "Uncommon" },
  { value: "R", label: "Rare" },
  { value: "L", label: "Leader" },
  { value: "SR", label: "Super Rare" },
  { value: "SEC", label: "Secret Rare" },
  { value: "SP", label: "Special Rare" },
  { value: "TR", label: "Treasure Rare" },
  { value: "P", label: "Promo" },
] as const;

export const ONEPIECE_CARD_TYPE_OPTIONS = [
  { value: "Leader", label: "Leader" },
  { value: "Character", label: "Character" },
  { value: "Event", label: "Event" },
  { value: "Stage", label: "Stage" },
] as const;

export type OnePieceRarity = (typeof ONEPIECE_RARITY_OPTIONS)[number]["value"];
type OnePieceCardType =
  (typeof ONEPIECE_CARD_TYPE_OPTIONS)[number]["value"];

export const ONEPIECE_RARITY_VALUES = ONEPIECE_RARITY_OPTIONS.map(
  (o) => o.value,
) as readonly OnePieceRarity[];

const ONEPIECE_CARD_TYPE_VALUES = ONEPIECE_CARD_TYPE_OPTIONS.map(
  (o) => o.value,
) as readonly OnePieceCardType[];

/**
 * Set-name match used by the create dialog and any other surface that
 * needs to fork its UI for OnePiece. Case-insensitive against the
 * exact seed name "OnePiece" (see `seedInitialSets` in /sets).
 */
export function isOnePieceSetName(name: string | undefined | null): boolean {
  return (name ?? "").trim().toLowerCase() === "onepiece";
}
