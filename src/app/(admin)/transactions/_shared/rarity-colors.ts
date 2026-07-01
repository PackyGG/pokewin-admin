// Rarity -> Tailwind class map for the SOLID card-overlay badge style used
// on the transaction- and withdrawal-detail pages: an opaque filled chip
// (bg-<color>-700/90 + light text) that sits on TOP of a card image, so it
// needs a filled background rather than the muted tint the list/table
// badges use.
//
// Hoisted here because BOTH /transactions/[id] and /withdrawals/[id]
// carried this exact map verbatim -> a single source keeps the two detail
// surfaces from drifting. Keys are lowercased rarity strings; look up with
//   RARITY_COLORS[rarity.toLowerCase()] ?? "bg-black/80 text-white".
//
// NOTE: intentionally distinct from the muted badge-tint map in
// users/[id]/transaction-detail-modal.tsx and elsewhere (that is the
// inline-badge style, this is the on-image overlay style). Do not merge them.
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
