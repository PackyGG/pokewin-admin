"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, Pencil, Undo2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AnimatedNumber } from "@/components/animated-number";
import { CardImage } from "@/components/card-image";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { isFloorPinnedPct } from "@/app/(admin)/insights/edge-calc/tag-guidance";
import type { EditPool, PackTunePlan } from "../../doctor/retune-actions";

import { formatDeltaPp, formatPercent } from "../format-percent";
import {
  FLOOR_PIN_CHIP,
  FLOOR_PIN_TOOLTIP,
  CRUSH_CHIP,
  CRUSH_TOOLTIP,
  PIN_CHIP,
  PENDING_EDIT_ARIA,
  PENDING_EDIT_HINT,
  PIN_INPUT_PLACEHOLDER,
  PIN_TOOLTIP,
  capRemovedBadgeLabel,
  capRemovedTooltip,
} from "./plan-copy";
import type { StagedPool } from "./plan-state";

/**
 * THE one per-card diff renderer (D1 steal): thumb · name · value · live% ·
 * planned% · Δpp · added/removed badges · off-ladder amber dot. Rendered by
 * BOTH the workspace pool table (editable: cosmetics + remove/undo) and the
 * push-confirm step 1 (read-only, frozen rows) — one brain, one renderer, so
 * the confirm can never mirror different numbers than the pool shows.
 *
 * NO editable odds column — the staged write ignores typed weights
 * (`StagedPoolInput` has no weight field); an editable column the Push
 * button discards is exactly the V1 dishonesty AUDIT_RETUNE.md documents.
 * Hand-typed odds live in the Drafts flow (`applyPackEdit`).
 */

export type CardDiffRow = {
  cardId: string;
  name: string;
  value: number;
  imageUrl: string;
  /** Current live probability in percent, null for a staged-in (added) card. */
  livePct: number | null;
  /** Planned probability in percent from the plan's after-vector, null = no plan. */
  plannedPct: number | null;
  added: boolean;
  removed: boolean;
  /**
   * Non-null when the plan's cap pre-filter DROPS this card (value > the
   * resolved max-win cap — `plan.capDroppedCardIds`): the value is the cap in
   * USD for the badge copy. Renders like a staged removal (strike-through +
   * rose badge, no odds, no cosmetics), but with the cap reason and WITHOUT
   * an Undo (the way to keep the card is raising the cap, covered by the
   * plan's raise-cap guidance). Pushing omits the row — a true removal.
   */
  capRemovedUsd: number | null;
  /** Planned pct is NOT on the clean ladder (amber dot). */
  offLadder: boolean;
  /**
   * Owner-pinned chance (typed percent) — non-null renders the amber pin
   * chip; the row is EXEMPT from the off-ladder dot (a pin is an owner-chosen
   * number, not a dirty residual).
   */
  pinnedPct: number | null;
  /**
   * PENDING (typed-but-not-yet-applied) chance for this card — non-null renders
   * the amber PENDING style (dashed outline + dot). It has NOT been committed as
   * a pin and has NOT re-planned; Apply promotes the whole buffer to pins at
   * once. Overrides the pinned/planned display in the cell while it exists.
   */
  pendingPct: number | null;
  /**
   * §3.3 crush chip: TRUE when the plan's shape guard flagged this card as
   * crushed (planned odds ≥100x below its live odds — the fixed-pool math parked
   * the mass elsewhere). From `plan.shape.crushedCardIds` — zero client
   * recompute. Renders a "crushed" chip pointing at the recommended pool edit.
   */
  crushed: boolean;
  color: string | null;
  animation: boolean;
};

/** Matches the Builder's card color options (`sortable-card-table.tsx`). */
const CARD_COLORS = [
  { value: "", label: "None" },
  { value: "white", label: "White" },
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
  { value: "purple", label: "Purple" },
  { value: "red", label: "Red" },
  { value: "gold", label: "Gold" },
  { value: "rainbow", label: "Rainbow" },
] as const;

/**
 * Build the diff rows from the staged pool (or the live pool on the live
 * arm) + the last landed plan. Pure — both render sites call this with the
 * same inputs and get the same rows. Display sort is value-DESC (a VIEW
 * sort only — staged solve order is untouched and `order` is assigned from
 * the staged array index at push time, never from this sort).
 */
