"use client";

import * as React from "react";
import { Pencil, Undo2, X } from "lucide-react";

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
  PIN_CHIP,
  PIN_EDIT_HINT,
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
}): CardDiffRow[] {
  const { pool, staged, plan } = args;
  const plannedByCard = new Map<string, { pct: number; livePct: number | null }>();
  if (plan) {
    for (const p of plan.planned) {
      plannedByCard.set(p.cardId, { pct: p.pct, livePct: p.livePct });
    }
  }
  const offLadder = new Set(plan?.offLadderCards ?? []);
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

  const rows: CardDiffRow[] = [];
  if (staged) {
    for (const c of staged.cards) {
      const planned = plannedByCard.get(c.cardId);
      const pinnedPct = pinnedByCard.get(c.cardId) ?? null;
      const capRemoved = capDropped.has(c.cardId) && capUsd !== null;
      rows.push({
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
        color: c.color,
        animation: c.animation,
      });
    }
    for (const c of staged.removed) {
      rows.push({
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
        color: c.color,
        animation: c.animation,
      });
    }
  } else if (pool) {
    for (const c of pool.cards) {
      const planned = plannedByCard.get(c.cardId);
      const capRemoved = capDropped.has(c.cardId) && capUsd !== null;
      rows.push({
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
        color: c.color,
        animation: c.animation,
      });
    }
  }
  rows.sort((a, b) => b.value - a.value);
  return rows;
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
  onPinCard,
  onPinClear,
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
   * Owner pins (Retune V2): click-to-edit on the Planned % cell — typing a
   * percent + Enter pins the card (the typed value binds the plan; re-plans
   * through the same staged path as add/remove/price), Escape cancels.
   * Absent (confirm dialog / read-only) ⇒ the cell renders as before.
   */
  onPinCard?: (cardId: string, pct: number) => void;
  onPinClear?: (cardId: string) => void;
}) {
  // ONE cell edits at a time; draft lives here (cancelled on Escape/blur).
  const [editingCardId, setEditingCardId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const commitPin = (cardId: string) => {
    const pct = Number.parseFloat(draft);
    setEditingCardId(null);
    if (!Number.isFinite(pct) || !(pct > 0) || pct > 100) return;
    onPinCard?.(cardId, pct);
  };
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
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
                  ) : editable && onPinCard && editingCardId === row.cardId ? (
                    // ── Pin editor: Enter pins, Escape/blur cancels (§ pins) ──
                    <span className="inline-flex items-center gap-1">
                      <Input
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
                          if (e.key === "Enter") commitPin(row.cardId);
                          else if (e.key === "Escape") setEditingCardId(null);
                        }}
                        onBlur={() => setEditingCardId(null)}
                        className="h-6 w-24 text-right text-xs tabular-nums"
                        aria-label={`Pin chance for ${row.name} (percent)`}
                      />
                      <span className="text-xs text-muted-foreground">%</span>
                    </span>
                  ) : (
                    <span className="group/pin inline-flex items-center gap-1.5">
                      {row.offLadder && row.pinnedPct === null && (
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
                      {/* Owner pin chip (amber): the typed value binds the plan. */}
                      {row.pinnedPct !== null && (
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
                      {editable && onPinCard ? (
                        // Click-to-edit (pencil affordance on hover).
                        <button
                          type="button"
                          title={PIN_EDIT_HINT}
                          className="inline-flex items-center gap-1 rounded px-0.5 tabular-nums hover:bg-muted/50"
                          onClick={() => {
                            setDraft(
                              row.pinnedPct !== null
                                ? String(row.pinnedPct)
                                : row.plannedPct !== null
                                  ? String(Number(row.plannedPct.toPrecision(6)))
                                  : "",
                            );
                            setEditingCardId(row.cardId);
                          }}
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
                colSpan={editable ? 8 : 5}
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
