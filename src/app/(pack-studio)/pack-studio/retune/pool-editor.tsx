"use client";

import * as React from "react";
import {
  ArrowRight,
  Check,
  Info,
  Loader2,
  Sparkles,
  TriangleAlert,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AnimatedNumber } from "@/components/animated-number";
import { InfoHint } from "@/app/(admin)/creators/_components/info-hint";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
  computePackRisk,
  shapeWeights,
  type PackRisk,
} from "@/app/(admin)/insights/edge-calc/risk";
import {
  SortableCardTable,
  type SortableCard,
} from "@/app/(admin)/packs/sortable-card-table";

import { BuilderCardPicker } from "../builder/builder-card-picker";
import type { BuilderCardItem } from "../builder/actions";
import {
  getPackEditPool,
  getRetunePickerFilters,
  type EditPool,
  type RetunePickerFilters,
} from "../doctor/retune-actions";

/**
 * Inline card-pool editor for the Bulk Re-tune review. Lets the owner edit ONE
 * pack's pool by hand — re-weight, remove, reorder, and ADD cards — right inside
 * the review card, with a LIVE after-preview + feasibility re-check, then Approve
 * the EXACT pool it shows.
 *
 * It seeds from `getPackEditPool` (a read-only MAIN read of the pack's current
 * pool) when first opened, reuses the Builder's `<SortableCardTable>` (re-weight /
 * remove / reorder) and `<BuilderCardPicker>` (add a card — value + inPacks usage
 * shown), and recomputes the AFTER metrics + risk on every edit via the SAME pure
 * client-safe `computePackRisk` the server scores with. A "Re-shape to targets"
 * button runs the pure `shapeWeights` on the edited values to auto-distribute the
 * odds onto the pack's targets (edge curve + tag win-rate + near-miss).
 *
 * The odds field in the table is a PERCENT (0..100), exactly like the Builder.
 * On Approve the percents are converted to positive-integer weights (the unit
 * `applyPackEdit` writes) by scaling to a common denominator. Approve hands the
 * built `EditPoolInput` to the parent, which calls `applyPackEdit(packId, token,
 * …)` under the review's 2FA token.
 *
 * House-POV coloring (CLAUDE.md): an edge ≥ target is emerald (healthy margin);
 * below target is rose (giving away margin). A no-win pack (no card ≥ price) is
 * INFEASIBLE — adding a card ≥ price flips it feasible and the banner clears
 * instantly. The pure preview mirrors the server math, so what the owner sees is
 * what `applyPackEdit` writes.
 */

/** A row in the editor: identity + value + an editable odds % (display unit). */
type EditRow = SortableCard & {
  /** True for a card pulled in via the picker (not in the live pool). */
  added: boolean;
};

/** The pack targets the "Re-shape to targets" button shapes onto. */
export type EditorTargets = {
  targetEdge: number;
  targetWinRate: number;
  maxWinCap: number | undefined;
  nearMissMin: number;
};

/** Scale a set of odds-% rows to positive-integer weights for `applyPackEdit`. */
function oddsToWeights(odds: number[]): number[] {
  // Work in ten-thousandths of a percent so 0.0001%–100% all become integers,
  // then gcd-reduce. Any zero/negative is floored to 1 (the server requires a
  // positive integer weight per card; an explicit pool has no zero-weight slot).
  const scaled = odds.map((o) =>
    Math.max(1, Math.round((Number.isFinite(o) ? o : 0) * 10000)),
  );
  const g = scaled.reduce((acc, n) => gcd(acc, n), 0) || 1;
  return scaled.map((n) => Math.max(1, Math.round(n / g)));
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0 ? 1 : x;
}

/** Compute the live risk of the edited rows (odds% → weights → engine). */
function previewRisk(rows: EditRow[], price: number): PackRisk | null {
  if (rows.length === 0) return null;
  const weights = oddsToWeights(rows.map((r) => r.odds));
  return computePackRisk({
    cards: rows.map((r, i) => ({ value: r.priceUsd, weight: weights[i]! })),
    price,
  });
}

