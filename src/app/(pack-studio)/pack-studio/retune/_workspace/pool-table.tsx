"use client";

import * as React from "react";
import {
  Check,
  Info,
  Loader2,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { BuilderCardPicker } from "../../builder/builder-card-picker";
import type { BuilderCardItem } from "../../builder/actions";
import type { RetunePickerFilters } from "../../doctor/retune-actions";
import {
  PENDING_APPLY,
  PENDING_DISCARD,
  PENDING_EDITS_NOTE,
  PENDING_EDITS_OFF_HUNDRED_NOTE,
  PREFLIGHT_CHECKING,
  PREFLIGHT_ERROR_LINE,
  PRICE_INPUT_HINT,
  pendingEditsLabel,
  preflightSuccessLine,
} from "./plan-copy";
import type { PendingPreflightView, RemedyChip } from "./plan-state";
import {
  isWholeTicketPct,
  TICKETS_PER_PACK,
  ticketsFromPct,
} from "./odds-grid";
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
 * "Exactly 100%" tolerance. Odds are entered to at most 4 decimals, so a sum
 * that is mathematically 100 lands within float noise (~1e-10). Anything looser
 * (the old ±0.005) let a REAL 100.005% total print as "100.00%" and claim
 * "match 100%" — the readout lied. A true 100% total is exact to this epsilon;
 * a 0.005pp overage (5000× this) is now correctly flagged, not hidden.
 */
const ODDS_EXACT_EPS = 1e-6;

/** True only when the odds sum is genuinely 100% (within float noise). */
function oddsExactlyHundred(total: number): boolean {
  return Math.abs(total - 100) < ODDS_EXACT_EPS;
}

/**
 * TRUTHFUL odds-% readout: up to 4 decimals with trailing zeros trimmed, so a
 * 100.005% total shows as "100.005%" (never rounded to a misleading "100.00%").
 * An exact total shows as "100%".
 */
function fmtOddsPct(total: number): string {
  return `${Number(total.toFixed(4))}`;
}

/** The signed gap vs 100, e.g. "over by 0.005pp" / "under by 0.02pp". */
function fmtOddsGap(total: number): string {
  const d = total - 100;
  const mag = Number(Math.abs(d).toFixed(4));
  return `${d > 0 ? "over" : "under"} by ${mag}pp`;
}

/** The signed % gap vs 100 at full precision — trailing zeros trimmed, never
 *  rounded to "0" while a real gap exists (the exactness eps is 1e-6). */
function fmtGapPct(gap: number): string {
  return String(Number(Math.abs(gap).toFixed(6)));
}

/**
 * Total-odds truth strip — LIVE against the CURRENT edit buffer, not the last
 * landed plan: the % total sums exactly what the Planned-% column shows
 * (a pending typed value overrides its row; untouched rows carry the plan's
 * display-reconciled pct), and the tickets total sums the integer per-100k
 * tickets those values mean (0.001% = 1 ticket). Emerald ONLY when the %
 * total is exactly 100 (±1e-6) AND the tickets sum to exactly 100,000 whole
 * tickets — a fractional-ticket typed value or an incomplete vector can never
 * read as OK, and an off total always prints its true gap (never rounded
 * away). Muted "waiting" state while no planned values exist yet, so the
 * strip never claims anything during a cold load / re-plan.
 */
function OddsTotalStrip({
  pctTotal,
  hasValues,
  tickets,
  ticketsKnown,
  wholeTickets,
  hasRows,
}: {
  /** Sum of the effective displayed Planned-% column (typed + planned). */
  pctTotal: number;
  /** At least one row carries a displayable planned/typed pct. */
  hasValues: boolean;
  /** Sum of the per-row integer tickets (the same numbers the rows show). */
  tickets: number;
  /** Every active row carried a typed/plan pct — the ticket sum is complete. */
  ticketsKnown: boolean;
  /** Every summed pct sits on a whole ticket (pct·1000 integer). */
  wholeTickets: boolean;
  hasRows: boolean;
}) {
  if (!hasRows) return null;
  if (!hasValues) {
    return (
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <Info className="size-3.5 shrink-0" aria-hidden />
        <span className="text-sm font-medium tabular-nums">Total —%</span>
        <span className="text-xs">waiting for the plan…</span>
      </div>
    );
  }
  // EXACT means genuinely 100% (float noise only) — a 100.005% total must
  // never masquerade as "match". Same eps as the pending bar.
  const exact = oddsExactlyHundred(pctTotal);
  const ticketsExact =
    ticketsKnown && wholeTickets && tickets === TICKETS_PER_PACK;
  const ok = exact && ticketsExact;
  const Icon = ok ? Check : TriangleAlert;
  const gap = pctTotal - 100;
  const ticketsTitle = !ticketsKnown
    ? "Some rows have no planned value yet — the ticket sum is incomplete."
    : !wholeTickets
      ? "A typed chance falls between whole tickets (0.001% = 1 ticket) — the engine writes whole tickets, so these numbers are rounded."
      : tickets === TICKETS_PER_PACK
        ? "Every ticket accounted for — the write sums to exactly 100,000."
        : "The true ticket sum — it must be exactly 100,000 to be clean.";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2",
        ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      )}
      role="status"
      aria-live="polite"
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="text-sm font-semibold tabular-nums">
        {/* When off, print the full-precision total so "100" never shows
            while the real sum is 99.99995. */}
        Total {exact ? fmtOddsPct(pctTotal) : String(Number(pctTotal.toFixed(6)))}%
      </span>
      {!exact && (
        <span className="text-xs font-medium">
          {gap > 0 ? `over by ${fmtGapPct(gap)}%` : `${fmtGapPct(gap)}% missing`}
        </span>
      )}
      <span
        className={cn("text-xs tabular-nums", ok ? "opacity-80" : "font-medium")}
        title={ticketsTitle}
      >
        {ticketsKnown ? formatNumber(tickets) : "—"} /{" "}
        {formatNumber(TICKETS_PER_PACK)} tk
      </span>
    </div>
  );
}

