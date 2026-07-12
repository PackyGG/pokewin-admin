"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ClipboardEdit,
  DollarSign,
  Loader2,
  Minus,
  Sparkles,
  Trash2,
  UploadCloud,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatCurrency, formatRelative } from "@/lib/utils/format";

import type {
  PendingDraftRow,
  WeightChangeRow,
} from "@/lib/queries/pack-retune-drafts-shared";
import {
  topWeightChanges,
  draftHasChanges,
} from "@/lib/queries/pack-retune-drafts-shared";

import {
  applyAutoRepriceToDraft,
  applyAutoRetuneToDraft,
  bulkSeedAllActiveDrafts,
  discardDraft,
  pushAllDrafts,
  pushDraftToProd,
} from "./_actions";

/**
 * Pack Drafts list — clean, scannable table of every pending draft. Click a
 * row to expand a BEFORE / AFTER diff (rendered from data already loaded by
 * the server query — no extra fetch on expand). Per-row [Auto-retune] /
 * [Auto-reprice] / [Push to prod] / [Discard] actions; top bar carries
 * [Seed all active packs] + [Push all].
 *
 * NO 2FA UI — every action server-side mints a synthetic retune token (only
 * the push path hits MAIN); the operator + demee allowlist gate already
 * protects the surface.
 *
 * House-POV colors on every numeric delta:
 *   • edge UP (we earn more) → emerald
 *   • edge DOWN (user earns more) → rose
 *   • price UP (user pays more) → emerald
 *   • price DOWN → rose
 *   • tier change is informational (text, neutral)
 */

// ─── Formatting helpers ──────────────────────────────────────────────────

function pct(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(2)}%`;
}
function pctDelta(deltaFraction: number): string {
  if (!Number.isFinite(deltaFraction)) return "—";
  const ppt = deltaFraction * 100;
  const sign = ppt > 0 ? "+" : "";
  return `${sign}${ppt.toFixed(2)}pp`;
}
function moneyDelta(delta: number): string {
  if (!Number.isFinite(delta)) return "—";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${formatCurrency(delta)}`;
}

/** House-POV color tone — accent is "house up = emerald, house down = rose". */
type Tone = "emerald" | "rose" | "neutral";

function edgeTone(deltaFraction: number): Tone {
  if (!Number.isFinite(deltaFraction) || Math.abs(deltaFraction) < 1e-6)
    return "neutral";
  return deltaFraction > 0 ? "emerald" : "rose";
}
function priceTone(delta: number): Tone {
  // User pays more (price up) = house gains = emerald; vice versa.
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-4) return "neutral";
  return delta > 0 ? "emerald" : "rose";
}

const TONE_CLASS: Record<Tone, string> = {
  emerald:
    "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
  rose: "text-rose-600 dark:text-rose-400 bg-rose-500/10 border-rose-500/30",
  neutral: "text-muted-foreground bg-muted/40 border-border",
};

function DeltaBadge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: Tone;
}) {
  const Icon = tone === "emerald" ? ArrowUp : tone === "rose" ? ArrowDown : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
        TONE_CLASS[tone],
      )}
    >
      <Icon className="size-3" aria-hidden />
      {children}
    </span>
  );
}

// ─── Action-row hook (one busy state per row) ────────────────────────────

type BusyKind = "auto-retune" | "auto-reprice" | "push" | "discard" | null;