/** The verbatim edited-pool payload — owner odds become integer weights. */
export type VerbatimApprovePayload = {
  mode: "verbatim";
  cards: {
    cardId: string;
    weight: number;
    color?: string;
    animation?: boolean;
    order: number;
  }[];
  price?: number;
  hasAddedCards: boolean;
};

/** The staged-pool payload — server picks the weights via `shapeWeights`. */
export type AutoTuneApprovePayload = {
  mode: "auto-tune";
  cards: {
    cardId: string;
    color?: string;
    animation?: boolean;
    order: number;
  }[];
  price?: number;
  hasAddedCards: boolean;
  /**
   * Owner opt-in: allow the server to nudge the pack price by up to ±25%
   * around the staged price to land cleaner odds. Defaults to false; only
   * passed to the auto-tune action when the owner explicitly ticks the
   * "Allow price adjustment" checkbox in the editor.
   */
  allowPriceSearch?: boolean;
};

export function PoolEditor({
  packId,
  price: packPrice,
  targets,
  applying,
  onCancel,
  onApprove,
  onApproveAutoTune,
}: {
  packId: string;
  /** The pack's current price (USD) — the editable starting price. */
  price: number;
  /** Targets for the "Re-shape to targets" auto-distribute button. */
  targets: EditorTargets;
  applying: boolean;
  onCancel: () => void;
  /**
   * Approve the VERBATIM edited pool (advanced — writes the owner's exact
   * weights). `cards` carries every row (cardId + odds% + color + animation +
   * order); the parent converts to weights and calls `applyPackEdit`. `price`
   * is included only when the owner changed it.
   */
  onApprove: (payload: VerbatimApprovePayload) => void;
  /**
   * Approve the STAGED pool with server-side auto-tune (the safe path). The
   * server runs `shapeWeights` on the staged identity/order + price + targets
   * and writes optimized weights in ONE transaction. No client odds are sent.
   */
  onApproveAutoTune: (payload: AutoTuneApprovePayload) => void;
}) {
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<EditRow[]>([]);
  const [priceText, setPriceText] = React.useState(String(packPrice));
  const [reshaping, setReshaping] = React.useState(false);
  // Owner opt-in: when checked, the auto-tune action sends `allowPriceSearch`
  // so the server may nudge the pack price by up to ±25% around the staged
  // price to land cleaner odds. Default OFF so today's behavior is unchanged.
  const [allowPriceSearch, setAllowPriceSearch] = React.useState(false);

  // Card-picker filters, loaded lazily on first open (server action).
  const [filters, setFilters] = React.useState<RetunePickerFilters | null>(null);

  // Seed the editor from a fresh read of the pack's current pool on first open.
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const [pool, picker] = await Promise.all([
          getPackEditPool(packId),
          getRetunePickerFilters(),
        ]);
        if (cancelled) return;
        setRows(seedRows(pool));
        setPriceText(String(pool.price));
        setFilters(picker);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load the pack pool.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [packId]);

  const price = (() => {
    const n = parseFloat(priceText);
    return Number.isFinite(n) && n > 0 ? n : packPrice;
  })();
  const priceValid = (() => {
    const n = parseFloat(priceText.trim());
    return Number.isFinite(n) && n > 0;
  })();
  const priceChanged = Math.abs(price - packPrice) > 1e-9;

  const after = React.useMemo(() => previewRisk(rows, price), [rows, price]);
  const hasWinCard = rows.some((r) => r.priceUsd >= price);
  const feasible = rows.length > 0 && hasWinCard && after != null;
  const hasAddedCards = rows.some((r) => r.added);

  // Live sum of the per-card odds-% inputs. Mirrors `approve`'s pre-scale view
  // (`rows.map((r) => r.odds)`) so what the owner sees matches what
  // `oddsToWeights` then turns into the integer weights for `applyPackEdit`.
  // The auto-retune renormalizes, but inputs should sum to ~100% so the owner
  // can reason about each row as a true probability.
  const oddsTotal = React.useMemo(
    () =>
      rows.reduce((s, r) => s + (Number.isFinite(r.odds) ? r.odds : 0), 0),
    [rows],
  );

  // ── Table handlers (mirror the Builder) ─────────────────────────────
  const onReorder = React.useCallback((next: SortableCard[]) => {
    setRows((prev) => {
      const byId = new Map(prev.map((r) => [r.cardId, r]));
      return next.map((c) => byId.get(c.cardId)!).filter(Boolean) as EditRow[];
    });
  }, []);

  const updateCard = React.useCallback(
    (index: number, updates: Partial<SortableCard>) => {
      setRows((prev) =>
        prev.map((r, i) => (i === index ? { ...r, ...updates } : r)),
      );
    },
    [],
  );

  const removeCard = React.useCallback((index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addCard = React.useCallback((item: BuilderCardItem) => {
    setRows((prev) => {
      if (prev.some((r) => r.cardId === item.id)) return prev;
      // Insert the new card and re-sort by price DESC so the pool stays
      // ordered most-expensive-first regardless of pick order. The Builder's
      // table reads top-down, so a $0.72 add lands above a $0.08 dust card
      // and below an $810 jackpot — never appended to the bottom.
      return sortByPriceDesc([
        ...prev,
        {
          cardId: item.id,
          name: item.name,
          imageUrl: item.imageUrl,
          priceUsd: item.priceUsd,
          // A sensible default odds so the new card has presence; the owner
          // can re-weight or run "Re-shape to targets".
          odds: 1,
          color: null,
          animation: false,
          added: true,
        },
      ]);
    });
  }, []);

  // ── Re-shape to targets (pure shapeWeights on the edited values) ─────
  const reshape = React.useCallback(() => {
    if (rows.length === 0) return;
    setReshaping(true);
    try {
      const shaped = shapeWeights({
        cards: rows.map((r) => ({ value: r.priceUsd })),
        price,
        targetEdge: targets.targetEdge,
        targetWinRate: targets.targetWinRate,
        maxWinCap: targets.maxWinCap,
        nearMissMin: targets.nearMissMin,
      });
      if ("error" in shaped) {
        toast.error(shaped.limit?.detail ?? shaped.error);
        return;
      }
      // Convert the shaped integer weights to odds % (share of total · 100).
      const total = shaped.weights.reduce((s, w) => s + w, 0) || 1;
      setRows((prev) =>
        prev.map((r, i) => ({
          ...r,
          odds:
            Math.round(((shaped.weights[i]! / total) * 100) * 10000) / 10000,
        })),
      );
      const relaxed = shaped.relaxations.length;
      toast.success(
        relaxed > 0
          ? `Re-shaped to targets (${relaxed} soft target${relaxed === 1 ? "" : "s"} relaxed to stay feasible).`
          : "Re-shaped the odds onto the pack's targets.",
      );
    } finally {
      setReshaping(false);
    }
  }, [rows, price, targets]);

  // ── Approve the explicit edited pool (VERBATIM — advanced) ───────────
  const approve = React.useCallback(() => {
    if (!feasible || !priceValid || applying) return;
    const weights = oddsToWeights(rows.map((r) => r.odds));
    onApprove({
      mode: "verbatim",
      cards: rows.map((r, i) => ({
        cardId: r.cardId,
        weight: weights[i]!,
        color: r.color ?? undefined,
        animation: r.animation,
        order: i,
      })),
      price: priceChanged ? price : undefined,
      hasAddedCards,
    });
  }, [
    feasible,
    priceValid,
    applying,
    rows,
    onApprove,
    priceChanged,
    price,
    hasAddedCards,
  ]);

  // ── Approve via AUTO-TUNE (SAFE PATH — server shapes weights) ────────
  const approveAutoTune = React.useCallback(() => {
    if (!feasible || !priceValid || applying) return;
    onApproveAutoTune({
      mode: "auto-tune",
      cards: rows.map((r, i) => ({
        cardId: r.cardId,
        color: r.color ?? undefined,
        animation: r.animation,
        order: i,
      })),
      price: priceChanged ? price : undefined,
      hasAddedCards,
      ...(allowPriceSearch ? { allowPriceSearch: true } : {}),
    });
  }, [
    feasible,
    priceValid,
    applying,
    rows,
    onApproveAutoTune,
    priceChanged,
    price,
    hasAddedCards,
    allowPriceSearch,
  ]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-muted/10 px-3 py-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading the pack pool…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-3 text-xs text-rose-600 dark:text-rose-400">
        <div className="flex items-start gap-2">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{loadError}</span>
        </div>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Close editor
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/10 p-3">
      {/* Price + add card */}
      <div className="grid gap-3 sm:grid-cols-[160px_1fr] sm:items-end">
        <div className="space-y-1.5">
          <Label
            htmlFor={`edit-price-${packId}`}
            className="flex items-center gap-1.5 text-xs"
          >
            Pack price ($)
            <InfoHint text="The ticket price. Cards worth at least this are win/profit cards; a pack with no card ≥ price can't be retuned (no-win). Changing the price re-evaluates win cards + feasibility live." />
          </Label>
          <Input
            id={`edit-price-${packId}`}
            type="number"
            step="0.01"
            min="0"
            value={priceText}
            onChange={(e) => setPriceText(e.target.value)}
            aria-invalid={!priceValid}
            className="h-8"
          />
        </div>
        {filters && (
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-xs">
              Add a card
              <InfoHint text="Pull a card into the pool — its value + how many packs already use it are shown. To fix a no-win pack, add a card worth at least the pack price." />
            </Label>
            <BuilderCardPicker
              selectedIds={rows.map((r) => r.cardId)}
              onSelect={addCard}
              sets={filters.sets}
              rarities={filters.rarities}
              price={price}
            />
          </div>
        )}
      </div>

      {/* Live total of the per-card odds inputs (mirrored above the action
          buttons below). Owner sets these by hand; renormalization happens on
          apply, but a visible total prevents accidental 102% / 98% mistakes. */}
      <OddsTotalChip total={oddsTotal} hasRows={rows.length > 0} />

      {/* Live AFTER preview + feasibility */}
      <EditorPreview after={after} price={price} targetEdge={targets.targetEdge} />

      {!feasible && rows.length > 0 && !hasWinCard && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="font-medium">No win cards.</span> Every card is
            worth less than the {formatCurrency(price)} price, so this pool can
            never pay out a profit. Add a card worth at least {formatCurrency(price)}{" "}
            above to make it feasible.
          </span>
        </div>
      )}

      {/* The editable card table (reused from the Builder) */}
      {rows.length > 0 ? (
        <SortableCardTable
          cards={rows}
          onReorder={onReorder}
          updateCard={updateCard}
          removeCard={removeCard}
        />
      ) : (
        <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
          The pool is empty — add at least one card (including one worth ≥ the
          price) to make it a valid pack.
        </p>
      )}

      {/* Mirror of the odds-total chip right above the action buttons, so the
          owner sees the same total regardless of scroll position. */}
      <OddsTotalChip total={oddsTotal} hasRows={rows.length > 0} />

      {/* Price-search opt-in — when checked, the auto-tune action sweeps a
          ±25% price band (cent-stepped) on the server and picks the candidate
          whose `shapeWeights` result lands every card on a clean ladder rung.
          Default off so today's behavior matches; the owner opts in
          explicitly. */}
      <label
        htmlFor={`allow-price-search-${packId}`}
        className="flex cursor-pointer items-start gap-2 rounded-lg border bg-card/40 px-3 py-2"
      >
        <Checkbox
          id={`allow-price-search-${packId}`}
          checked={allowPriceSearch}
          onCheckedChange={(checked) =>
            setAllowPriceSearch(checked === true)
          }
          disabled={applying}
          className="mt-0.5"
        />
        <div className="flex-1 space-y-0.5">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            Allow price adjustment (±25%) for cleaner odds
            <InfoHint text="When ticked, the server may nudge the pack price by up to ±25% (cent-stepped) around the staged price to land every card on a clean odds rung (e.g. 0.01%, 0.1%, 25%). The exact chosen price is shown after the auto-tune runs." />
          </span>
          <p className="text-[11px] text-muted-foreground">
            Auto-tune holds the price by default. Tick this if you&apos;d rather
            the server pick a nearby price that lets the odds snap onto a
            clean ladder.
          </p>
        </div>
      </label>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          size="sm"
          variant="outline"
          onClick={reshape}
          disabled={rows.length === 0 || reshaping || applying}
        >
          {reshaping ? (
            <Loader2 className="mr-1 size-3.5 animate-spin" />
          ) : (
            <Wand2 className="mr-1 size-3.5" />
          )}
          Re-shape to targets
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={onCancel}
            disabled={applying}
          >
            <X className="mr-1 size-3.5" />
            Cancel edit
          </Button>
          {/* VERBATIM (advanced) — outline + warning tooltip. Writes the owner's
              exact odds to MAIN; no shaping. Kept as an escape hatch. */}
          <TooltipProvider delay={150}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={approve}
                    disabled={!feasible || !priceValid || applying}
                  >
                    {applying ? (
                      <Loader2 className="mr-1 size-3.5 animate-spin" />
                    ) : (
                      <Check className="mr-1 size-3.5" />
                    )}
                    Approve edited pool
                  </Button>
                }
              />
              <TooltipContent side="top" className="max-w-xs text-xs">
                Advanced: writes your exact weights verbatim. Does NOT optimize.
                Use Auto-tune for the safe path — it lets the server pick weights
                that clear the pack&apos;s targets.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {/* AUTO-TUNE (PRIMARY, safe path) — server runs shapeWeights on the
              staged identity + targets and writes optimized weights. Rose tint
              signals "prod write" (same tone the confirm gate uses). */}
          <Button
            size="sm"
            onClick={approveAutoTune}
            disabled={!feasible || !priceValid || applying}
            className="bg-rose-600 text-white hover:bg-rose-600/90 dark:bg-rose-600 dark:hover:bg-rose-600/90"
          >
            {applying ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1 size-3.5" />
            )}
            Auto-tune &amp; push to production
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Seed the editable rows from a fresh `getPackEditPool` read. */
function seedRows(pool: EditPool): EditRow[] {
  const total = pool.cards.reduce(
    (s, c) => s + (c.weight > 0 ? c.weight : 0),
    0,
  );
  // Sort by price DESC on seed too, so the initial view matches the invariant
  // the editor enforces from here on out (and matches what the owner will see
  // after any add). The stored `order` is rewritten on Approve from the row
  // index, so display order = write order = sorted-by-price order.
  return sortByPriceDesc(
    pool.cards.map((c) => ({
      cardId: c.cardId,
      name: c.name,
      imageUrl: c.imageUrl || null,
      priceUsd: c.value,
      odds:
        total > 0
          ? Math.round(((c.weight / total) * 100) * 10000) / 10000
          : 0,
      color: c.color,
      animation: c.animation,
      added: false,
    })),
  );
}