/**
 * Remedy chips — the ONE renderer for "here's how to fix it" chips (fed by
 * the plan's verified guidance suggestions AND the verdict's solver-verified
 * pin remedies). Display-only by default: the short label carries the kind,
 * the full plain-words copy rides the title. With `onApply` (wave 5, the
 * plan-panel pin remedies) every chip becomes a one-click apply button —
 * `onApply` receives the chip's INDEX (chip order ≡ source remedy order).
 * The pending-bar call site stays display-only: its chips describe fixes for
 * the un-applied typed buffer, which Apply/Discard owns.
 */
export function RemedyChips({
  chips,
  onApply,
}: {
  chips: RemedyChip[];
  onApply?: (index: number) => void;
}) {
  if (chips.length === 0) return null;
  const chipClass =
    "rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300";
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {chips.map((c, i) =>
        onApply ? (
          <button
            key={c.key}
            type="button"
            title={c.detail ? `${c.detail} Click to apply — re-plans immediately.` : undefined}
            onClick={() => onApply(i)}
            className={`${chipClass} cursor-pointer transition-colors hover:bg-amber-500/25`}
          >
            {c.label}
          </button>
        ) : (
          <span key={c.key} title={c.detail} className={chipClass}>
            {c.label}
          </span>
        ),
      )}
    </span>
  );
}

/**
 * Pending-edits action bar (§ "edit several % before saving"). Appears only
 * when the buffer is non-empty. It reports the count, shows the live total-%
 * the pending+committed odds would land at, and offers the two batch actions:
 * APPLY commits every buffered edit as a pin in ONE re-plan; DISCARD drops the
 * whole buffer with no re-plan. Amber, matching the pending cell styling.
 *
 * `preflight` is the debounced dry-run verdict for the CURRENT buffer (would
 * these odds solve?): spinner while checking, emerald success line, rose
 * refusal with remedy chips, muted line when the check itself failed. Purely
 * informational — it never blocks typing, Apply, or Discard.
 */