function useDraftActions(packId: string, onChange: () => void) {
  const [busy, setBusy] = React.useState<BusyKind>(null);

  const runAutoRetune = React.useCallback(async () => {
    setBusy("auto-retune");
    try {
      const r = await applyAutoRetuneToDraft(packId);
      if (!r.feasible) {
        toast.error(r.error || "Auto-retune infeasible.");
      } else {
        toast.success(
          `Auto-retuned · edge ${pct(r.risk.edge)} · win-rate ${pct(r.risk.winRate)}`,
        );
        onChange();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Auto-retune failed.");
    } finally {
      setBusy(null);
    }
  }, [packId, onChange]);

  const runAutoReprice = React.useCallback(async () => {
    setBusy("auto-reprice");
    try {
      const r = await applyAutoRepriceToDraft(packId, { targetEdge: "per-pack" });
      if (r.action === "reprice") {
        toast.success(
          `Repriced to ${formatCurrency(r.newPrice)} · edge ${pct(r.newEdge)}`,
        );
      } else if (r.action === "unchanged") {
        toast.message("Already on target.", {
          description: r.reason || "No reprice needed.",
        });
      } else {
        toast.message("Skipped reprice.", {
          description: r.reason || "Round-up cent overshoots target.",
        });
      }
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Auto-reprice failed.");
    } finally {
      setBusy(null);
    }
  }, [packId, onChange]);

  const runDiscard = React.useCallback(async () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm("Discard this draft? The pack stays unchanged on MAIN.")
    ) {
      return;
    }
    setBusy("discard");
    try {
      await discardDraft(packId);
      toast.success("Draft discarded.");
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Discard failed.");
    } finally {
      setBusy(null);
    }
  }, [packId, onChange]);

  const runPush = React.useCallback(async () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Push this draft to PROD? This writes to the live MAIN pack.",
      )
    ) {
      return;
    }
    setBusy("push");
    try {
      const r = await pushDraftToProd(packId);
      if ("refusedMessage" in r) {
        toast.error(r.refusedMessage);
      } else {
        const edgeDown = r.after.edge < r.before.edge - 1e-9;
        const msg =
          `Pushed to MAIN · edge ${pct(r.before.edge)} → ${pct(r.after.edge)} · price ${formatCurrency(r.before.price)} → ${formatCurrency(r.after.price)}`;
        if (edgeDown) {
          toast.warning(msg, {
            description: "House edge decreased — verify this was intended.",
          });
        } else {
          toast.success(msg);
        }
        onChange();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Push failed.");
    } finally {
      setBusy(null);
    }
  }, [packId, onChange]);

  return { busy, runAutoRetune, runAutoReprice, runDiscard, runPush };
}

// ─── Diff dropdown ───────────────────────────────────────────────────────

