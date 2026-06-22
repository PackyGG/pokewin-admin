"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import {
  History,
  Undo2,
  Loader2,
  TriangleAlert,
  SlidersHorizontal,
  DollarSign,
  Pencil,
  Hammer,
  ChevronDown,
  GitCompare,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  formatCurrency,
  formatNumber,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";
import {
  authorizePackRetune,
  revertPackToSnapshot,
} from "@/app/(admin)/packs/actions";
import {
  getLivePackPoolForDiff,
  type LivePoolCardWithMeta,
} from "./actions";

/**
 * Pack Change History timeline + revert (owner-only). Renders the captured
 * `pack_state_snapshots` (newest first) — each row is the pack's state BEFORE a
 * write (price + a compact risk summary) — and gates a "Revert to this state"
 * behind a type-to-confirm phrase + a 2FA code (`authorizePackRetune` →
 * `revertPackToSnapshot`). The revert re-writes the LIVE pack's price + per-card
 * weights, so the dialog spells that out and notes the CURRENT state is
 * snapshotted first (the revert is itself undoable). Cards that no longer exist
 * in the pool can't be restored and are reported back after the write.
 *
 * House-POV coloring: a HIGHER house edge reads emerald (more house margin); a
 * lower edge reads rose. Tier escalates cool → rose with payout volatility,
 * matching the Pack Doctor table.
 */

type SnapshotRisk = {
  edge: number;
  cv: number;
  winRate: number;
  maxWin: number;
  maxMult: number;
  tier: string;
};

/**
 * One card slot inside a snapshot, server-shaped for the expand drawer. The
 * snapshot itself only persists `card_id + weight + color + animation + order`
 * (see `_lib/pack-history.ts:43-49`) — `name`, `imageUrl`, `value` are joined
 * in from the LIVE `cards` row at view-time. If `cards.price` has drifted
 * since capture, `value` reflects today's value, NOT capture-time value (the
 * snapshot does not persist value — Q8 in the audit).
 */
export type HistoryCardRow = {
  cardId: string;
  /** Display name from live `cards`, or null if the card was deleted. */
  name: string | null;
  imageUrl: string | null;
  /** LIVE current value (USD). 0 when the card is gone. */
  value: number;
  /** The card's weight AT CAPTURE — what a revert would restore. */
  weight: number;
};

export type HistoryRow = {
  id: string;
  packId: string;
  packName: string;
  packSlug: string | null;
  /** The pack's CURRENT live price (USD), or null if the pack is gone. */
  currentPrice: number | null;
  /** Whether the pack is currently active, or null if the pack is gone. */
  packActive: boolean | null;
  action: string;
  /** ISO timestamp the snapshot was captured. */
  capturedAt: string;
  /** admin_users.id of whoever triggered the captured write. */
  capturedBy: string;
  /** Resolved display label (display_username/username/email) or null. */
  capturedByLabel: string | null;
  /** The pack's price AT CAPTURE (the price a revert would restore). */
  price: number;
  /** Number of card slots in the snapshot. */
  cardCount: number;
  /** Per-card breakdown for the expand drawer. */
  cards: HistoryCardRow[];
  note: string | null;
  risk: SnapshotRisk | null;
};

const CONFIRM_PHRASE = "REVERT";

