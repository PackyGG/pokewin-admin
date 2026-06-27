// Client-safe types + pure helpers for the Pack Studio Drafts surface.
//
// This module CANNOT import from `@/lib/admin-db` / Prisma / `server-only` —
// `drafts-list.tsx` is a client component and pulls these helpers into the
// browser bundle. The server-only loaders (and any code touching the admin
// DB) live in `pack-retune-drafts.ts` and re-export from here for parity.

import type { EditPoolInputCard } from "@/app/(pack-studio)/pack-studio/doctor/retune-actions";
import type { PackRisk } from "@/app/(admin)/insights/edge-calc/risk";

/**
 * Per-card pool entry as captured in `source_snapshot.pool` (full identity +
 * value, used for the BEFORE column and for the per-card weight diff).
 */
export type DraftSourcePoolCard = {
  cardId: string;
  name: string;
  imageUrl: string;
  /** `cards.price` at seed time — the item's value. */
  value: number;
  weight: number;
  color: string | null;
  animation: boolean;
  order: number;
};

/** The captured-at-seed-time source pack identity + pool + risk. */
export type DraftSourceSnapshot = {
  name: string;
  slug: string;
  packType: string;
  active: boolean;
  price: number;
  risk: PackRisk | null;
  pool: DraftSourcePoolCard[];
};

/** One pending draft row, ready to render. All scalar / JSON-safe. */
export type PendingDraftRow = {
  draftId: string;
  packId: string;
  proposedPrice: number;
  proposedPool: EditPoolInputCard[];
  computedRisk: PackRisk;
  source: DraftSourceSnapshot;
  notes: string | null;
  createdBy: string;
  createdByDisplay: string | null;
  lastEditedBy: string;
  lastEditedByDisplay: string | null;
  createdAt: string;
  lastEditedAt: string;
};

export type WeightChangeRow = {
  cardId: string;
  name: string;
  imageUrl: string;
  value: number;
  /** Source weight (0 if the card was added by the draft — currently impossible since draft pools mirror MAIN identity). */
  before: number;
  /** Draft weight (0 if removed — impossible today; reserved for future "pool identity edits"). */
  after: number;
  /** after − before. */
  delta: number;
  /** Probability share AFTER (post-draft) for sorting + visual weight. */
  afterShare: number;
};

/**
 * Compute the Top-N cards by absolute weight delta between the source snapshot
 * and the proposed pool. Used by the inline diff dropdown.
 *
 * Pure — no DB calls. Card metadata comes from `source.pool` (the source
 * snapshot mirrors the live pool identity 1:1 at seed time).
 */
export function topWeightChanges(
  source: DraftSourceSnapshot,
  proposedPool: EditPoolInputCard[],
  limit = 5,
): WeightChangeRow[] {
  const meta = new Map<string, DraftSourcePoolCard>();
  for (const c of source.pool) meta.set(c.cardId, c);

  const proposedById = new Map<string, EditPoolInputCard>();
  for (const c of proposedPool) proposedById.set(c.cardId, c);

  const totalAfter = proposedPool.reduce((s, c) => s + c.weight, 0) || 1;

  const rows: WeightChangeRow[] = [];
  const seen = new Set<string>();

  for (const src of source.pool) {
    const proposed = proposedById.get(src.cardId);
    const before = src.weight;
    const after = proposed?.weight ?? 0;
    if (before === after) continue;
    seen.add(src.cardId);
    rows.push({
      cardId: src.cardId,
      name: src.name,
      imageUrl: src.imageUrl,
      value: src.value,
      before,
      after,
      delta: after - before,
      afterShare: after / totalAfter,
    });
  }
  // Cards present in the proposed pool but not in the source snapshot (added).
  for (const p of proposedPool) {
    if (seen.has(p.cardId)) continue;
    const src = meta.get(p.cardId);
    rows.push({
      cardId: p.cardId,
      name: src?.name ?? p.cardId.slice(0, 8) + "…",
      imageUrl: src?.imageUrl ?? "",
      value: src?.value ?? 0,
      before: 0,
      after: p.weight,
      delta: p.weight,
      afterShare: p.weight / totalAfter,
    });
  }

  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return rows.slice(0, limit);
}

/**
 * Helper for the "did the proposal actually change anything?" badge. Compares
 * source vs proposed price + per-card weights. Pure.
 */
export function draftHasChanges(row: PendingDraftRow): boolean {
  if (row.source.price !== row.proposedPrice) return true;
  const sourceWeights = new Map<string, number>();
  for (const c of row.source.pool) sourceWeights.set(c.cardId, c.weight);
  if (sourceWeights.size !== row.proposedPool.length) return true;
  for (const p of row.proposedPool) {
    if (sourceWeights.get(p.cardId) !== p.weight) return true;
  }
  return false;
}