function PendingEditsBar({
  count,
  pendingTotal,
  preflight,
  onApply,
  onDiscard,
  disabled,
}: {
  count: number;
  /** Total odds % across the pending+committed set (see `pendingOddsTotal`). */
  pendingTotal: number;
  preflight: PendingPreflightView | null;
  onApply: () => void;
  onDiscard: () => void;
  disabled: boolean;
}) {
  if (count === 0) return null;
  // Genuinely 100% (float noise only) — a 100.005% typed total is NOT "exact"
  // and must not print as "100.00%". See {@link oddsExactlyHundred}.
  const exact = oddsExactlyHundred(pendingTotal);
  const totalTone = exact
    ? "text-emerald-600 dark:text-emerald-400"
    : pendingTotal > 100
      ? "text-rose-600 dark:text-rose-400"
      : "text-amber-600 dark:text-amber-400";
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <Pencil
          className="size-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <span className="text-sm font-semibold text-amber-700 dark:text-amber-300">
          {pendingEditsLabel(count)}
        </span>
      </div>
      <span className={cn("text-xs font-medium tabular-nums", totalTone)}>
        Total odds: {fmtOddsPct(pendingTotal)}% / 100%
        {!exact && ` — ${fmtOddsGap(pendingTotal)}`}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDiscard}
          disabled={disabled}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
          {PENDING_DISCARD}
        </Button>
        <Button type="button" size="sm" onClick={onApply} disabled={disabled}>
          <Check className="size-3.5" />
          {PENDING_APPLY}
        </Button>
      </div>
      <p className="basis-full text-[11px] text-amber-700/80 dark:text-amber-300/80">
        {exact ? PENDING_EDITS_NOTE : PENDING_EDITS_OFF_HUNDRED_NOTE}
      </p>
      {preflight !== null && (
        <div className="basis-full">
          {preflight.status === "loading" ? (
            <p className="flex items-center gap-1.5 text-[11px] text-amber-700/80 dark:text-amber-300/80">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              {PREFLIGHT_CHECKING}
            </p>
          ) : preflight.status === "error" ? (
            <p className="text-[11px] text-muted-foreground">
              {PREFLIGHT_ERROR_LINE}
            </p>
          ) : preflight.feasible ? (
            <p
              className={cn(
                "text-[11px] font-medium",
                preflight.edgePct < preflight.targetEdgePct - 1e-9
                  ? "text-rose-600 dark:text-rose-400"
                  : "text-emerald-600 dark:text-emerald-400",
              )}
            >
              {preflight.edgePct < preflight.targetEdgePct - 1e-9
                ? `These odds solve at ${formatCurrency(preflight.priceAfter)} · edge ${preflight.edgePct.toFixed(2)}% — below the ${preflight.targetEdgePct.toFixed(2)}% target. Apply anyway and raise the edge after, or adjust your odds.`
                : preflightSuccessLine(preflight.priceAfter, preflight.edgePct)}
            </p>
          ) : (
            <div className="space-y-1">
              <p className="text-[11px] font-medium text-rose-600 dark:text-rose-400">
                {preflight.detail}
              </p>
              {/* `limit.suggestion` renders as-is ONLY when guidance shipped
                  no verified suggestions — guidance chips lead otherwise. */}
              {preflight.chips.length > 0 ? (
                <RemedyChips chips={preflight.chips} />
              ) : preflight.suggestion !== null ? (
                <p className="text-[11px] text-rose-600/80 dark:text-rose-400/80">
                  {preflight.suggestion}
                </p>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PoolTable({
  rows,
  contextPrice,
  autoHintByCardId,
  priceText,
  pinPrice,
  disabled,
  pendingCount,
  pendingPreflight,
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
  onPendingEdit,
  onPendingClear,
  onPinClear,
  onApplyPending,
  onDiscardPending,
  onPriceTextChange,
  onPriceCommit,
  onPinToggle,
  onOpenPicker,
  onMoveCard,
}: {
  rows: CardDiffRow[];
  /** Ticket price the win-band coloring is judged against. */
  contextPrice: number;
  autoHintByCardId: Map<string, string>;
  priceText: string;
  pinPrice: boolean;
  /** Blocks edits while a push is in flight. */
  disabled: boolean;
  /** Number of typed-but-not-yet-applied edits in the buffer (0 hides the bar). */
  pendingCount: number;
  /** Debounced dry-run verdict for the pending buffer (display-only). */
  pendingPreflight: PendingPreflightView | null;
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
  /** Buffer a typed Planned % edit (no re-plan) — Enter/Tab advance. */
  onPendingEdit: (cardId: string, pct: number) => void;
  /** Drop one card's pending (not-yet-applied) edit. */
  onPendingClear: (cardId: string) => void;
  /** Clear a card's already-committed pin (the pin chip's X). */
  onPinClear: (cardId: string) => void;
  /** Commit ALL pending edits as pins → exactly one re-plan. */
  onApplyPending: () => void;
  /** Drop the whole pending buffer — no re-plan. */
  onDiscardPending: () => void;
  onPriceTextChange: (text: string) => void;
  /** Enter/blur — commit the typed price immediately (flushes the debounce). */
  onPriceCommit: () => void;
  onPinToggle: () => void;
  onOpenPicker: () => void;
  /** Move a card one step up/down in the display order (sets pack_cards.order). */
  onMoveCard: (cardId: string, direction: "up" | "down") => void;
}) {
  // The LIVE effective odds vector — exactly what the Planned-% column shows:
  // a pending typed value overrides its row, untouched rows carry the plan's
  // display-reconciled pct. Tickets ride the TRUE pcts (typed values / raw
  // plan pcts), so per-row rounding can never hide an overrun in the total
  // (owner hard rule: never lie about the ticket amount).
  const totals = React.useMemo(() => {
    let pct = 0;
    let hasValues = false;
    let tickets = 0;
    let wholeTickets = true;
    let sawTicket = false;
    let missingTicket = false;
    for (const r of rows) {
      if (r.removed || r.capRemovedUsd !== null) continue;
      const shownPct = r.pendingPct ?? r.displayPct;
      if (shownPct !== null) {
        pct += shownPct;
        hasValues = true;
      }
      const truePct = r.pendingPct ?? r.plannedPct;
      if (truePct === null) {
        missingTicket = true;
      } else {
        tickets += ticketsFromPct(truePct);
        if (!isWholeTicketPct(truePct)) wholeTickets = false;
        sawTicket = true;
      }
    }
    return {
      pct,
      hasValues,
      tickets,
      ticketsKnown: sawTicket && !missingTicket,
      wholeTickets,
    };
  }, [rows]);

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
        onPendingEdit={disabled ? undefined : onPendingEdit}
        onPendingClear={disabled ? undefined : onPendingClear}
        onPinClear={disabled ? undefined : onPinClear}
        onMoveCard={disabled ? undefined : onMoveCard}
      />

      <PendingEditsBar
        count={pendingCount}
        pendingTotal={totals.pct}
        preflight={pendingPreflight}
        onApply={onApplyPending}
        onDiscard={onDiscardPending}
        disabled={disabled}
      />

      <OddsTotalStrip
        pctTotal={totals.pct}
        hasValues={totals.hasValues}
        tickets={totals.tickets}
        ticketsKnown={totals.ticketsKnown}
        wholeTickets={totals.wholeTickets}
        hasRows={rows.some((r) => !r.removed)}
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
          title={
            pinPrice
              ? "Unpin the price — let the planner search the band for clean odds at any candidate price."
              : "Pin the pack price — the planner solves odds-only at this exact price instead of searching the band. Rare escape hatch; the search is the default."
          }
          className={cn(
            pinPrice && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
          )}
        >
          {pinPrice ? (
            <LockOpen className="size-3.5" />
          ) : (
            <Lock className="size-3.5" />
          )}
          {pinPrice ? "Unpin price" : "Pin price"}
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
