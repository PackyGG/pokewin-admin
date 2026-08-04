import { pgArrayParam } from "@/lib/drizzle-array-param";
import "server-only";

import { sql } from "drizzle-orm";
import { getReadDrizzleDb } from "@/lib/db";
import { adminDrizzle } from "@/lib/admin-db";
import { isUuid } from "@/lib/utils/ids";
import { getPackCardValues } from "@/lib/queries/pack-card-values";
import {
  computePackRisk,
  type PackRisk,
} from "@/app/(admin)/insights/edge-calc/risk";

/**
 * Pack change-history + revert backend.
 *
 * Goal: capture the FULL prior state of a pack (its price + every card weight,
 * color, animation, order) BEFORE each write that changes weights or price, into
 * the ADMIN DB (`pack_state_snapshots`), so the owner can review the history and
 * REVERT a pack to an older state.
 *
 * Dual-DB discipline (CRITICAL):
 *   • The pack's CURRENT state is read READ-ONLY from the MAIN game DB
 *     (`packs.price` + `pack_cards`). MAIN is never written here.
 *   • The snapshot row is written to the ADMIN DB only.
 *   • No cross-DB FK — `pack_id` / `captured_by` are loose columns (same
 *     convention as pack_risk_scores / pack_set_assignments).
 *
 * The capture is BEST-EFFORT by contract for the write hooks: it runs BEFORE the
 * committed MAIN write so the recorded state is the one you can revert TO, but a
 * snapshot failure must NOT fail the MAIN write — `capturePackSnapshot` swallows
 * + logs its own errors and returns null on failure (see the hook call sites).
 */

/** The action a snapshot was captured before. */
export type PackSnapshotAction =
  | "edit"
  | "reprice"
  | "retune"
  | "revert"
  | "build";

/** One card slot in a snapshot's `cards` JSON — exactly what a revert re-writes. */
export type SnapshotCard = {
  card_id: string;
  weight: number;
  color: string | null;
  animation: boolean;
  order: number;
};

export type CapturedPackState = {
  price: number;
  cards: SnapshotCard[];
  tags: string[];
  risk?: PackRisk | null;
};

/**
 * READ-ONLY (MAIN): the pack's current price + full pack_cards pool with the
 * metadata a revert needs to faithfully re-create the rows (weight, color,
 * animation, order). Returns null when the pack doesn't exist.
 */
async function readCurrentPackState(packId: string): Promise<{
  price: number;
  cards: SnapshotCard[];
  /** `packs.tags` (pack_tag[] → DB strings) at capture time — for tag revert. */
  tags: string[];
} | null> {
  const db = await getReadDrizzleDb();
  const result = await db.execute<{
    price: string;
    tags: string[];
    cards: SnapshotCard[];
  }>(sql`
    SELECT
      p.price::text AS price,
      p.tags::text[] AS tags,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'card_id', pc.card_id,
            'weight', pc.weight,
            'color', pc.color,
            'animation', pc.animation,
            'order', pc.order
          ) ORDER BY pc.order
        ) FILTER (WHERE pc.card_id IS NOT NULL),
        '[]'::jsonb
      ) AS cards
    FROM packs p
    LEFT JOIN pack_cards pc ON pc.pack_id = p.id
    WHERE p.id = ${packId}::uuid
    GROUP BY p.id
  `);
  const pack = result.rows[0];
  if (!pack) return null;

  return {
    price: Number(pack.price.toString()),
    tags: Array.isArray(pack.tags) ? pack.tags.map((t) => String(t)) : [],
    cards: pack.cards,
  };
}

/**
 * Best-effort current PackRisk for the pack — uses the SAME read-only pool +
 * price the rest of the risk surfaces score with (`getPackCardValues` +
 * `computePackRisk`). Returns null if it can't be computed (empty pool, read
 * error) so the snapshot's `risk` column stays optional.
 */
async function computeCurrentRisk(
  packId: string,
  price: number,
): Promise<PackRisk | null> {
  try {
    const pool = await getPackCardValues(packId);
    if (pool.length === 0) return null;
    return computePackRisk({
      cards: pool.map((c) => ({ value: c.value, weight: c.weight })),
      price,
    });
  } catch (err) {
    console.error("[pack-history] computeCurrentRisk failed", err);
    return null;
  }
}

export type CapturePackSnapshotInput = {
  packId: string;
  action: PackSnapshotAction;
  /** admin_users.id of whoever triggered the write this snapshot precedes. */
  capturedBy: string;
  note?: string;
};

