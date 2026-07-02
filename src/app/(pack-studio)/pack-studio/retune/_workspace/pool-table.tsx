"use client";

import * as React from "react";
import { Check, Info, Lock, LockOpen, Plus, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { BuilderCardPicker } from "../../builder/builder-card-picker";
import type { BuilderCardItem } from "../../builder/actions";
import type { RetunePickerFilters } from "../../doctor/retune-actions";
import { PRICE_INPUT_HINT } from "./plan-copy";
import { CardDiffTable, type CardDiffRow } from "./card-diff-table";

/**
 * Retune V2 staged pool table — the operator's edit surface for ONE pack:
 * add/remove cards, cosmetics, ticket price, and the rare pin-price escape
 * hatch. The rows render through the SAME `CardDiffTable` the push confirm
 * uses (one renderer). NO editable odds column and NO drag-reorder: staged
 * `order` = row index at push time, the display sort is value-DESC (a view
 * sort, never written), and hand-typed odds live in the Drafts flow.
 */

/**
 * Auto-pick color + animation for a new pack_card, mirroring the convention
 * used by existing cards (derived from live pack_cards data, 2026-06-22).
 *
 * Rule of thumb: color is a function of card_value / pack_price. The thresholds
 * below match the medians of each color band in production and reproduce ~80–90%
 * of curated cards exactly; the rest are off-by-one tier, matching the same
 * curator-tolerance the existing pool exhibits.
 *
 *   ratio >= 10  -> gold   (animated)   — top-band jackpot, ~98% animated live
 *   ratio >= 3   -> red    (animated)   — high-value, ~94% animated live
 *   ratio >= 1.5 -> purple                — profitable
 *   ratio >= 0.75 -> blue                 — near-price / break-even
 *   ratio >= 0.2 -> green                 — sub-price
 *   else         -> white                 — dust
 *
 * Animation = true iff color is gold or red (rule of thumb from the audit;
 * other colors are animated <2% of the time live, so always-false is the
 * convention-matching default for the lower tiers).
 *
 * Guard: a non-finite or non-positive price -> white/false (safe default that
 * never auto-promotes a card to gold on a degenerate input).
 */
export function autoColorAndAnimation(
  cardValue: number,
  packPrice: number,
): { color: string | null; animation: boolean } {
  if (
    !Number.isFinite(cardValue) ||
    !Number.isFinite(packPrice) ||
    packPrice <= 0
  ) {
    return { color: "white", animation: false };
  }
  const ratio = cardValue / packPrice;
  if (ratio >= 10) return { color: "gold", animation: true };
  if (ratio >= 3) return { color: "red", animation: true };
  if (ratio >= 1.5) return { color: "purple", animation: false };
  if (ratio >= 0.75) return { color: "blue", animation: false };
  if (ratio >= 0.2) return { color: "green", animation: false };
  return { color: "white", animation: false };
}

/** Human-readable summary of an auto-pick, used for the inline hint. */
export function describeAutoPick(color: string | null, animation: boolean): string {
  const colorLabel = color ?? "none";
  const band =
    color === "gold"
      ? "top-band jackpot"
      : color === "red"
        ? "high-value win"
        : color === "purple"
          ? "profitable"
          : color === "blue"
            ? "near-price"
            : color === "green"
              ? "sub-price"
              : "dust";
  return `Auto: ${colorLabel}${animation ? " + animated" : ""} (${band})`;
}

/**
 * Odds-total chip — moved verbatim from the retired `pool-editor.tsx`. Over
 * the PLANNED odds when a plan exists (always 100.00% → emerald); over the
 * live odds in preview. The renormalize affordance belongs to the Drafts
 * verbatim flow the chip's sub-copy references (linked from the header).
 */
function OddsTotalChip({
  total,
  hasRows,
  onRenormalize,
  disabled,
}: {
  total: number;
  hasRows: boolean;
  /** Rescales every row's odds by 100/total, visibly, into the inputs. */
  onRenormalize: () => void;
  disabled: boolean;
}) {
  if (!hasRows) return null;
  // ±0.005 tolerance — anything that prints "100.00%" at two decimals counts
  // as exactly 100, so the chip and the displayed number agree. MUST match
  // the `oddsExact` gate on the verbatim Approve.
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
      ? "Over 100% — verbatim approve blocked"
      : "Under 100% — verbatim approve blocked";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2",
        tone,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2">
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
        {!exact && (
          <button
            type="button"
            onClick={onRenormalize}
            disabled={disabled}
            className="rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
            title="Rescale every row by 100 ÷ total so the odds sum to exactly 100% — the same rescale a verbatim write would otherwise apply silently, made visible in the inputs first."
          >
            Renormalize to 100%
          </button>
        )}
      </div>
      <p className="basis-full text-[11px] opacity-75">
        {exact ? (
          <>
            Verbatim (&quot;Approve edited pool&quot;) writes each row exactly
            as typed. Auto-tune re-shapes the odds from scratch — your typed
            odds don&apos;t bind it.
          </>
        ) : (
          <>
            Verbatim approve stays blocked until the total is exactly 100% —
            it writes each row as typed, and an off-total would silently
            rescale every odd (2.5% → 2.45% at 102%). Renormalize above to
            apply that rescale visibly, or fix the rows. Auto-tune is
            unaffected — the server re-shapes the odds from scratch.
          </>
        )}
      </p>
    </div>
  );
}