/**
 * Sort the editor rows by card price DESCENDING — most expensive at index 0,
 * cheapest at the end. Used for the initial seed AND every time a card is
 * added, so the pool always reads top-down from jackpot to dust. Stable on
 * ties (preserves insertion order) so the owner's manual reordering of equal-
 * priced cards isn't shuffled. Not used in `onReorder` — manual DnD overrides
 * the price sort intentionally, so the owner can still hand-place same-price
 * variants. New adds go through this helper, so a fresh pick always lands in
 * its price-sorted position rather than being appended to the bottom.
 */
function sortByPriceDesc<T extends { priceUsd: number }>(rows: T[]): T[] {
  // Use index-tagged sort for stability — Array#sort isn't guaranteed stable
  // pre-ES2019 in every JS engine, and we lean on stability for equal prices.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (b.r.priceUsd !== a.r.priceUsd) return b.r.priceUsd - a.r.priceUsd;
      return a.i - b.i;
    })
    .map(({ r }) => r);
}

/**
 * Always-visible running total of the per-card odds-% inputs. Rendered TWICE
 * inside the editor (near the top + just above the Approve buttons) so the
 * owner can't miss it regardless of scroll position. Three states:
 *
 * - Exactly 100% (±0.005)    → emerald, check icon — input matches a probability.
 * - Below 100%                → amber, info icon — informational under-total.
 * - Above 100%                → rose, BOLD + LARGER, triangle-alert — over-total,
 *                               the case the owner just hit (102%) without
 *                               noticing. Approve is NOT disabled (the
 *                               auto-retune renormalizes), but the chip makes
 *                               the mistake impossible to miss.
 */