export function buildCardDiffRows(args: {
  pool: EditPool | null;
  staged: StagedPool | null;
  plan: PackTunePlan | null;
  /**
   * The typed-but-not-yet-applied pending edits for this pack, keyed later by
   * cardId. Optional — the push-confirm frozen render passes none (a frozen
   * artifact never carries a live buffer), so those rows read `pendingPct: null`.
   */
  pending?: { cardId: string; pct: number }[];
}): CardDiffRow[] {
  const { pool, staged, plan } = args;
  const pendingByCard = new Map<string, number>(
    (args.pending ?? []).map((p) => [p.cardId, p.pct]),
  );
  const plannedByCard = new Map<string, { pct: number; livePct: number | null }>();
  if (plan) {
    for (const p of plan.planned) {
      plannedByCard.set(p.cardId, { pct: p.pct, livePct: p.livePct });
    }
  }
  const offLadder = new Set(plan?.offLadderCards ?? []);
  // §3.3: the shape guard's crushed cards (server-computed cardIds — zero
  // recompute). Only a degenerate plan surfaces the chip (a healthy plan may
  // still carry a rare card at legitimately low odds).
  const crushedCards = new Set(
    plan?.shape?.degenerate === true ? plan.shape.crushedCardIds : [],
  );
  // Cap removals: only a FEASIBLE plan's verdict marks rows (an infeasible
  // plan writes nothing, so no row should read "removed").
  const capDropped = new Set(
    plan && plan.feasible ? plan.capDroppedCardIds : [],
  );
  const capUsd = plan ? plan.targets.maxWinCap : null;
  const pinnedByCard = new Map<string, number>(
    (staged?.pinnedOdds ?? []).map((p) => [p.cardId, p.pct]),
  );

  // Live probabilities from the edit pool (fallback when the plan doesn't
  // carry a card — e.g. mid-debounce after an add).
  const liveTotal = pool
    ? pool.cards.reduce((s, c) => s + (c.weight > 0 ? c.weight : 0), 0)
    : 0;
  const livePctOf = (cardId: string): number | null => {
    if (!pool || liveTotal <= 0) return null;
    const row = pool.cards.find((c) => c.cardId === cardId);
    return row ? (row.weight / liveTotal) * 100 : null;
  };

  // Active (non-removed) rows and removed rows are built separately: the
  // display sort applies to the ACTIVE rows only, and removed/cap-removed
  // strike-through rows always trail after them.
  const activeRows: CardDiffRow[] = [];
  const removedRows: CardDiffRow[] = [];
  if (staged) {
    for (const c of staged.cards) {
      const planned = plannedByCard.get(c.cardId);
      const pinnedPct = pinnedByCard.get(c.cardId) ?? null;
      const capRemoved = capDropped.has(c.cardId) && capUsd !== null;
      activeRows.push({
        cardId: c.cardId,
        name: c.name,
        value: c.value,
        imageUrl: c.imageUrl,
        livePct: planned ? planned.livePct : c.added ? null : livePctOf(c.cardId),
        // A cap-removed row renders exactly like a staged removal: no planned
        // odds (the plan's 0 is the drop verdict, not a chance).
        plannedPct: capRemoved ? null : planned ? planned.pct : null,
        added: c.added,
        removed: false,
        capRemovedUsd: capRemoved ? capUsd : null,
        // Pinned rows are exempt (owner-chosen number, never a dirty dot);
        // the server-side offLadderCards already excludes them — this guard
        // covers the brief staged window before the pinned plan lands.
        offLadder: pinnedPct === null && offLadder.has(c.cardId),
        pinnedPct,
        // A cap-removed row can't hold a pending edit (it's a removal, not a
        // chance); otherwise the pending buffer overrides the cell.
        pendingPct: capRemoved ? null : (pendingByCard.get(c.cardId) ?? null),
        crushed: !capRemoved && crushedCards.has(c.cardId),
        color: c.color,
        animation: c.animation,
      });
    }
    for (const c of staged.removed) {
      removedRows.push({
        cardId: c.cardId,
        name: c.name,
        value: c.value,
        imageUrl: c.imageUrl,
        livePct: livePctOf(c.cardId),
        plannedPct: null,
        added: false,
        removed: true,
        capRemovedUsd: null,
        offLadder: false,
        pinnedPct: null,
        pendingPct: null,
        crushed: false,
        color: c.color,
        animation: c.animation,
      });
    }
  } else if (pool) {
    for (const c of pool.cards) {
      const planned = plannedByCard.get(c.cardId);
      const capRemoved = capDropped.has(c.cardId) && capUsd !== null;
      activeRows.push({
        cardId: c.cardId,
        name: c.name,
        value: c.value,
        imageUrl: c.imageUrl,
        livePct: planned ? planned.livePct : livePctOf(c.cardId),
        // Same rule as the staged arm: a cap-removed row carries no planned
        // odds — the drop verdict renders as a removal, not a 0% chance.
        plannedPct: capRemoved ? null : planned ? planned.pct : null,
        added: false,
        removed: false,
        capRemovedUsd: capRemoved ? capUsd : null,
        offLadder: offLadder.has(c.cardId),
        pinnedPct: null,
        pendingPct: capRemoved ? null : (pendingByCard.get(c.cardId) ?? null),
        crushed: !capRemoved && crushedCards.has(c.cardId),
        color: c.color,
        animation: c.animation,
      });
    }
  }
  // Display order: value-DESC by default (a VIEW sort — the staged solve order
  // is untouched). BUT once the operator manually reordered rows
  // (`staged.manualOrder`), the staged `cards` array order IS the intended
  // display + `pack_cards.order`, so it is preserved verbatim (no view sort).
  // Manual order only exists on the staged arm; the live pool always sorts.
  if (!(staged?.manualOrder === true)) {
    activeRows.sort((a, b) => b.value - a.value);
  }
  return [...activeRows, ...removedRows];
}