export function PoolTable({
  rows,
  contextPrice,
  oddsTotal,
  autoHintByCardId,
  priceText,
  pinPrice,
  disabled,
  pickerOpen,
  pickerRange,
  pickerFilters,
  pickerSelectedIds,
  onPickerOpenChange,
  onPickCard,
  onRemove,
  onUndoRemove,
  onColorChange,
  onAnimationChange,
  onPriceTextChange,
  onPriceCommit,
  onPinToggle,
  onOpenPicker,
}: {
  rows: CardDiffRow[];
  /** Ticket price the win-band coloring is judged against. */
  contextPrice: number;
  /** Sum of the odds column shown (planned when a plan exists, else live). */
  oddsTotal: number;
  autoHintByCardId: Map<string, string>;
  priceText: string;
  pinPrice: boolean;
  /** Blocks edits while a push is in flight. */
  disabled: boolean;
  pickerOpen: boolean;
  pickerRange: { min?: number; max?: number } | null;
  pickerFilters: RetunePickerFilters | null;
  pickerSelectedIds: string[];
  onPickerOpenChange: (open: boolean) => void;
  onPickCard: (card: BuilderCardItem) => void;
  onRemove: (cardId: string) => void;
  onUndoRemove: (cardId: string) => void;
  onColorChange: (cardId: string, color: string | null) => void;
  onAnimationChange: (cardId: string, animation: boolean) => void;
  onPriceTextChange: (text: string) => void;
  /** Enter/blur — commit the typed price immediately (flushes the debounce). */
  onPriceCommit: () => void;
  onPinToggle: () => void;
  onOpenPicker: () => void;
}) {
  return (
    <div className="space-y-3">
      <CardDiffTable
        rows={rows}
        contextPrice={contextPrice}
        editable
        autoHintByCardId={autoHintByCardId}
        onRemove={disabled ? undefined : onRemove}
        onUndoRemove={disabled ? undefined : onUndoRemove}
        onColorChange={disabled ? undefined : onColorChange}
        onAnimationChange={disabled ? undefined : onAnimationChange}
      />

      <OddsTotalChip
        total={oddsTotal}
        hasRows={rows.some((r) => !r.removed)}
        // The workspace has no editable odds inputs to rescale — the chip is
        // informational here (planned/live odds always sum to 100%); the
        // renormalize affordance lives with the Drafts verbatim editor.
        onRenormalize={() => {}}
        disabled
      />

      <div className="flex flex-wrap items-end gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenPicker}
          disabled={disabled}
        >
          <Plus className="size-3.5" />
          Add cards
        </Button>

        <div className="min-w-0">
          <Label
            htmlFor="retune-price"
            className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
          >
            Price ($)
          </Label>
          <Input
            id="retune-price"
            type="text"
            inputMode="decimal"
            value={priceText}
            disabled={disabled}
            className="mt-1 h-8 w-28 text-sm tabular-nums"
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "" || /^\d*\.?\d{0,2}$/.test(raw)) {
                onPriceTextChange(raw);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") onPriceCommit();
            }}
            onBlur={onPriceCommit}
          />
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onPinToggle}
          disabled={disabled}
          aria-pressed={pinPrice}
          title="Pin the ticket price — the planner solves odds-only at this exact price instead of searching the band. Rare escape hatch; the search is the default."
          className={cn(
            pinPrice && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
          )}
        >
          {pinPrice ? (
            <Lock className="size-3.5" />
          ) : (
            <LockOpen className="size-3.5" />
          )}
          {pinPrice ? "Price pinned" : "Pin price"}
        </Button>

        <p className="basis-full text-[11px] text-muted-foreground">
          {pinPrice
            ? "Pinned — the planner keeps this exact price and shapes odds only."
            : PRICE_INPUT_HINT}
        </p>
      </div>

      {pickerFilters && (
        <BuilderCardPicker
          selectedIds={pickerSelectedIds}
          onSelect={onPickCard}
          sets={pickerFilters.sets}
          rarities={pickerFilters.rarities}
          price={contextPrice}
          open={pickerOpen}
          onOpenChange={onPickerOpenChange}
          initialPriceMin={pickerRange?.min}
          initialPriceMax={pickerRange?.max}
        />
      )}
    </div>
  );
}