function OddsTotalChip({
  total,
  hasRows,
}: {
  total: number;
  hasRows: boolean;
}) {
  if (!hasRows) return null;
  // ±0.005 tolerance — anything that prints "100.00%" at two decimals counts
  // as exactly 100, so the chip and the displayed number agree.
  const exact = Math.abs(total - 100) <= 0.005;
  const over = !exact && total > 100;
  const tone = exact
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : over
      ? "border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-400"
      : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  const Icon = exact ? Check : over ? TriangleAlert : Info;
  const label = exact
    ? "Total odds match 100%"
    : over
      ? "Over 100% — fix this before approving"
      : "Under 100%";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2",
        tone,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <Icon
          className={cn("shrink-0", over ? "size-4" : "size-3.5")}
          aria-hidden
        />
        <span
          className={cn(
            "tabular-nums",
            over ? "text-base font-bold sm:text-lg" : "text-sm font-semibold",
          )}
        >
          Total odds: {total.toFixed(2)}% / 100%
        </span>
        <span
          className={cn(
            "text-xs font-medium",
            over ? "font-bold uppercase tracking-wider" : "opacity-90",
          )}
        >
          {label}
        </span>
      </div>
      <p className="basis-full text-[11px] opacity-75">
        Odds must sum to 100% — the auto-retune will renormalize, but your
        inputs should reflect what you want.
      </p>
    </div>
  );
}

