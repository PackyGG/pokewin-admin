"use client";

import * as React from "react";
import { Undo2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type { EditPool, PackTunePlan } from "../../doctor/retune-actions";

import { formatDeltaPp, formatPercent } from "../format-percent";
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
  /** Planned pct is NOT on the clean ladder (amber dot). */
  offLadder: boolean;
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
      rows.push({
        cardId: c.cardId,
        name: c.name,
        value: c.value,
        imageUrl: c.imageUrl,
        livePct: planned ? planned.livePct : c.added ? null : livePctOf(c.cardId),
        plannedPct: planned ? planned.pct : null,
        added: c.added,
        removed: false,
        offLadder: offLadder.has(c.cardId),
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
        offLadder: false,
        color: c.color,
        animation: c.animation,
      });
    }
  } else if (pool) {
    for (const c of pool.cards) {
      const planned = plannedByCard.get(c.cardId);
      rows.push({
        cardId: c.cardId,
        name: c.name,
        value: c.value,
        imageUrl: c.imageUrl,
        livePct: planned ? planned.livePct : livePctOf(c.cardId),
        plannedPct: planned ? planned.pct : null,
        added: false,
        removed: false,
        offLadder: offLadder.has(c.cardId),
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
}) {
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
                className={cn(row.removed && "opacity-60")}
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
                            row.removed &&
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
                      </div>
                      {hint && !row.removed && (
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
                  {row.removed ? (
                    <span className="text-muted-foreground">—</span>
                  ) : row.plannedPct !== null ? (
                    <span className="inline-flex items-center gap-1.5">
                      {row.offLadder && (
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
                      <PlannedPct pct={row.plannedPct} />
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
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
                    {!row.removed && (
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
                    {!row.removed && (
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
