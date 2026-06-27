import "server-only";

import { unstable_cache } from "next/cache";

import { adminDb } from "@/lib/admin-db";
import type { EditPoolInputCard } from "@/app/(pack-studio)/pack-studio/doctor/retune-actions";
import type { PackRisk, RiskTier } from "@/app/(admin)/insights/edge-calc/risk";

import type {
  DraftSourcePoolCard,
  DraftSourceSnapshot,
  PendingDraftRow,
} from "./pack-retune-drafts-shared";

// Re-export the client-safe shapes + pure helpers so call sites can pull
// everything they need from one path.
export type {
  DraftSourcePoolCard,
  DraftSourceSnapshot,
  PendingDraftRow,
  WeightChangeRow,
} from "./pack-retune-drafts-shared";
export {
  topWeightChanges,
  draftHasChanges,
} from "./pack-retune-drafts-shared";

/**
 * READ-ONLY admin-DB loaders for the Pack Studio DRAFTS page. The list view
 * keys off `status='draft'` (the partial unique guarantees at most one pending
 * row per pack) — pushed/discarded rows live on a future history tab.
 *
 * Strict admin-DB only — never touches MAIN. The source pack identity (name /
 * slug) was captured into `source_snapshot` at seed time so the diff renders
 * without any live join. Drift detection is deferred to push time inside
 * `applyPackEdit`.
 *
 * Active-Timeframe-Only: we only fetch pending drafts; the `status` index +
 * partial unique on `pack_id WHERE status='draft'` keep this O(N pending),
 * never a full-table scan.
 *
 * IMPORTANT: this module is `import "server-only"` because it pulls in the
 * admin Prisma client. Anything a client component needs (the types + pure
 * helpers) lives in `pack-retune-drafts-shared.ts` so the browser bundle
 * doesn't try to bundle Prisma.
 */

// ─── Internal JSON parsers (defensive — JSONB can be anything) ───────────

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function asNullableString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function parseProposedPool(json: unknown): EditPoolInputCard[] {
  if (!Array.isArray(json)) return [];
  const out: EditPoolInputCard[] = [];
  for (const raw of json) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const cardId = asString(r.cardId);
    const weight = asNumber(r.weight);
    if (!cardId || !Number.isInteger(weight) || weight <= 0) continue;
    const order = Number.isInteger(r.order) ? (r.order as number) : 0;
    out.push({
      cardId,
      weight,
      order,
      color: typeof r.color === "string" ? r.color : undefined,
      animation: typeof r.animation === "boolean" ? r.animation : undefined,
    });
  }
  return out;
}

function parseRiskTier(v: unknown): RiskTier {
  const allowed: RiskTier[] = ["T1", "T2", "T3", "T4", "T5"];
  return (allowed as string[]).includes(v as string)
    ? (v as RiskTier)
    : "T1";
}

function parseRisk(json: unknown): PackRisk | null {
  if (!json || typeof json !== "object") return null;
  const r = json as Record<string, unknown>;
  return {
    ev: asNumber(r.ev),
    edge: asNumber(r.edge),
    cv: asNumber(r.cv),
    winRate: asNumber(r.winRate),
    nearMiss: asNumber(r.nearMiss),
    maxWin: asNumber(r.maxWin),
    maxMult: asNumber(r.maxMult),
    floorValue: asNumber(r.floorValue),
    floorRatio: asNumber(r.floorRatio),
    riskScore0to100: asNumber(r.riskScore0to100),
    tier: parseRiskTier(r.tier),
  };
}

function parseSourcePool(json: unknown): DraftSourcePoolCard[] {
  if (!Array.isArray(json)) return [];
  const out: DraftSourcePoolCard[] = [];
  for (const raw of json) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const cardId = asString(r.cardId);
    if (!cardId) continue;
    out.push({
      cardId,
      name: asString(r.name, cardId.slice(0, 8) + "…"),
      imageUrl: asString(r.imageUrl, ""),
      value: asNumber(r.value),
      weight: Number.isInteger(r.weight) ? (r.weight as number) : 0,
      color: asNullableString(r.color),
      animation: asBool(r.animation),
      order: Number.isInteger(r.order) ? (r.order as number) : 0,
    });
  }
  return out;
}