/** The live AFTER edge + EV/open + win-rate + max-win, animated. House-POV colors. */
function EditorPreview({
  after,
  price,
  targetEdge,
}: {
  after: PackRisk | null;
  price: number;
  targetEdge: number;
}) {
  if (!after) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
        No preview yet — add a card to the pool.
      </div>
    );
  }
  const healthy = after.edge >= targetEdge - 1e-9;
  const edgeTone = healthy
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  // House-POV color for EV: target EV = price · (1 − targetEdge). Below target
  // means the house gives back less than budgeted → emerald (healthy); above
  // target means the house gives back more → rose; equal is neutral. Mirrors
  // the rule "rose = player wins more, emerald = house healthy".
  const targetEv = price * (1 - targetEdge);
  const evDelta = after.ev - targetEv;
  const evTone =
    evDelta < -1e-9
      ? "text-emerald-600 dark:text-emerald-400"
      : evDelta > 1e-9
        ? "text-rose-600 dark:text-rose-400"
        : "";
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      <PreviewTile
        label="House edge"
        valueNode={
          <span className={cn("font-bold", edgeTone)}>
            <AnimatedNumber value={after.edge * 100} format="percent" />
          </span>
        }
        note={`target ${(targetEdge * 100).toFixed(2)}%`}
      />
      <PreviewTile
        label="EV / open"
        valueNode={
          <span className={cn("font-bold", evTone)}>
            <AnimatedNumber value={after.ev} format="currency" />
          </span>
        }
        note={`${formatCurrency(targetEv)} target at ${(targetEdge * 100).toFixed(2)}% edge`}
      />
      <PreviewTile
        label="Win rate"
        valueNode={
          <span className="font-bold text-rose-600 dark:text-rose-400">
            <AnimatedNumber value={after.winRate * 100} format="percent" />
          </span>
        }
        note="share of profit opens"
      />
      <PreviewTile
        label="Max win"
        valueNode={
          <span className="font-bold text-rose-600 dark:text-rose-400">
            <AnimatedNumber value={after.maxWin} format="currency" />
          </span>
        }
        note={`${after.maxMult.toFixed(1)}× price`}
      />
      <PreviewTile
        label="Tier"
        valueNode={
          <Badge
            variant="outline"
            className="h-5 px-1.5 text-[10px] font-semibold"
          >
            {after.tier}
          </Badge>
        }
        note={`CV ${after.cv.toFixed(2)} · price ${formatCurrency(price)}`}
      />
    </div>
  );
}

function PreviewTile({
  label,
  valueNode,
  note,
}: {
  label: string;
  valueNode: React.ReactNode;
  note: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-2.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 flex items-center gap-1 text-lg tabular-nums">
        {valueNode}
      </p>
      <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
        <ArrowRight className="size-2.5" />
        {note}
      </p>
    </div>
  );
}