function WeightChangeTable({
  rows,
  packPrice,
}: {
  rows: WeightChangeRow[];
  packPrice: number;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No per-card weight changes yet — the proposed pool matches the live
        pool. Run Auto-retune or Auto-reprice to stage a change.
      </p>
    );
  }
  return (
    <div className="rounded-lg border bg-card/40">
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Card</span>
        <span className="text-right">Value</span>
        <span className="text-right">Weight</span>
        <span className="text-right">Δ</span>
      </div>
      <ul className="divide-y">
        {rows.map((r) => {
          // House-POV: a card whose weight WENT UP shifts mass toward that
          // outcome. If the card is high-value (≥ pack price = a win for the
          // user) that's BAD for the house → rose. If it's low value (junk
          // floor, < pack price) that's GOOD for the house → emerald.
          // Vice versa for weight decreases.
          const isWinCard = r.value >= packPrice;
          const tone: Tone =
            r.delta === 0
              ? "neutral"
              : r.delta > 0
                ? isWinCard
                  ? "rose"
                  : "emerald"
                : isWinCard
                  ? "emerald"
                  : "rose";
          return (
            <li
              key={r.cardId}
              className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 px-3 py-2 text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                {r.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.imageUrl}
                    alt=""
                    aria-hidden
                    className="size-8 rounded-md object-cover border bg-muted shrink-0"
                  />
                ) : (
                  <div className="size-8 rounded-md border bg-muted shrink-0" />
                )}
                <span className="truncate font-medium">{r.name}</span>
              </div>
              <span className="text-right tabular-nums text-muted-foreground">
                {formatCurrency(r.value)}
              </span>
              <span className="text-right tabular-nums">
                {r.before.toLocaleString()} → {r.after.toLocaleString()}
              </span>
              <span className="text-right">
                <DeltaBadge tone={tone}>
                  {r.delta > 0 ? "+" : ""}
                  {r.delta.toLocaleString()}
                </DeltaBadge>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DiffMetric({
  label,
  before,
  after,
  format,
  tone,
}: {
  label: string;
  before: string;
  after: string;
  format?: "mono";
  tone?: Tone;
}) {
  return (
    <div className="rounded-lg border bg-card/40 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span
          className={cn(
            "text-sm text-muted-foreground tabular-nums line-through",
            format === "mono" && "font-mono",
          )}
        >
          {before}
        </span>
        <ChevronRight className="size-3 text-muted-foreground" aria-hidden />
        <span
          className={cn(
            "text-base font-semibold tabular-nums",
            format === "mono" && "font-mono",
            tone === "emerald" && "text-emerald-600 dark:text-emerald-400",
            tone === "rose" && "text-rose-600 dark:text-rose-400",
          )}
        >
          {after}
        </span>
      </div>
    </div>
  );
}

function DraftDiff({ row }: { row: PendingDraftRow }) {
  const source = row.source;
  const after = row.computedRisk;
  const sourceRisk = source.risk;

  const priceDelta = row.proposedPrice - source.price;
  const edgeDelta = sourceRisk ? after.edge - sourceRisk.edge : 0;
  const winRateDelta = sourceRisk ? after.winRate - sourceRisk.winRate : 0;
  const maxWinDelta = sourceRisk ? after.maxWin - sourceRisk.maxWin : 0;

  const weightRows = topWeightChanges(source, row.proposedPool, 5);

  return (
    <div className="border-t bg-muted/20 px-4 py-4 sm:px-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <DiffMetric
          label="Price"
          before={formatCurrency(source.price)}
          after={formatCurrency(row.proposedPrice)}
          tone={priceTone(priceDelta)}
        />
        <DiffMetric
          label="Edge"
          before={sourceRisk ? pct(sourceRisk.edge) : "—"}
          after={pct(after.edge)}
          tone={edgeTone(edgeDelta)}
        />
        <DiffMetric
          label="Win rate"
          before={sourceRisk ? pct(sourceRisk.winRate) : "—"}
          after={pct(after.winRate)}
          // House-POV: higher user win-rate is BAD for house → rose.
          tone={
            winRateDelta === 0
              ? "neutral"
              : winRateDelta > 0
                ? "rose"
                : "emerald"
          }
        />
        <DiffMetric
          label="Max win"
          before={sourceRisk ? formatCurrency(sourceRisk.maxWin) : "—"}
          after={formatCurrency(after.maxWin)}
          // House-POV: bigger jackpot = bigger user upside = rose.
          tone={
            maxWinDelta === 0 ? "neutral" : maxWinDelta > 0 ? "rose" : "emerald"
          }
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          CV{" "}
          <span className="font-medium tabular-nums text-foreground">
            {sourceRisk ? sourceRisk.cv.toFixed(2) : "—"} →{" "}
            {after.cv.toFixed(2)}
          </span>
        </span>
        <span>
          Tier{" "}
          <span className="font-medium text-foreground">
            {sourceRisk?.tier ?? "—"} → {after.tier}
          </span>
        </span>
        <span>
          Risk score{" "}
          <span className="font-medium tabular-nums text-foreground">
            {sourceRisk ? sourceRisk.riskScore0to100 : "—"} →{" "}
            {after.riskScore0to100}
          </span>
        </span>
      </div>

      <div className="mt-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Top weight changes
        </div>
        <WeightChangeTable rows={weightRows} packPrice={row.proposedPrice} />
      </div>

      {row.notes && (
        <p className="mt-3 rounded-md border bg-card/40 px-3 py-2 text-sm">
          <span className="font-semibold text-muted-foreground">Notes: </span>
          {row.notes}
        </p>
      )}
    </div>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────

function DraftRow({
  row,
  expanded,
  onToggle,
  onChanged,
}: {
  row: PendingDraftRow;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const { busy, runAutoRetune, runAutoReprice, runDiscard, runPush } =
    useDraftActions(row.packId, onChanged);

  const source = row.source;
  const sourceRisk = source.risk;
  const after = row.computedRisk;
  const priceDelta = row.proposedPrice - source.price;
  const edgeDelta = sourceRisk ? after.edge - sourceRisk.edge : 0;
  const tierChanged =
    !!sourceRisk && sourceRisk.tier !== after.tier
      ? `${sourceRisk.tier} → ${after.tier}`
      : null;

  const hasChanges = draftHasChanges(row);

  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[auto_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-3 text-left transition-colors hover:bg-muted/40 sm:gap-x-4 sm:px-4"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-safe:duration-150",
            expanded && "rotate-90",
          )}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{source.name}</span>
            {!hasChanges && (
              <span className="shrink-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                no changes
              </span>
            )}
            {!source.active && (
              <span className="shrink-0 rounded-md border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                inactive
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {source.slug || row.packId.slice(0, 8)}
          </div>
        </div>
        {/* Price → */}
        <div className="flex flex-col items-end gap-0.5 text-right">
          <span className="text-sm tabular-nums">
            <span className="text-muted-foreground line-through">
              {formatCurrency(source.price)}
            </span>{" "}
            <span className="font-semibold">
              {formatCurrency(row.proposedPrice)}
            </span>
          </span>
          {Math.abs(priceDelta) > 1e-4 && (
            <DeltaBadge tone={priceTone(priceDelta)}>
              {moneyDelta(priceDelta)}
            </DeltaBadge>
          )}
        </div>
        {/* Edge → */}
        <div className="flex flex-col items-end gap-0.5 text-right">
          <span className="text-sm tabular-nums">
            <span className="text-muted-foreground line-through">
              {sourceRisk ? pct(sourceRisk.edge) : "—"}
            </span>{" "}
            <span className="font-semibold">{pct(after.edge)}</span>
          </span>
          {sourceRisk && Math.abs(edgeDelta) > 1e-6 && (
            <DeltaBadge tone={edgeTone(edgeDelta)}>
              {pctDelta(edgeDelta)}
            </DeltaBadge>
          )}
        </div>
        {/* Tier + meta */}
        <div className="flex flex-col items-end gap-0.5 text-right text-[11px] text-muted-foreground">
          {tierChanged ? (
            <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-medium text-foreground">
              {tierChanged}
            </span>
          ) : (
            <span className="text-foreground">
              Tier {sourceRisk?.tier ?? after.tier}
            </span>
          )}
          <span>edited {formatRelative(row.lastEditedAt)}</span>
          {row.lastEditedByDisplay && (
            <span className="truncate max-w-[140px]">
              by {row.lastEditedByDisplay}
            </span>
          )}
        </div>
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-safe:duration-150",
            expanded && "rotate-180",
          )}
        />
      </button>

      {expanded && (
        <div>
          <DraftDiff row={row} />
          <div className="flex flex-col gap-2 border-t px-3 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2 sm:px-4">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={runAutoRetune}
                title="Run the read-only auto-retune planner and store its proposal in this draft."
              >
                {busy === "auto-retune" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Wand2 className="size-3.5" />
                )}
                Auto-retune
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={runAutoReprice}
                title="Run the per-pack reprice planner and update the draft's price."
              >
                {busy === "auto-reprice" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <DollarSign className="size-3.5" />
                )}
                Auto-reprice
              </Button>
            </div>
            <div className="flex flex-1 flex-wrap justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={runDiscard}
                className="text-rose-600 hover:text-rose-700 dark:text-rose-400"
              >
                {busy === "discard" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                Discard
              </Button>
              <Button
                size="sm"
                disabled={busy !== null || !hasChanges}
                onClick={runPush}
                title={
                  hasChanges
                    ? "Push this draft to MAIN (the only write that touches prod)."
                    : "Draft is identical to the live pack — nothing to push."
                }
              >
                {busy === "push" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <UploadCloud className="size-3.5" />
                )}
                Push to prod
              </Button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

// ─── Top action bar (Seed all + Push all) ────────────────────────────────

export function DraftsTopActions({ pendingCount }: { pendingCount: number }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<"seed" | "push-all" | null>(null);

  const refresh = React.useCallback(() => router.refresh(), [router]);

  const onSeedAll = React.useCallback(async () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Seed a draft for every active cash pack? Existing drafts are kept.",
      )
    ) {
      return;
    }
    setBusy("seed");
    try {
      const r = await bulkSeedAllActiveDrafts({ onlyActiveCashPacks: true });
      const errCount = r.errors.length;
      const headline =
        r.seeded > 0
          ? `Seeded ${r.seeded} draft${r.seeded === 1 ? "" : "s"}`
          : "No new drafts needed";
      toast.success(headline, {
        description: `Skipped ${r.skipped} · ${errCount} error${errCount === 1 ? "" : "s"}`,
      });
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk seed failed.");
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const onPushAll = React.useCallback(async () => {
    if (pendingCount === 0) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Push ${pendingCount} draft${pendingCount === 1 ? "" : "s"} to MAIN now?`,
      )
    ) {
      return;
    }
    setBusy("push-all");
    try {
      const r = await pushAllDrafts();
      if ("refusedMessage" in r) {
        toast.error(r.refusedMessage);
      } else {
        const pushed = r.pushed.length;
        const failed = r.failed.length;
        if (pushed > 0 && failed === 0) {
          toast.success(`Pushed ${pushed} draft${pushed === 1 ? "" : "s"} to MAIN.`);
        } else if (pushed > 0 && failed > 0) {
          toast.warning(`Pushed ${pushed}, failed ${failed}.`, {
            description: r.failed[0]?.error ?? "",
          });
        } else if (failed > 0) {
          toast.error(`All ${failed} pushes failed.`, {
            description: r.failed[0]?.error ?? "",
          });
        } else {
          toast.message("Nothing pushed.");
        }
        refresh();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Push all failed.");
    } finally {
      setBusy(null);
    }
  }, [pendingCount, refresh]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy !== null}
        onClick={onSeedAll}
      >
        {busy === "seed" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Sparkles className="size-3.5" />
        )}
        Seed drafts for all packs
      </Button>
      <Button
        size="sm"
        disabled={busy !== null || pendingCount === 0}
        onClick={onPushAll}
      >
        {busy === "push-all" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <UploadCloud className="size-3.5" />
        )}
        Push all{pendingCount > 0 ? ` (${pendingCount})` : ""}
      </Button>
    </div>
  );
}

// ─── List shell ──────────────────────────────────────────────────────────

export function DraftsList({ rows }: { rows: PendingDraftRow[] }) {
  const router = useRouter();
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const refresh = React.useCallback(() => router.refresh(), [router]);

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border bg-card/40 px-6 py-16 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-primary/20 bg-primary/10">
          <ClipboardEdit className="size-5 text-primary" />
        </div>
        <h3 className="mt-3 text-base font-semibold">No pending drafts</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Seed a pack from Pack Doctor or the Retune workspace to stage a
          change here without touching MAIN.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card/60">
      <div className="hidden border-b px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:grid md:grid-cols-[auto_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center md:gap-x-4">
        <span className="size-4" aria-hidden />
        <span>Pack</span>
        <span className="text-right">Price</span>
        <span className="text-right">Edge</span>
        <span className="text-right">Tier · Edited</span>
        <span className="size-4" aria-hidden />
      </div>
      <ul>
        {rows.map((r) => (
          <DraftRow
            key={r.draftId}
            row={r}
            expanded={expanded === r.draftId}
            onToggle={() =>
              setExpanded((cur) => (cur === r.draftId ? null : r.draftId))
            }
            onChanged={refresh}
          />
        ))}
      </ul>
    </div>
  );
}

// ─── Inline skeleton (used by the page-level Suspense fallback) ──────────

export function DraftsListSkeleton() {
  return (
    <div className="rounded-xl border bg-card/60">
      <div className="border-b px-4 py-2">
        <Skeleton className="h-3 w-32" />
      </div>
      <ul className="divide-y">
        {Array.from({ length: 6 }).map((_, i) => (
          <li
            key={i}
            className="grid grid-cols-[auto_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-3"
          >
            <Skeleton className="size-4" />
            <div className="space-y-1">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-4 w-20 justify-self-end" />
            <Skeleton className="h-4 w-20 justify-self-end" />
            <Skeleton className="h-4 w-24 justify-self-end" />
            <Skeleton className="size-4" />
          </li>
        ))}
      </ul>
    </div>
  );
}