function parseSourceSnapshot(json: unknown): DraftSourceSnapshot {
  if (!json || typeof json !== "object") {
    return {
      name: "Untitled pack",
      slug: "",
      packType: "",
      active: false,
      price: 0,
      risk: null,
      pool: [],
    };
  }
  const r = json as Record<string, unknown>;
  return {
    name: asString(r.name, "Untitled pack"),
    slug: asString(r.slug, ""),
    packType: asString(r.packType, ""),
    active: asBool(r.active),
    price: asNumber(r.price),
    risk: parseRisk(r.risk),
    pool: parseSourcePool(r.pool),
  };
}

// ─── Public read: pending draft list ─────────────────────────────────────

/**
 * Uncached read used internally — `listPendingDrafts` wraps this with
 * `unstable_cache` so the page can stream without re-querying on every render
 * while still busting cleanly via `revalidateTag('pack-retune-drafts')`.
 */
async function readPendingDrafts(): Promise<PendingDraftRow[]> {
  const rows = await adminDb.pack_retune_drafts.findMany({
    where: { status: "draft" },
    orderBy: { last_edited_at: "desc" },
    select: {
      id: true,
      pack_id: true,
      proposed_price: true,
      proposed_pool: true,
      computed_risk: true,
      source_snapshot: true,
      notes: true,
      created_by: true,
      last_edited_by: true,
      created_at: true,
      last_edited_at: true,
    },
  });

  if (rows.length === 0) return [];

  // Resolve operator displays in ONE admin-DB lookup keyed on the union of
  // created_by + last_edited_by (typically a tiny set — owners + demee).
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.created_by);
    ids.add(r.last_edited_by);
  }
  const display = new Map<string, string | null>();
  if (ids.size > 0) {
    try {
      const users = await adminDb.admin_users.findMany({
        where: { id: { in: Array.from(ids) } },
        select: { id: true, username: true, display_username: true },
      });
      for (const u of users) {
        display.set(u.id, u.display_username || u.username || null);
      }
    } catch {
      // display_username column missing on older schemas — degrade gracefully.
      try {
        const users = await adminDb.admin_users.findMany({
          where: { id: { in: Array.from(ids) } },
          select: { id: true, username: true },
        });
        for (const u of users) display.set(u.id, u.username || null);
      } catch {
        /* leave display map empty */
      }
    }
  }

  return rows.map((r) => {
    const proposedPool = parseProposedPool(r.proposed_pool);
    const computedRisk = parseRisk(r.computed_risk) ?? {
      ev: 0,
      edge: 0,
      cv: 0,
      winRate: 0,
      nearMiss: 0,
      maxWin: 0,
      maxMult: 0,
      floorValue: 0,
      floorRatio: 0,
      riskScore0to100: 0,
      tier: "T1" as RiskTier,
    };
    const source = parseSourceSnapshot(r.source_snapshot);
    return {
      draftId: r.id,
      packId: r.pack_id,
      proposedPrice: Number(r.proposed_price.toString()),
      proposedPool,
      computedRisk,
      source,
      notes: r.notes,
      createdBy: r.created_by,
      createdByDisplay: display.get(r.created_by) ?? null,
      lastEditedBy: r.last_edited_by,
      lastEditedByDisplay: display.get(r.last_edited_by) ?? null,
      createdAt: r.created_at.toISOString(),
      lastEditedAt: r.last_edited_at.toISOString(),
    };
  });
}

/**
 * Cached pending-drafts list — keyed on `['pack-retune-drafts','pending']`
 * with the `pack-retune-drafts` tag so every write action's
 * `revalidateTag('pack-retune-drafts')` busts it cleanly.
 *
 * Short TTL (60s) is a defence-in-depth backstop: every mutation already
 * busts the cache via revalidateTag, so users normally see fresh data within
 * the request that mutated. The TTL ensures a wedge in revalidation can't
 * outlive a minute.
 */
export const listPendingDrafts = unstable_cache(
  async (): Promise<PendingDraftRow[]> => readPendingDrafts(),
  ["pack-retune-drafts", "pending"],
  { tags: ["pack-retune-drafts"], revalidate: 60 },
);

/**
 * Lightweight summary of the count for the "Push all (N)" button — does NOT
 * trigger the full read; the list page already has the rows via
 * `listPendingDrafts`. Reserved for callers that need just the count.
 */
export const countPendingDrafts = unstable_cache(
  async (): Promise<number> => {
    return adminDb.pack_retune_drafts.count({ where: { status: "draft" } });
  },
  ["pack-retune-drafts", "pending-count"],
  { tags: ["pack-retune-drafts"], revalidate: 60 },
);