/**
 * Planned-% cell: `AnimatedNumber` for values its 2-decimal percent format
 * renders faithfully (≥ 1%), the canonical `formatPercent` (4 significant
 * digits) for sub-1% odds — a flat 2dp would collapse a real 0.0075% jackpot
 * to "0.01%", the exact precision loss `format-percent.ts` exists to prevent.
 */
function PlannedPct({ pct }: { pct: number }) {
  if (pct >= 1) {
    return <AnimatedNumber value={pct} format="percent" />;
  }
  return <span className="tabular-nums">{formatPercent(pct)}</span>;
}

export function CardDiffTable({
  rows,
  contextPrice,
  editable = false,
  autoHintByCardId,
  onRemove,
  onUndoRemove,
  onColorChange,
  onAnimationChange,
  onPendingEdit,
  onPendingClear,
  onPinClear,
  onMoveCard,
}: {
  rows: CardDiffRow[];
  /** Ticket price the win-band coloring is judged against (plan `priceAfter` when available). */
  contextPrice: number;
  /** Pool-table mode: cosmetics selects + remove/undo. Confirm renders read-only. */
  editable?: boolean;
  /** `describeAutoPick` hint per added card (pool table only). */
  autoHintByCardId?: Map<string, string>;
  onRemove?: (cardId: string) => void;
  onUndoRemove?: (cardId: string) => void;
  onColorChange?: (cardId: string, color: string | null) => void;
  onAnimationChange?: (cardId: string, animation: boolean) => void;
  /**
   * Manual row reordering (owner feature, 2026-07-04): move a card one step up
   * or down in the DISPLAY order — which becomes `pack_cards.order` on push.
   * Absent ⇒ no reorder controls (confirm dialog / read-only). Reordering only
   * sets the persisted order; it never changes which card gets which planned %.
   */
  onMoveCard?: (cardId: string, direction: "up" | "down") => void;
  /**
   * Pending edits (Retune V2 "edit several % before saving"): click-to-edit on
   * the Planned % cell — typing a percent + Enter/Tab writes it to the PENDING
   * buffer (no pin, no re-plan) and advances focus to the next editable Planned %
   * cell; Escape cancels just that cell. Applying the buffer (in the action bar)
   * is what commits the batch as pins with ONE re-plan.
   * Absent (confirm dialog / read-only) ⇒ the cell renders as before.
   */
  onPendingEdit?: (cardId: string, pct: number) => void;
  /** Drop a single card's pending (not-yet-applied) edit. */
  onPendingClear?: (cardId: string) => void;
  /** Clear a card's already-COMMITTED pin (the amber pin chip's X). */
  onPinClear?: (cardId: string) => void;
}) {
  // ONE cell edits at a time; draft lives here (cancelled on Escape/blur).
  const [editingCardId, setEditingCardId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  // Per-cardId input refs so Enter/Tab can move focus to the NEXT editable
  // Planned % cell without leaving the keyboard (fast multi-entry).
  const inputRefs = React.useRef<Map<string, HTMLInputElement>>(new Map());

  // The editable Planned % cells in display order (value-DESC, same as `rows`):
  // a row is editable iff it isn't a removal/cap-removal. Enter/Tab step through
  // this list.
  const editableIds = React.useMemo(
    () =>
      rows
        .filter((r) => !r.removed && r.capRemovedUsd === null)
        .map((r) => r.cardId),
    [rows],
  );

  // The reorderable (active, non-removed) rows in DISPLAY order — a card may
  // move up unless it's first, down unless it's last. Cap-removed / removed
  // rows never carry reorder controls (they trail after the active rows and
  // aren't written). `firstActiveId` / `lastActiveId` bound the arrows.
  const activeOrderedIds = React.useMemo(
    () =>
      rows
        .filter((r) => !r.removed && r.capRemovedUsd === null)
        .map((r) => r.cardId),
    [rows],
  );
  const firstActiveId = activeOrderedIds[0] ?? null;
  const lastActiveId = activeOrderedIds[activeOrderedIds.length - 1] ?? null;
  const showReorder = editable && onMoveCard !== undefined;

  /** Parse the draft; null = invalid (out of (0,100] or non-finite). */
  const parseDraft = (): number | null => {
    const pct = Number.parseFloat(draft);
    if (!Number.isFinite(pct) || !(pct > 0) || pct > 100) return null;
    return pct;
  };

  /** The next editable cardId after `cardId` (wraps to null at the end). */
  const nextEditableId = (cardId: string): string | null => {
    const idx = editableIds.indexOf(cardId);
    if (idx === -1) return null;
    return editableIds[idx + 1] ?? null;
  };

  const openEditor = (row: CardDiffRow) => {
    setDraft(
      row.pendingPct !== null
        ? String(Number(row.pendingPct.toPrecision(7)))
        : row.pinnedPct !== null
          ? String(Number(row.pinnedPct.toPrecision(7)))
          : row.plannedPct !== null
            ? String(Number(row.plannedPct.toPrecision(6)))
            : "",
    );
    setEditingCardId(row.cardId);
  };

  // Set for the duration of an Enter/Tab hop so the OLD input's unmount-blur
  // (which fires synchronously during React's commit) is a no-op — it must not
  // re-commit or clear the newly-focused cell. Cleared by the focus effect.
  const advancingRef = React.useRef(false);

  /** Enter/Tab: write the draft to the pending buffer, then advance focus. */
  const commitAndAdvance = (cardId: string) => {
    const pct = parseDraft();
    if (pct !== null) onPendingEdit?.(cardId, pct);
    const nextId = nextEditableId(cardId);
    if (nextId !== null) {
      // Re-open the next cell's editor; focus is applied once its input mounts
      // (the row re-renders into edit mode — an effect keyed on editingCardId
      // focuses it). Seed its draft from that row's current display value.
      const nextRow = rows.find((r) => r.cardId === nextId);
      if (nextRow) {
        advancingRef.current = true;
        openEditor(nextRow);
        return;
      }
    }
    setEditingCardId(null);
  };

  // Focus the active editor's input whenever the edited cell changes (drives
  // the Enter/Tab hop between cells). `autoFocus` covers the first open; this
  // covers every subsequent hop where the input was already mounted-then-swapped.
  // Clearing `advancingRef` here (post-commit) re-arms the genuine-blur path for
  // the newly-focused cell.
  React.useEffect(() => {
    advancingRef.current = false;
    if (editingCardId === null) return;
    const el = inputRefs.current.get(editingCardId);
    if (el) {
      el.focus();
      el.select();
    }
  }, [editingCardId]);
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {showReorder && <TableHead className="w-[52px]" aria-label="Reorder" />}
            <TableHead className="min-w-[180px]">Card</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead className="text-right">Live %</TableHead>
            <TableHead className="text-right">Planned %</TableHead>
            <TableHead className="text-right">Δpp</TableHead>
            {editable && <TableHead className="w-[110px]">Color</TableHead>}
            {editable && <TableHead className="w-[60px]">Anim</TableHead>}
            {editable && <TableHead className="w-[40px]" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            // A cap-removed row renders with the SAME inactive treatment as a
            // staged removal (strike-through, no odds/cosmetics) — only the
            // badge copy and the missing Undo differ.
            const inactive = row.removed || row.capRemovedUsd !== null;
            const delta =
              row.plannedPct !== null && row.livePct !== null
                ? row.plannedPct - row.livePct
                : null;
            // House-POV Δ colors: a WIN/GRAIL card (value ≥ ticket) getting
            // LESS likely is house-favorable (emerald); MORE likely means the
            // user wins more often (rose). Dust/near-miss moves stay muted.
            const winBand = row.value >= contextPrice;
            const deltaTone =
              delta === null || Math.abs(delta) < 1e-9
                ? "text-muted-foreground"
                : winBand
                  ? delta < 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                  : "text-muted-foreground";
            const hint = autoHintByCardId?.get(row.cardId);
            return (
              <TableRow
                key={row.cardId}
                className={cn(inactive && "opacity-60")}
              >
                {showReorder && (
                  <TableCell className="pr-0 align-middle">
                    {/* Reorder is for ACTIVE rows only — a removed/cap-removed
                        row isn't written, so it carries no arrows. */}
                    {!inactive && (
                      <div className="flex flex-col items-center gap-0.5">
                        <button
                          type="button"
                          aria-label={`Move ${row.name} up`}
                          title="Move up (sets card order — does not change odds)"
                          disabled={row.cardId === firstActiveId}
                          onClick={() => onMoveCard?.(row.cardId, "up")}
                          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                        >
                          <ChevronUp className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${row.name} down`}
                          title="Move down (sets card order — does not change odds)"
                          disabled={row.cardId === lastActiveId}
                          onClick={() => onMoveCard?.(row.cardId, "down")}
                          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                        >
                          <ChevronDown className="size-3.5" />
                        </button>
                      </div>
                    )}
                  </TableCell>
                )}
                <TableCell>
                  <div className="flex items-center gap-2">
                    <CardImage
                      src={row.imageUrl || null}
                      alt={row.name}
                      className="size-8 shrink-0 rounded"
                    />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={cn(
                            "truncate text-sm font-medium",
                            inactive &&
                              "text-rose-600 line-through dark:text-rose-400",
                          )}
                        >
                          {row.name}
                        </span>
                        {row.added && (
                          <Badge
                            variant="outline"
                            className="h-4 border-blue-500/30 bg-blue-500/10 px-1 text-[10px] text-blue-600 dark:text-blue-400"
                          >
                            added
                          </Badge>
                        )}
                        {row.removed && (
                          <Badge
                            variant="outline"
                            className="h-4 border-rose-500/30 bg-rose-500/10 px-1 text-[10px] text-rose-600 dark:text-rose-400"
                          >
                            removed
                          </Badge>
                        )}
                        {/* Cap removal (owner rule, 2026-07-03): the plan's
                            cap pre-filter drops this card — pushing removes
                            it from the pack (no dead 0%-odds row). */}
                        {row.capRemovedUsd !== null && (
                          <TooltipProvider delay={150}>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Badge
                                    variant="outline"
                                    className="h-4 border-rose-500/30 bg-rose-500/10 px-1 text-[10px] text-rose-600 dark:text-rose-400"
                                  >
                                    {capRemovedBadgeLabel(row.capRemovedUsd)}
                                  </Badge>
                                }
                              />
                              <TooltipContent className="max-w-72">
                                {capRemovedTooltip(row.value, row.capRemovedUsd)}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </div>
                      {hint && !inactive && (
                        <p className="truncate text-[10px] text-muted-foreground">
                          {hint}
                        </p>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {formatCurrency(row.value)}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums text-muted-foreground">
                  {row.livePct !== null ? formatPercent(row.livePct) : "—"}
                </TableCell>
                <TableCell className="text-right text-sm font-medium tabular-nums">
                  {inactive ? (
                    <span className="text-muted-foreground">—</span>
                  ) : editable && onPendingEdit && editingCardId === row.cardId ? (
                    // ── Pending editor: Enter/Tab buffers + advances, Escape
                    //    cancels this cell, blur commits without advancing. ──
                    <span className="inline-flex items-center gap-1">
                      <Input
                        ref={(el) => {
                          if (el) inputRefs.current.set(row.cardId, el);
                          else inputRefs.current.delete(row.cardId);
                        }}
                        autoFocus
                        type="text"
                        inputMode="decimal"
                        placeholder={PIN_INPUT_PLACEHOLDER}
                        value={draft}
                        onChange={(e) => {
                          const raw = e.target.value;
                          if (raw === "" || /^\d*\.?\d{0,7}$/.test(raw)) {
                            setDraft(raw);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === "Tab") {
                            // Tab must NOT also move DOM focus — we drive the hop.
                            e.preventDefault();
                            commitAndAdvance(row.cardId);
                          } else if (e.key === "Escape") {
                            setEditingCardId(null);
                          }
                        }}
                        onBlur={() => {
                          // A blur triggered BY the Enter/Tab advance-hop is a
                          // no-op — the value is already buffered and the next
                          // cell is opening; touching state here would clobber it.
                          if (advancingRef.current) return;
                          // A genuine blur (click elsewhere) commits the current
                          // cell to the buffer without advancing — never silently
                          // discards a typed value — then closes the editor.
                          const pct = parseDraft();
                          if (pct !== null) onPendingEdit?.(row.cardId, pct);
                          setEditingCardId(null);
                        }}
                        className={cn(
                          "h-6 w-24 rounded-md text-right text-xs tabular-nums",
                          "border-amber-500/60 focus-visible:ring-amber-500/40",
                        )}
                        aria-label={`${PENDING_EDIT_ARIA}: chance for ${row.name} (percent)`}
                      />
                      <span className="text-xs text-muted-foreground">%</span>
                    </span>
                  ) : (
                    <span className="group/pin inline-flex items-center gap-1.5">
                      {row.offLadder &&
                        row.pinnedPct === null &&
                        row.pendingPct === null && (
                          <TooltipProvider delay={150}>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span
                                    aria-label="Off the clean ladder"
                                    className="inline-block size-1.5 rounded-full bg-amber-500"
                                  />
                                }
                              />
                              <TooltipContent>
                                Off the clean ladder — this chance is not a round
                                number.
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      {/* Pinned at the quantization floor (LOSS-band cards
                          only — a designed 1-in-a-million jackpot is not a
                          pin): muted "min" chip, tooltip says why. */}
                      {!winBand &&
                        row.pinnedPct === null &&
                        row.pendingPct === null &&
                        row.plannedPct !== null &&
                        isFloorPinnedPct(row.plannedPct) && (
                          <TooltipProvider delay={150}>
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Badge
                                    variant="outline"
                                    className="h-4 border-border bg-muted/40 px-1 text-[10px] font-normal text-muted-foreground"
                                  >
                                    {FLOOR_PIN_CHIP}
                                  </Badge>
                                }
                              />
                              <TooltipContent>{FLOOR_PIN_TOOLTIP}</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      {/* §3.3 crush chip (amber): the shape guard flagged this
                          card crushed ≥100x below live — points at the pool
                          edit. Only on degenerate plans (server-gated). */}
                      {row.crushed && (
                        <TooltipProvider delay={150}>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Badge
                                  variant="outline"
                                  className="h-4 border-amber-500/30 bg-amber-500/10 px-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                                >
                                  {CRUSH_CHIP}
                                </Badge>
                              }
                            />
                            <TooltipContent>{CRUSH_TOOLTIP}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      {/* Owner pin chip (amber): the typed value binds the plan.
                          Hidden while a PENDING edit overrides this card (the
                          pending chip is what's shown until Apply). */}
                      {row.pinnedPct !== null && row.pendingPct === null && (
                        <TooltipProvider delay={150}>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Badge
                                  variant="outline"
                                  className="h-4 gap-0.5 border-amber-500/30 bg-amber-500/10 px-1 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                                >
                                  {PIN_CHIP} {formatPercent(row.pinnedPct)}
                                  {editable && onPinClear && (
                                    <button
                                      type="button"
                                      aria-label={`Clear pin on ${row.name}`}
                                      className="ml-0.5 rounded-full hover:text-amber-800 dark:hover:text-amber-200"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onPinClear(row.cardId);
                                      }}
                                    >
                                      <X className="size-2.5" />
                                    </button>
                                  )}
                                </Badge>
                              }
                            />
                            <TooltipContent>{PIN_TOOLTIP}</TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      {editable && onPendingEdit ? (
                        // Click-to-edit (pencil affordance on hover). A PENDING
                        // edit renders the typed value in a distinct amber, dashed
                        // "pending" pill with its own clear-X — visually apart from
                        // a committed pin chip and from the plain planned number.
                        row.pendingPct !== null ? (
                          <span className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              title={PENDING_EDIT_HINT}
                              onClick={() => openEditor(row)}
                              className="inline-flex items-center gap-1 rounded-md border border-dashed border-amber-500/70 bg-amber-500/10 px-1.5 py-0.5 text-amber-700 tabular-nums hover:bg-amber-500/20 dark:text-amber-300"
                            >
                              <span
                                aria-hidden
                                className="inline-block size-1.5 rounded-full bg-amber-500"
                              />
                              {formatPercent(row.pendingPct)}
                              <Pencil aria-hidden className="size-3 opacity-70" />
                            </button>
                            {onPendingClear && (
                              <button
                                type="button"
                                aria-label={`Cancel pending edit on ${row.name}`}
                                className="rounded-full text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onPendingClear(row.cardId);
                                }}
                              >
                                <X className="size-3" />
                              </button>
                            )}
                          </span>
                        ) : (
                          <button
                            type="button"
                            title={PENDING_EDIT_HINT}
                            className="inline-flex items-center gap-1 rounded px-0.5 tabular-nums hover:bg-muted/50"
                            onClick={() => openEditor(row)}
                          >
                            {row.plannedPct !== null ? (
                              <PlannedPct pct={row.plannedPct} />
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                            <Pencil
                              aria-hidden
                              className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover/pin:opacity-100"
                            />
                          </button>
                        )
                      ) : row.plannedPct !== null ? (
                        <PlannedPct pct={row.plannedPct} />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>
                  )}
                </TableCell>
                <TableCell
                  className={cn("text-right text-sm tabular-nums", deltaTone)}
                >
                  {delta !== null
                    ? `${delta >= 0 ? "+" : "−"}${formatDeltaPp(Math.abs(delta))}`
                    : "—"}
                </TableCell>
                {editable && (
                  <TableCell>
                    {!inactive && (
                      <Select
                        value={row.color ?? ""}
                        onValueChange={(v) =>
                          onColorChange?.(row.cardId, v ? v : null)
                        }
                      >
                        <SelectTrigger size="sm" className="h-7 w-full text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CARD_COLORS.map((c) => (
                            <SelectItem key={c.value} value={c.value}>
                              {c.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                )}
                {editable && (
                  <TableCell>
                    {!inactive && (
                      <Switch
                        checked={row.animation}
                        onCheckedChange={(v) =>
                          onAnimationChange?.(row.cardId, v === true)
                        }
                        aria-label={`Animated: ${row.name}`}
                      />
                    )}
                  </TableCell>
                )}
                {editable && (
                  <TableCell>
                    {row.removed ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => onUndoRemove?.(row.cardId)}
                      >
                        <Undo2 className="size-3.5" />
                        Undo
                      </Button>
                    ) : row.capRemovedUsd !== null ? (
                      // A cap removal has no Undo — the plan drops it; the way
                      // to keep the card is raising the cap (see the badge
                      // tooltip + the plan's raise-cap guidance).
                      null
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                        aria-label={`Remove ${row.name}`}
                        onClick={() => onRemove?.(row.cardId)}
                      >
                        <X className="size-3.5" />
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
          {rows.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={editable ? (showReorder ? 9 : 8) : 5}
                className="py-8 text-center text-sm text-muted-foreground"
              >
                No cards in this pool.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