/** Tier badge tint — escalates cool (low vol) → rose (T5). Matches the Doctor. */
const TIER_COLORS: Record<string, string> = {
  T1: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  T2: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  T3: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  T4: "bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/30",
  T5: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

/** Action chip: icon + label + tint per snapshot action kind. */
const ACTION_META: Record<
  string,
  { label: string; icon: React.ElementType; cls: string }
> = {
  retune: {
    label: "Retune",
    icon: SlidersHorizontal,
    cls: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  },
  reprice: {
    label: "Reprice",
    icon: DollarSign,
    cls: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  },
  edit: {
    label: "Edit",
    icon: Pencil,
    cls: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  },
  build: {
    label: "Build",
    icon: Hammer,
    cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  },
  revert: {
    label: "Revert",
    icon: Undo2,
    cls: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  },
};

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

function ActionChip({ action }: { action: string }) {
  const meta = ACTION_META[action] ?? {
    label: action,
    icon: History,
    cls: "bg-muted text-muted-foreground border-border",
  };
  const Icon = meta.icon;
  return (
    <Badge
      variant="outline"
      className={cn("h-5 gap-1 px-1.5 text-[10px] font-medium", meta.cls)}
    >
      <Icon className="size-3" aria-hidden />
      {meta.label}
    </Badge>
  );
}

/** Compact risk row inside a timeline entry — edge / win / maxWin / mult / tier. */
function RiskSummary({ risk }: { risk: SnapshotRisk | null }) {
  if (!risk) {
    return (
      <span className="text-xs text-muted-foreground">
        No risk snapshot recorded.
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
      <span>
        <span className="text-muted-foreground">Edge </span>
        <span className="font-medium text-emerald-600 dark:text-emerald-400">
          {pct(risk.edge)}
        </span>
      </span>
      <span>
        <span className="text-muted-foreground">Win </span>
        <span className="font-medium">{pct(risk.winRate)}</span>
      </span>
      <span>
        <span className="text-muted-foreground">Max win </span>
        <span className="font-medium">{formatCurrency(risk.maxWin)}</span>
      </span>
      <span>
        <span className="text-muted-foreground">Mult </span>
        <span className="font-medium">{formatNumber(risk.maxMult)}×</span>
      </span>
      <Badge
        variant="outline"
        className={cn("h-5 px-1.5 text-[10px]", TIER_COLORS[risk.tier] ?? "")}
      >
        {risk.tier}
      </Badge>
    </div>
  );
}

/**
 * One row in the timeline — collapsible. Closed: header only (pack name, action
 * chip, price, risk summary, capturer, revert button). Open: per-card table
 * (Card | Value | Weight | Odds %) sorted by value DESC, with the lowest-value
 * slot called out as the "dust/buffer" card; plus a "DIFF vs current" toggle
 * that lazy-fetches the LIVE pool and overlays per-card deltas (added /
 * removed / weight change / odds change).
 *
 * House-POV coloring on deltas: a HIGHER snapshot edge = more house margin =
 * emerald; the snapshot dropping odds % on a jackpot card vs current is a WIN
 * for the house (emerald). We render odds delta as informational neutral here
 * — the owner reads "what changed" not "who won/lost" because revert direction
 * (current → snapshot vs snapshot → current) flips the sign of every delta.
 */
function HistoryEntry({
  row,
  onRevert,
}: {
  row: HistoryRow;
  onRevert: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  // Lazy-loaded LIVE pool for the "DIFF vs current" overlay. Fetched on first
  // toggle, cached for the lifetime of the row.
  const [showDiff, setShowDiff] = React.useState(false);
  const [livePool, setLivePool] = React.useState<LivePoolCardWithMeta[] | null>(
    null,
  );
  const [diffLoading, setDiffLoading] = React.useState(false);

  async function ensureDiffLoaded() {
    if (livePool !== null) return;
    setDiffLoading(true);
    try {
      const pool = await getLivePackPoolForDiff(row.packId);
      setLivePool(pool);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not load live pool.",
      );
    } finally {
      setDiffLoading(false);
    }
  }

  async function toggleDiff() {
    if (!showDiff) await ensureDiffLoaded();
    setShowDiff((v) => !v);
  }

  return (
    <li className="surface-raise rounded-xl border bg-card/40 motion-safe:transition-shadow motion-safe:duration-200 hover:shadow-sm">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <CollapsibleTrigger
            className={cn(
              "min-w-0 flex-1 cursor-pointer space-y-2 text-left outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-md",
            )}
            aria-label={`${open ? "Collapse" : "Expand"} snapshot for ${row.packName}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-200",
                  open && "rotate-180",
                )}
                aria-hidden
              />
              <span className="truncate text-sm font-semibold text-foreground">
                {row.packName}
              </span>
              <ActionChip action={row.action} />
              {row.packActive === false && (
                <Badge
                  variant="outline"
                  className="h-5 px-1.5 text-[10px] text-muted-foreground"
                >
                  Pack inactive
                </Badge>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-muted-foreground">
              <span title={formatDateTime(row.capturedAt)}>
                {formatRelative(row.capturedAt)}
              </span>
              <span aria-hidden>·</span>
              <span title={`UTC: ${row.capturedAt}`}>
                {formatDateTime(row.capturedAt)}
              </span>
              <span aria-hidden>·</span>
              <span>
                by{" "}
                {row.capturedByLabel ? (
                  <span className="font-medium text-foreground/80">
                    {row.capturedByLabel}
                  </span>
                ) : (
                  <span className="font-mono">
                    {row.capturedBy.slice(0, 8)}…
                  </span>
                )}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-6 text-xs">
              <span>
                <span className="text-muted-foreground">Price </span>
                <span className="font-medium tabular-nums">
                  {formatCurrency(row.price)}
                </span>
                {row.currentPrice != null &&
                  row.currentPrice !== row.price && (
                    <span className="ml-1 text-muted-foreground">
                      (now {formatCurrency(row.currentPrice)})
                    </span>
                  )}
              </span>
              <span className="text-muted-foreground">
                {row.cardCount} card{row.cardCount === 1 ? "" : "s"}
              </span>
            </div>

            <div className="pl-6">
              <RiskSummary risk={row.risk} />
            </div>

            {row.note && (
              <p className="pl-6 text-xs italic text-muted-foreground">
                {row.note}
              </p>
            )}
          </CollapsibleTrigger>

          <div className="shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={(e) => {
                // The whole header is a CollapsibleTrigger — stop the revert
                // click from also toggling the row.
                e.stopPropagation();
                onRevert();
              }}
              disabled={row.currentPrice == null}
              title={
                row.currentPrice == null
                  ? "This pack no longer exists — nothing to revert."
                  : "Revert the live pack to this state"
              }
            >
              <Undo2 className="size-3.5" aria-hidden />
              Revert to this state
            </Button>
          </div>
        </div>

        <CollapsibleContent className="motion-safe:data-[ending-style]:opacity-0 motion-safe:data-[starting-style]:opacity-0 motion-safe:transition-opacity motion-safe:duration-200">
          <div className="border-t bg-muted/10 px-4 py-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Per-card odds at this snapshot
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={toggleDiff}
                disabled={row.currentPrice == null || diffLoading}
                title={
                  row.currentPrice == null
                    ? "This pack no longer exists — no live state to diff against."
                    : showDiff
                      ? "Hide the diff vs current overlay"
                      : "Show added/removed cards and weight deltas vs current"
                }
              >
                {diffLoading ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : showDiff ? (
                  <X className="size-3.5" aria-hidden />
                ) : (
                  <GitCompare className="size-3.5" aria-hidden />
                )}
                {showDiff ? "Hide diff" : "DIFF vs current"}
              </Button>
            </div>

            <SnapshotCardTable
              cards={row.cards}
              livePool={showDiff ? livePool : null}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * Sum of snapshot weights for odds %. Defensive against 0/negative totals.
 */
function sumWeights(cards: { weight: number }[]): number {
  let s = 0;
  for (const c of cards) s += Math.max(0, c.weight);
  return s > 0 ? s : 1;
}

type DiffKind = "same" | "added" | "removed" | "weight_changed";

type DisplayCardRow = {
  cardId: string;
  name: string | null;
  imageUrl: string | null;
  value: number;
  /** Snapshot weight (0 when card is only in live, i.e. added since). */
  weight: number;
  /** Snapshot odds % (0 when card is only in live). */
  oddsPct: number;
  /** Live current weight (null when diff is off OR card not in live). */
  liveWeight: number | null;
  /** Live current odds % (null when diff is off OR card not in live). */
  liveOddsPct: number | null;
  kind: DiffKind;
};

function buildDisplayRows(
  snapshotCards: HistoryCardRow[],
  livePool: LivePoolCardWithMeta[] | null,
): DisplayCardRow[] {
  const snapshotTotal = sumWeights(snapshotCards);
  const liveTotal = livePool ? sumWeights(livePool) : 0;

  if (!livePool) {
    // Snapshot-only view (no diff). Sort by value DESC; ties broken by weight DESC.
    return [...snapshotCards]
      .sort((a, b) => b.value - a.value || b.weight - a.weight)
      .map((c) => ({
        cardId: c.cardId,
        name: c.name,
        imageUrl: c.imageUrl,
        value: c.value,
        weight: c.weight,
        oddsPct: c.weight / snapshotTotal,
        liveWeight: null,
        liveOddsPct: null,
        kind: "same" as const,
      }));
  }

  // Union of card_ids across snapshot and live, indexed.
  const snapById = new Map(snapshotCards.map((c) => [c.cardId, c]));
  const liveById = new Map(livePool.map((c) => [c.cardId, c]));
  const allIds = new Set<string>([...snapById.keys(), ...liveById.keys()]);

  const rows: DisplayCardRow[] = [];
  for (const id of allIds) {
    const s = snapById.get(id);
    const l = liveById.get(id);
    if (s && l) {
      rows.push({
        cardId: id,
        // Prefer live name/imageUrl (always fresh), fall back to snapshot row.
        name: l.name ?? s.name,
        imageUrl: l.imageUrl ?? s.imageUrl,
        value: l.value || s.value,
        weight: s.weight,
        oddsPct: s.weight / snapshotTotal,
        liveWeight: l.weight,
        liveOddsPct: l.weight / liveTotal,
        kind: s.weight === l.weight ? "same" : "weight_changed",
      });
    } else if (s) {
      // In snapshot, NOT in live → REMOVED since capture (would be re-added on revert).
      rows.push({
        cardId: id,
        name: s.name,
        imageUrl: s.imageUrl,
        value: s.value,
        weight: s.weight,
        oddsPct: s.weight / snapshotTotal,
        liveWeight: null,
        liveOddsPct: null,
        kind: "removed",
      });
    } else if (l) {
      // In live, NOT in snapshot → ADDED since capture (would NOT be touched on revert).
      rows.push({
        cardId: id,
        name: l.name,
        imageUrl: l.imageUrl,
        value: l.value,
        weight: 0,
        oddsPct: 0,
        liveWeight: l.weight,
        liveOddsPct: l.weight / liveTotal,
        kind: "added",
      });
    }
  }

  // Sort by value DESC, then by snapshot weight DESC, so jackpot lands on top.
  rows.sort((a, b) => b.value - a.value || b.weight - a.weight);
  return rows;
}

/**
 * Per-card table for an expanded snapshot. Card | Value | Weight | Odds %.
 * When `livePool` is provided, renders the "DIFF vs current" overlay (added /
 * removed / weight delta + current odds % alongside snapshot odds %). The
 * lowest-value snapshot card is highlighted as the buffer/dust card.
 */
function SnapshotCardTable({
  cards,
  livePool,
}: {
  cards: HistoryCardRow[];
  livePool: LivePoolCardWithMeta[] | null;
}) {
  const rows = React.useMemo(
    () => buildDisplayRows(cards, livePool),
    [cards, livePool],
  );

  // Find the cheapest SNAPSHOT card — the buffer/dust slot. Uses the snapshot's
  // own value ranking (not the live pool), so the dust callout is what was at
  // capture even when the diff is showing.
  const dustCardId = React.useMemo(() => {
    if (cards.length === 0) return null;
    let cheapest = cards[0];
    for (const c of cards) {
      if (c.value < cheapest.value) cheapest = c;
    }
    return cheapest.cardId;
  }, [cards]);

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        This snapshot has no card slots.
      </p>
    );
  }

  const diffMode = livePool !== null;
  const addedCount = rows.filter((r) => r.kind === "added").length;
  const removedCount = rows.filter((r) => r.kind === "removed").length;
  const changedCount = rows.filter((r) => r.kind === "weight_changed").length;

  return (
    <div className="space-y-2">
      {diffMode && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {addedCount > 0 && (
            <Badge
              variant="outline"
              className="h-5 gap-1 px-1.5 text-[10px] bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
            >
              <span className="font-medium">+{addedCount}</span> added since
            </Badge>
          )}
          {removedCount > 0 && (
            <Badge
              variant="outline"
              className="h-5 gap-1 px-1.5 text-[10px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
            >
              <span className="font-medium">−{removedCount}</span> removed since
            </Badge>
          )}
          {changedCount > 0 && (
            <Badge
              variant="outline"
              className="h-5 gap-1 px-1.5 text-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
            >
              <span className="font-medium">{changedCount}</span> weight changed
            </Badge>
          )}
          {addedCount === 0 && removedCount === 0 && changedCount === 0 && (
            <span className="text-muted-foreground">
              Pool identical to live — only price may differ.
            </span>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-md border bg-background">
        <table className="w-full text-xs tabular-nums">
          <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Card</th>
              <th className="px-2 py-1.5 text-right font-medium">Value</th>
              <th className="px-2 py-1.5 text-right font-medium">Weight</th>
              <th className="px-2 py-1.5 text-right font-medium">
                {diffMode ? "Snapshot %" : "Odds %"}
              </th>
              {diffMode && (
                <th className="px-2 py-1.5 text-right font-medium">Live %</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <SnapshotCardRow
                key={r.cardId}
                row={r}
                isDust={r.cardId === dustCardId}
                diffMode={diffMode}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SnapshotCardRow({
  row,
  isDust,
  diffMode,
}: {
  row: DisplayCardRow;
  isDust: boolean;
  diffMode: boolean;
}) {
  const kindTint =
    row.kind === "added"
      ? "bg-rose-500/[0.04]"
      : row.kind === "removed"
        ? "bg-emerald-500/[0.04]"
        : row.kind === "weight_changed"
          ? "bg-amber-500/[0.04]"
          : "";

  return (
    <tr className={cn("border-t", kindTint)}>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-2">
          {row.imageUrl ? (
            <Image
              src={row.imageUrl}
              alt=""
              width={28}
              height={28}
              className="size-7 shrink-0 rounded border bg-muted/30 object-contain"
              unoptimized
            />
          ) : (
            <div className="size-7 shrink-0 rounded border bg-muted/30" />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate font-medium text-foreground">
                {row.name ?? (
                  <span className="font-mono text-muted-foreground">
                    {row.cardId.slice(0, 8)}…
                  </span>
                )}
              </span>
              {isDust && (
                <Badge
                  variant="outline"
                  className="h-4 gap-0.5 px-1 text-[9px] bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
                  title="Lowest-value slot in this snapshot — the buffer/dust card."
                >
                  <Sparkles className="size-2.5" aria-hidden />
                  Dust
                </Badge>
              )}
              {diffMode && row.kind === "added" && (
                <Badge
                  variant="outline"
                  className="h-4 px-1 text-[9px] bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
                  title="Added to the pool AFTER this snapshot — a revert would remove this card."
                >
                  Added
                </Badge>
              )}
              {diffMode && row.kind === "removed" && (
                <Badge
                  variant="outline"
                  className="h-4 px-1 text-[9px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                  title="Removed from the pool AFTER this snapshot — a revert can't restore it because it no longer exists in the live pool."
                >
                  Removed
                </Badge>
              )}
              {diffMode && row.kind === "weight_changed" && (
                <Badge
                  variant="outline"
                  className="h-4 px-1 text-[9px] bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
                  title="Weight changed since this snapshot — a revert would restore the snapshot weight."
                >
                  Δ weight
                </Badge>
              )}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground/70">
              {row.cardId.slice(0, 8)}…
            </div>
          </div>
        </div>
      </td>
      <td className="px-2 py-1.5 text-right text-muted-foreground">
        {row.value > 0 ? formatCurrency(row.value) : "—"}
      </td>
      <td className="px-2 py-1.5 text-right">
        {row.kind === "added" ? (
          <span className="text-muted-foreground/60">—</span>
        ) : (
          formatNumber(row.weight)
        )}
        {diffMode &&
          row.liveWeight != null &&
          row.kind === "weight_changed" && (
            <div className="text-[10px] text-muted-foreground">
              live {formatNumber(row.liveWeight)}
            </div>
          )}
      </td>
      <td className="px-2 py-1.5 text-right">
        {row.kind === "added" ? (
          <span className="text-muted-foreground/60">—</span>
        ) : (
          pct(row.oddsPct)
        )}
      </td>
      {diffMode && (
        <td className="px-2 py-1.5 text-right">
          {row.liveOddsPct == null ? (
            <span className="text-muted-foreground/60">—</span>
          ) : (
            pct(row.liveOddsPct)
          )}
        </td>
      )}
    </tr>
  );
}

export function HistoryTimeline({ rows }: { rows: HistoryRow[] }) {
  const [revertTarget, setRevertTarget] = React.useState<HistoryRow | null>(null);

  return (
    <>
      <ol className="relative space-y-3">
        {rows.map((row) => (
          <HistoryEntry
            key={row.id}
            row={row}
            onRevert={() => setRevertTarget(row)}
          />
        ))}
      </ol>

      <RevertDialog
        target={revertTarget}
        onClose={() => setRevertTarget(null)}
      />
    </>
  );
}

type RevertPhase = "idle" | "applying" | "done";

function RevertDialog({
  target,
  onClose,
}: {
  target: HistoryRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [phase, setPhase] = React.useState<RevertPhase>("idle");
  const [confirmText, setConfirmText] = React.useState("");
  const [totp, setTotp] = React.useState("");

  // Reset the form whenever the dialog opens for a (new) snapshot.
  React.useEffect(() => {
    if (target) {
      setPhase("idle");
      setConfirmText("");
      setTotp("");
    }
  }, [target]);

  const open = target !== null;
  const busy = phase === "applying";
  const totpValid = /^\d{6}$/.test(totp.trim());
  const ready =
    !busy &&
    confirmText.trim().toUpperCase() === CONFIRM_PHRASE &&
    totpValid;

  async function runRevert() {
    if (!target || !ready) return;
    setPhase("applying");

    let token: string;
    try {
      const res = await authorizePackRetune(totp.trim());
      token = res.token;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "2FA verification failed.");
      setPhase("idle");
      return;
    }

    try {
      const res = await revertPackToSnapshot(target.id, token);
      setPhase("done");
      const skipped = res.skippedCardIds.length;
      toast.success(
        `Reverted ${res.name}: ${res.restoredCardCount} card${
          res.restoredCardCount === 1 ? "" : "s"
        } restored · ${formatCurrency(res.priceAfter)}.`,
      );
      if (skipped > 0) {
        toast.warning(
          `${skipped} card${skipped === 1 ? "" : "s"} could not be restored — ${
            skipped === 1 ? "it no longer exists" : "they no longer exist"
          } in the pack's pool.`,
        );
      }
      router.refresh();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revert failed.");
      setPhase("idle");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!busy && !o ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2 className="size-4" aria-hidden />
            Revert {target?.packName ?? "pack"}
          </DialogTitle>
          <DialogDescription>
            Restores this pack&apos;s <strong>price and per-card odds</strong> to
            the captured state below.
          </DialogDescription>
        </DialogHeader>

        {target && (
          <div className="space-y-4 text-sm">
            {/* Live-write warning + undoability note */}
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                This writes the <strong>live pack</strong> — price + weights for
                real players. The pack&apos;s <strong>current</strong> state is
                snapshotted first, so this revert is itself undoable. Cards no
                longer in the pool can&apos;t be restored and are reported after.
              </span>
            </div>

            {/* Target snapshot summary */}
            <div className="rounded-lg border bg-muted/20 px-3 py-2">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Reverting to
                </span>
                <ActionChip action={target.action} />
              </div>
              <div className="mb-1 text-xs text-muted-foreground">
                {formatDateTime(target.capturedAt)} ·{" "}
                {formatCurrency(target.price)} · {target.cardCount} card
                {target.cardCount === 1 ? "" : "s"}
              </div>
              <RiskSummary risk={target.risk} />
            </div>

            <Separator />

            <div className="space-y-1.5">
              <Label htmlFor="rev-confirm">
                Type {CONFIRM_PHRASE} to confirm
              </Label>
              <Input
                id="rev-confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_PHRASE}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="rev-totp">2FA code</Label>
              <Input
                id="rev-totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                className="w-40 tracking-[0.3em]"
                aria-invalid={totp.length > 0 && !totpValid}
                disabled={busy}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={runRevert} disabled={!ready}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Undo2 className="size-4" aria-hidden />
            )}
            Revert pack
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
