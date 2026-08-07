/** Stable catalog pools shared by pack queries and admin-side assignments. */
export const PACK_POOLS = ["pokemon", "onepiece", "rewards", "meme"] as const;

export type PackSetFilter = (typeof PACK_POOLS)[number];

/** Coerce an optional URL/filter value to a known pool. */
export function parsePackSet(value: string | undefined): PackSetFilter {
  return (PACK_POOLS as readonly string[]).includes(value ?? "")
    ? (value as PackSetFilter)
    : "pokemon";
}
