// ─── Rarity → Tailwind class maps (single source of truth) ─────────────────
//
// Two DIFFERENT visual treatments, both keyed by the same lowercased rarity
// string. They are deliberately separate styles, but they must agree on WHICH
// hue a rarity gets — that agreement is what this module exists to guarantee.
//
//   RARITY_COLORS        — opaque overlay chip (`bg-<hue>-700/90` + light
//                          text) that sits ON TOP of a card image.
//   RARITY_BADGE_COLORS  — muted inline badge tint (`bg-<hue>-500/15` +
//                          light/dark text + a hairline `border-<hue>-500/30`)
//                          used inside tables, pickers and detail rows.
//
// Both carry the SAME eight keys. The badge map used to be copy-pasted into
// four pickers with only FIVE keys, so `legendary` / `holo` / `secret rare`
// rendered uncolored, and those copies also mapped `secret` to yellow while
// the overlay map maps it to pink. Both are fixed here by taking the overlay
// map's hue assignment as canonical:
//
//   common → zinc · uncommon → emerald · rare → blue · ultra rare → purple
//   secret rare → yellow · legendary → orange · holo → cyan · secret → pink
//
// Look up with `RARITY_COLORS[rarity.toLowerCase()] ?? <fallback>`.

/** Opaque on-image overlay chip. Fallback: `"bg-black/80 text-white"`. */
export const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-700/90 text-zinc-100",
  uncommon: "bg-emerald-700/90 text-emerald-100",
  rare: "bg-blue-700/90 text-blue-100",
  "ultra rare": "bg-purple-700/90 text-purple-100",
  "secret rare": "bg-yellow-600/90 text-yellow-100",
  legendary: "bg-orange-600/90 text-orange-100",
  holo: "bg-cyan-700/90 text-cyan-100",
  secret: "bg-pink-700/90 text-pink-100",
};

/** Muted inline badge tint. Fallback: the `<Badge variant="outline">` default. */
export const RARITY_BADGE_COLORS: Record<string, string> = {
  common:
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  uncommon:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  rare: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  "ultra rare":
    "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  "secret rare":
    "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  legendary:
    "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  holo: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  secret: "bg-pink-500/15 text-pink-600 dark:text-pink-400 border-pink-500/30",
};