async function insertSnapshotRow(input: {
  data: {
    pack_id: string;
    captured_by: string;
    action: string;
    price: number;
    cards: unknown;
    tags: unknown;
    risk?: unknown;
    note: string | null;
  };
  select?: unknown;
}): Promise<{ id: string }> {
  const data = input.data;
  const result = await adminDrizzle.execute<{ id: string }>(sql`
    INSERT INTO pack_state_snapshots (
      pack_id, captured_by, action, price, cards, tags, risk, note
    ) VALUES (
      ${data.pack_id}, ${data.captured_by}, ${data.action}, ${data.price},
      ${JSON.stringify(data.cards)}::jsonb,
      ${JSON.stringify(data.tags)}::jsonb,
      ${data.risk == null ? null : JSON.stringify(data.risk)}::jsonb,
      ${data.note}
    )
    RETURNING id
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Snapshot insert returned no row");
  return row;
}

/**
 * Capture ONE snapshot of the pack's CURRENT state (price + every card weight)
 * into the ADMIN DB. Reads MAIN read-only, writes ADMIN only.
 *
 * BEST-EFFORT: never throws. On any failure it logs and returns null so a hook
 * placed before a committed MAIN write can't break that write. Returns the new
 * snapshot id on success.
 *
 * The CALLER is responsible for auth — every call site is already behind an
 * owner/admin + capability gate (the pack write actions). This function does NOT
 * re-gate, mirroring how `refreshPackRiskScore` is invoked post-gate.
 */
export async function capturePackSnapshot(
  input: CapturePackSnapshotInput,
): Promise<string | null> {
  try {
    if (!isUuid(input.packId)) {
      console.error("[pack-history] capturePackSnapshot: invalid pack id");
      return null;
    }

    const state = await readCurrentPackState(input.packId);
    if (!state) {
      // Pack doesn't exist (e.g. captured for a build before the pack is
      // created) — nothing to snapshot. Not an error.
      return null;
    }

    const risk = await computeCurrentRisk(input.packId, state.price);

    return capturePackSnapshotFromState(input, {
      ...state,
      risk,
    });
  } catch (err) {
    console.error("[pack-history] capturePackSnapshot failed", err);
    return null;
  }
}

/**
 * Persist a caller-supplied state that was read from the authoritative MAIN
 * transaction. Full-state editors use this after commit so a mirror delay or a
 * failed write cannot create a misleading history entry.
 */
export async function capturePackSnapshotFromState(
  input: CapturePackSnapshotInput,
  state: CapturedPackState,
): Promise<string | null> {
  try {
    if (!isUuid(input.packId)) {
      console.error("[pack-history] capturePackSnapshotFromState: invalid pack id");
      return null;
    }

    const row = await insertSnapshotRow({
      data: {
        pack_id: input.packId,
        captured_by: input.capturedBy,
        action: input.action,
        price: state.price,
        cards: state.cards,
        // The pack's tags at capture time — a revert restores them so the tag
        // control's write is undoable like every other pack mutation.
        tags: state.tags,
        risk: state.risk ?? undefined,
        note: input.note ?? null,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    console.error("[pack-history] capturePackSnapshotFromState failed", err);
    return null;
  }
}

/** A single history entry surfaced to the review/revert UI. */
export type PackSnapshot = {
  id: string;
  packId: string;
  capturedAt: string;
  capturedBy: string;
  action: string;
  price: number;
  cards: SnapshotCard[];
  /**
   * `packs.tags` (DB strings, e.g. ["%5"]) captured with this snapshot, or null
   * for snapshots taken before the tag column shipped. A revert restores these
   * when non-null; null ⇒ the revert leaves the live tag untouched.
   */
  tags: string[] | null;
  risk: PackRisk | null;
  note: string | null;
};

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

function mapSnapshotRow(r: {
  id: string;
  pack_id: string;
  captured_at: Date | string;
  captured_by: string;
  action: string;
  price: { toString(): string };
  cards: unknown;
  tags: unknown;
  risk: unknown;
  note: string | null;
}): PackSnapshot {
  return {
    id: r.id,
    packId: r.pack_id,
    capturedAt: new Date(r.captured_at).toISOString(),
    capturedBy: r.captured_by,
    action: r.action,
    price: Number(r.price.toString()),
    cards: (Array.isArray(r.cards) ? r.cards : []) as unknown as SnapshotCard[],
    // null (not []) for legacy snapshots so a revert can tell "no tag recorded"
    // (leave live tag alone) from "recorded an empty tag set" (an untag revert).
    tags: Array.isArray(r.tags)
      ? (r.tags as unknown[]).map((t) => String(t))
      : null,
    risk: (r.risk ?? null) as unknown as PackRisk | null,
    note: r.note,
  };
}

/**
 * READ-ONLY ADMIN list of pack snapshots, newest first. When `packId` is given,
 * scopes to that pack (served by the
 * `pack_state_snapshots_pack_captured_idx` (pack_id, captured_at DESC) index);
 * otherwise returns the most recent snapshots across ALL packs.
 *
 * Caller is responsible for auth (owner/admin gate at the action boundary).
 */
export async function getPackHistory(
  packId?: string,
  limit: number = HISTORY_DEFAULT_LIMIT,
): Promise<PackSnapshot[]> {
  const take = Math.min(
    Math.max(1, Math.floor(Number.isFinite(limit) ? limit : HISTORY_DEFAULT_LIMIT)),
    HISTORY_MAX_LIMIT,
  );

  if (packId !== undefined && !isUuid(packId)) {
    throw new Error("Invalid pack id");
  }

  const result = await adminDrizzle.execute<Parameters<typeof mapSnapshotRow>[0]>(
    sql`
      SELECT id, pack_id, captured_at, captured_by, action, price,
             cards, tags, risk, note
      FROM pack_state_snapshots
      ${packId ? sql`WHERE pack_id = ${packId}` : sql``}
      ORDER BY captured_at DESC
      LIMIT ${take}
    `,
  );

  return result.rows.map(mapSnapshotRow);
}

/**
 * READ-ONLY ADMIN fetch of a single snapshot by id (the revert target). Returns
 * null when the id doesn't exist. Caller is responsible for auth.
 */
export async function getPackSnapshot(
  snapshotId: string,
): Promise<PackSnapshot | null> {
  if (!isUuid(snapshotId)) return null;
  const result = await adminDrizzle.execute<Parameters<typeof mapSnapshotRow>[0]>(
    sql`
      SELECT id, pack_id, captured_at, captured_by, action, price,
             cards, tags, risk, note
      FROM pack_state_snapshots
      WHERE id = ${snapshotId}::uuid
      LIMIT 1
    `,
  );
  const row = result.rows[0];
  return row ? mapSnapshotRow(row) : null;
}

/** Minimal card identity surfaced to the expand-row drawer in the history UI. */
export type HistoryCardMeta = {
  /** Display name from the live `cards` row, or null when the card is gone. */
  name: string | null;
  /** `cards.image_url` for the thumbnail, or null when the card is gone. */
  imageUrl: string | null;
  /** The card's CURRENT live value (USD) — used for EV at view-time. */
  value: number;
};

/**
 * READ-ONLY (MAIN): batch-read `cards.{name, image_url, price}` for the union
 * of card ids surfaced by a history view, keyed by card_id. Absent ids are
 * simply missing from the map (the card was deleted since the snapshot was
 * captured) so the UI can render a "card no longer exists" fallback row.
 *
 * Index path: PK probe on `cards.id` via `id = ANY($1)` (no seq-scan).
 *
 * NOTE: the snapshot does NOT persist per-card value (Q8 in the audit). The
 * value returned here is the LIVE current value. If `cards.price` has drifted
 * since capture, the EV-at-snapshot display reflects today's value, not
 * capture-time value. This matches how the rest of the risk surfaces score a
 * historical pool.
 */
export async function getHistoryCardMeta(
  cardIds: string[],
): Promise<Map<string, HistoryCardMeta>> {
  const out = new Map<string, HistoryCardMeta>();
  if (cardIds.length === 0) return out;
  const db = await getReadDrizzleDb();
  const result = await db.execute<{
    id: string;
    name: string | null;
    image_url: string | null;
    price: string;
  }>(sql`
    SELECT id, name, image_url, price::text AS price
    FROM cards
    WHERE id = ANY(${pgArrayParam(cardIds)}::uuid[])
  `);
  for (const r of result.rows) {
    out.set(r.id, {
      name: r.name,
      imageUrl: r.image_url,
      value: Number(r.price.toString()),
    });
  }
  return out;
}

/** One live pool entry surfaced to the "DIFF vs current" comparison. */
export type LivePoolCard = {
  cardId: string;
  weight: number;
  value: number;
};

/**
 * READ-ONLY (MAIN): the live pack's current pool as `{cardId, value, weight}`,
 * matching the snapshot's per-card unit so the UI can diff them apples-to-apples.
 * Returns `[]` for a pack that no longer exists.
 *
 * Caller is responsible for auth — every consumer in (admin)/packs/actions.ts
 * already runs through `requirePageAccess("/packs")` + `require2FA()` +
 * an owner / repricer check before invoking these helpers.
 */
export async function getLivePackPool(
  packId: string,
): Promise<LivePoolCard[]> {
  if (!isUuid(packId)) return [];
  const pool = await getPackCardValues(packId);
  return pool.map((c) => ({
    cardId: c.cardId,
    weight: c.weight,
    value: c.value,
  }));
}
