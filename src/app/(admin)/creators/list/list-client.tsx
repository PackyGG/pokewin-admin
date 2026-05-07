"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Calculator,
  CircleDollarSign,
  FileText,
  Notebook,
  Pencil,
  Plus,
  Settings2,
  Trash2,
  Users,
  X,
  Youtube,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import {
  createCreatorEstimate,
  deleteCreatorEstimate,
  updateCreatorEstimate,
} from "./actions";

export type CreatorEstimate = {
  id: string;
  name: string;
  dailyFillUsd: number | null;
  withdrawalCapUsd: number | null;
  withdrawalPercent: number | null;
  leaderboardCostUsd: number | null;
  packyPaidPercent: number | null;
  dealLengthWeeks: number | null;
  videoAmountUsd: number | null;
  videoPercent: number | null;
  videoFillsPerWeek: number | null;
  tipBalanceUsd: number | null;
  battleBalanceUsd: number | null;
  notes: string | null;
  createdAt: string;
};

// ── Computed numbers (mirror page.tsx server computation) ─────────

function rawLbCost(e: CreatorEstimate): number {
  const lb = e.leaderboardCostUsd ?? 0;
  const share = e.packyPaidPercent ?? 0;
  return lb * (share / 100);
}

// Net weekly video cost. Same shape as daily fill: amount × fills,
// minus the % the house recoups. Counts into the same weekly bucket
// as the withdraw cap per the user spec.
function weeklyVideoNet(e: CreatorEstimate): number {
  const amt = e.videoAmountUsd ?? 0;
  const fills = e.videoFillsPerWeek ?? 0;
  const pct = e.videoPercent ?? 0;
  return amt * fills * (1 - pct / 100);
}

function maxCost(e: CreatorEstimate): number {
  // Daily fill is intentionally NOT in the formula. It sits on the
  // creator's on-site balance and only leaves the platform via
  // withdrawals — and withdrawals are already bounded by wd_cap per
  // week. So wd_cap × weeks captures the realistic worst-case cost
  // of the fill stream. Videos are paid out separately and add to
  // the weekly bucket alongside wd_cap. (Per user clarification
  // 2026-05-07.)
  const weekly = (e.withdrawalCapUsd ?? 0) + weeklyVideoNet(e);
  const weeks = e.dealLengthWeeks ?? 0;
  // Flat balances: not scaled by weeks, just added on top of the
  // computed total — they're one-time pots loaded onto the creator's
  // account up front.
  return (
    weekly * weeks +
    rawLbCost(e) +
    (e.tipBalanceUsd ?? 0) +
    (e.battleBalanceUsd ?? 0)
  );
}

// Currency formatter locked to en-US so commas/decimals are
// unambiguous regardless of the admin's browser locale. Previously
// used toLocaleString with undefined locale which produced "$13.775"
// in EU locales — it read as "$13.77" to en-US viewers and made the
// preview look broken.
function fmt$(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return formatCurrency(n);
}

// ── Top-level grid ─────────────────────────────────────────────────

export function CreatorEstimatesClient({
  estimates,
}: {
  estimates: CreatorEstimate[];
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {estimates.length === 0
            ? "No deals tracked yet — add one to start estimating."
            : `${estimates.length} deal${estimates.length === 1 ? "" : "s"} tracked`}
        </p>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          Add Deal
        </Button>
      </div>

      {estimates.length === 0 ? (
        <Card>
          <CardContent className="flex h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Users className="size-6 text-muted-foreground/60" />
            <p>Click &quot;Add Deal&quot; to track a prospective creator.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 grid-cols-1 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
          {estimates.map((e) => (
            <EstimateCard key={e.id} estimate={e} />
          ))}
        </div>
      )}

      <EstimateFormDialog
        open={adding}
        onClose={() => setAdding(false)}
        estimate={null}
      />
    </div>
  );
}

// ── Per-deal card ─────────────────────────────────────────────────
//
// Structure (top → bottom):
//   1. Identity row — icon + name + length pill + edit/delete
//   2. Hero — Max Cost in rose (house outflow per CLAUDE.md POV)
//   3. Cost breakdown — only the components that actually contribute
//      to Max Cost. Each row shows the dollar contribution on the
//      right, and the small calc that produced it on the left under
//      the label. Zero/null components are skipped so the card stays
//      tight on simple deals (e.g. no leaderboard, no balances).
//   4. Deal terms — the metadata the cost math doesn't directly use:
//      daily fill (balance-side, capped by WD cap), withdraw % of
//      balance, and the per-video terms when they exist. Hidden as a
//      whole if none are set.
//   5. Notes — italic muted block at the bottom.

function EstimateCard({ estimate }: { estimate: CreatorEstimate }) {
  const [editOpen, setEditOpen] = useState(false);
  const max = maxCost(estimate);
  const lbRaw = rawLbCost(estimate);
  const videoNet = weeklyVideoNet(estimate);
  const weeks = estimate.dealLengthWeeks ?? 0;

  // Build the cost breakdown rows lazily — only show lines that
  // actually contribute non-zero $ to Max Cost. Keeps the card
  // visually tight when a deal has no leaderboard / no balances.
  const breakdownRows: BreakdownRow[] = [];
  if (estimate.withdrawalCapUsd && weeks) {
    breakdownRows.push({
      label: "Withdrawals",
      hint: `${fmt$(estimate.withdrawalCapUsd)}/wk × ${weeks} wk${weeks === 1 ? "" : "s"}`,
      amount: estimate.withdrawalCapUsd * weeks,
    });
  }
  if (videoNet > 0 && weeks) {
    breakdownRows.push({
      label: "Videos (net)",
      hint: `${fmt$(videoNet)}/wk × ${weeks} wk${weeks === 1 ? "" : "s"}`,
      amount: videoNet * weeks,
    });
  }
  if (lbRaw > 0) {
    breakdownRows.push({
      label: "Leaderboards",
      hint: `${fmt$(estimate.leaderboardCostUsd)} × ${estimate.packyPaidPercent}% packy`,
      amount: lbRaw,
    });
  }
  if (estimate.tipBalanceUsd && estimate.tipBalanceUsd > 0) {
    breakdownRows.push({
      label: "Tip balance",
      hint: "one-time",
      amount: estimate.tipBalanceUsd,
    });
  }
  if (estimate.battleBalanceUsd && estimate.battleBalanceUsd > 0) {
    breakdownRows.push({
      label: "Battle balance",
      hint: "one-time",
      amount: estimate.battleBalanceUsd,
    });
  }

  // Build deal-terms rows the same way: include only what's set so
  // we never render a section of dashes.
  const termsRows: TermRow[] = [];
  if (estimate.dailyFillUsd) {
    const wk = estimate.dailyFillUsd * 7;
    termsRows.push({
      label: "Daily fill",
      value: `${fmt$(estimate.dailyFillUsd)}/day`,
      hint: `${fmt$(wk)}/wk · balance side`,
    });
  }
  if (estimate.withdrawalPercent !== null) {
    termsRows.push({
      label: "Withdraw %",
      value: `${estimate.withdrawalPercent}%`,
      hint: "of balance",
    });
  }
  if (estimate.videoAmountUsd || estimate.videoFillsPerWeek) {
    const fills = estimate.videoFillsPerWeek ?? 0;
    const amt = estimate.videoAmountUsd ?? 0;
    const pct = estimate.videoPercent ?? 0;
    termsRows.push({
      label: "Videos",
      value: `${fmt$(amt)} × ${fills}/wk`,
      hint: pct > 0 ? `${pct}% recoup` : undefined,
    });
  }

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br from-card via-card to-card/80 p-5 transition-all hover:-translate-y-px hover:border-border hover:shadow-lg sm:p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 size-40 rounded-full bg-rose-500/[0.06] blur-3xl transition-colors duration-500 group-hover:bg-rose-500/[0.12]"
      />

      <div className="relative space-y-5">
        {/* ── Identity + actions ────────────────────────────────── */}
        <div className="flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-rose-500/10 text-rose-500">
            <Users className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="truncate text-base font-semibold leading-tight">
                {estimate.name}
              </p>
              {weeks > 0 && (
                <span className="shrink-0 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {weeks} wk{weeks === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              added {formatRelative(estimate.createdAt)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={() => setEditOpen(true)}
              aria-label="Edit"
            >
              <Pencil className="size-3.5" />
            </Button>
            <DeleteEstimateButton estimate={estimate} />
          </div>
        </div>

        {/* ── Hero: Max Cost ────────────────────────────────────── */}
        {/* Rose because it's house outflow per CLAUDE.md POV. The
            secondary line gives the admin one piece of context they
            actually want at a glance — over how many weeks does this
            $ figure cover. */}
        <div className="relative overflow-hidden rounded-xl border border-rose-500/30 bg-gradient-to-br from-rose-500/[0.08] via-rose-500/[0.04] to-transparent px-4 py-3.5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Calculator className="size-3" />
            Max cost
          </div>
          <p className="mt-1 text-3xl font-bold tabular-nums leading-none text-rose-600 dark:text-rose-400">
            {fmt$(max)}
          </p>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {weeks > 0
              ? `worst case across ${weeks} week${weeks === 1 ? "" : "s"}`
              : "worst case"}
          </p>
        </div>

        {/* ── Cost breakdown ────────────────────────────────────── */}
        {breakdownRows.length > 0 && (
          <div className="space-y-2">
            <SectionLabel icon={CircleDollarSign} label="Cost breakdown" />
            <div className="divide-y divide-border/60 rounded-xl border border-border/60 bg-muted/20">
              {breakdownRows.map((row) => (
                <BreakdownRowCell key={row.label} row={row} />
              ))}
            </div>
          </div>
        )}

        {/* ── Deal terms (metadata) ─────────────────────────────── */}
        {termsRows.length > 0 && (
          <div className="space-y-2">
            <SectionLabel icon={Settings2} label="Deal terms" />
            <div className="space-y-1.5">
              {termsRows.map((row) => (
                <TermRowCell key={row.label} row={row} />
              ))}
            </div>
          </div>
        )}

        {/* ── Notes ─────────────────────────────────────────────── */}
        {estimate.notes && (
          <div className="space-y-2">
            <SectionLabel icon={FileText} label="Notes" />
            <p className="text-xs italic text-muted-foreground">
              {estimate.notes}
            </p>
          </div>
        )}

        {/* Empty-state nudge — only render when the card has nothing
            useful to show beyond the name+ Max Cost (which would be 0).
            Encourages the admin to fill in the deal so the page is
            actually useful. */}
        {breakdownRows.length === 0 && termsRows.length === 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
            <Notebook className="size-3.5 shrink-0" />
            No terms entered yet — click the pencil to fill in the deal.
          </div>
        )}
      </div>

      <EstimateFormDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        estimate={estimate}
      />
    </div>
  );
}

// ── Card sub-pieces ───────────────────────────────────────────────

type BreakdownRow = {
  label: string;
  hint: string;
  amount: number;
};
type TermRow = {
  label: string;
  value: string;
  hint?: string;
};

function SectionLabel({
  icon: Icon,
  label,
}: {
  icon: React.ElementType;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      <Icon className="size-3" />
      {label}
    </div>
  );
}

function BreakdownRowCell({ row }: { row: BreakdownRow }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <div className="truncate text-xs font-semibold">{row.label}</div>
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {row.hint}
        </div>
      </div>
      <div className="shrink-0 text-sm font-semibold tabular-nums text-rose-600 dark:text-rose-400">
        {fmt$(row.amount)}
      </div>
    </div>
  );
}

function TermRowCell({ row }: { row: TermRow }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="truncate text-muted-foreground">{row.label}</span>
      <span className="shrink-0 text-right">
        <span className="font-semibold tabular-nums text-foreground">
          {row.value}
        </span>
        {row.hint && (
          <span className="ml-1.5 text-[10px] text-muted-foreground">
            {row.hint}
          </span>
        )}
      </span>
    </div>
  );
}

// ── Add / Edit dialog ─────────────────────────────────────────────

function EstimateFormDialog({
  open,
  onClose,
  estimate,
}: {
  open: boolean;
  onClose: () => void;
  estimate: CreatorEstimate | null;
}) {
  const router = useRouter();
  const isEdit = Boolean(estimate);
  const [name, setName] = useState(estimate?.name ?? "");
  const [dailyFill, setDailyFill] = useState(
    estimate?.dailyFillUsd != null ? String(estimate.dailyFillUsd) : "",
  );
  const [wdPercent, setWdPercent] = useState(
    estimate?.withdrawalPercent != null
      ? String(estimate.withdrawalPercent)
      : "",
  );
  const [wdCap, setWdCap] = useState(
    estimate?.withdrawalCapUsd != null
      ? String(estimate.withdrawalCapUsd)
      : "",
  );
  const [lbCost, setLbCost] = useState(
    estimate?.leaderboardCostUsd != null
      ? String(estimate.leaderboardCostUsd)
      : "",
  );
  const [packyPaid, setPackyPaid] = useState(
    estimate?.packyPaidPercent != null
      ? String(estimate.packyPaidPercent)
      : "",
  );
  const [dealLength, setDealLength] = useState(
    estimate?.dealLengthWeeks != null
      ? String(estimate.dealLengthWeeks)
      : "",
  );
  // Videos are an optional section — hidden behind a button until
  // the admin clicks "Add YouTube videos". Defaults to expanded if
  // the row already has any video data so editing existing deals
  // surfaces the fields automatically.
  const [videosEnabled, setVideosEnabled] = useState(
    estimate?.videoAmountUsd != null ||
      estimate?.videoPercent != null ||
      estimate?.videoFillsPerWeek != null,
  );
  const [videoAmount, setVideoAmount] = useState(
    estimate?.videoAmountUsd != null ? String(estimate.videoAmountUsd) : "",
  );
  const [videoPercent, setVideoPercent] = useState(
    estimate?.videoPercent != null ? String(estimate.videoPercent) : "",
  );
  const [videoFills, setVideoFills] = useState(
    estimate?.videoFillsPerWeek != null
      ? String(estimate.videoFillsPerWeek)
      : "",
  );
  const [tipBalance, setTipBalance] = useState(
    estimate?.tipBalanceUsd != null ? String(estimate.tipBalanceUsd) : "",
  );
  const [battleBalance, setBattleBalance] = useState(
    estimate?.battleBalanceUsd != null
      ? String(estimate.battleBalanceUsd)
      : "",
  );
  const [notes, setNotes] = useState(estimate?.notes ?? "");
  const [pending, startTransition] = useTransition();

  // Reset whenever the dialog opens against a different row.
  useEffect(() => {
    if (open) {
      setName(estimate?.name ?? "");
      setDailyFill(
        estimate?.dailyFillUsd != null ? String(estimate.dailyFillUsd) : "",
      );
      setWdPercent(
        estimate?.withdrawalPercent != null
          ? String(estimate.withdrawalPercent)
          : "",
      );
      setWdCap(
        estimate?.withdrawalCapUsd != null
          ? String(estimate.withdrawalCapUsd)
          : "",
      );
      setLbCost(
        estimate?.leaderboardCostUsd != null
          ? String(estimate.leaderboardCostUsd)
          : "",
      );
      setPackyPaid(
        estimate?.packyPaidPercent != null
          ? String(estimate.packyPaidPercent)
          : "",
      );
      setDealLength(
        estimate?.dealLengthWeeks != null
          ? String(estimate.dealLengthWeeks)
          : "",
      );
      setVideosEnabled(
        estimate?.videoAmountUsd != null ||
          estimate?.videoPercent != null ||
          estimate?.videoFillsPerWeek != null,
      );
      setVideoAmount(
        estimate?.videoAmountUsd != null
          ? String(estimate.videoAmountUsd)
          : "",
      );
      setVideoPercent(
        estimate?.videoPercent != null ? String(estimate.videoPercent) : "",
      );
      setVideoFills(
        estimate?.videoFillsPerWeek != null
          ? String(estimate.videoFillsPerWeek)
          : "",
      );
      setTipBalance(
        estimate?.tipBalanceUsd != null ? String(estimate.tipBalanceUsd) : "",
      );
      setBattleBalance(
        estimate?.battleBalanceUsd != null
          ? String(estimate.battleBalanceUsd)
          : "",
      );
      setNotes(estimate?.notes ?? "");
    }
  }, [open, estimate]);

  function parseDollarOrNull(v: string): number | null {
    if (!v.trim()) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function parseIntOrNull(v: string): number | null {
    if (!v.trim()) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  // Live preview of the computed Max Cost so the admin sees the
  // outcome of their inputs without having to save first. Daily
  // fill is NOT in the formula — it lives on the creator's balance
  // and only leaves via withdrawals which are already bounded by
  // wd_cap. Videos are a separate payout that adds to the weekly
  // bucket. Tip + battle are flat one-time pots.
  const previewMax = (() => {
    const cap = parseDollarOrNull(wdCap) ?? 0;
    const lb = parseDollarOrNull(lbCost) ?? 0;
    const share = parseDollarOrNull(packyPaid) ?? 0;
    const weeks = parseIntOrNull(dealLength) ?? 0;
    const videoNet = videosEnabled
      ? (parseDollarOrNull(videoAmount) ?? 0) *
        (parseIntOrNull(videoFills) ?? 0) *
        (1 - (parseDollarOrNull(videoPercent) ?? 0) / 100)
      : 0;
    const tip = parseDollarOrNull(tipBalance) ?? 0;
    const battle = parseDollarOrNull(battleBalance) ?? 0;
    return (
      (cap + videoNet) * weeks + lb * (share / 100) + tip + battle
    );
  })();

  function handleSubmit() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    const payload = {
      name: name.trim(),
      dailyFillUsd: parseDollarOrNull(dailyFill),
      withdrawalPercent: parseDollarOrNull(wdPercent),
      withdrawalCapUsd: parseDollarOrNull(wdCap),
      leaderboardCostUsd: parseDollarOrNull(lbCost),
      packyPaidPercent: parseDollarOrNull(packyPaid),
      dealLengthWeeks: parseIntOrNull(dealLength),
      videoAmountUsd: videosEnabled ? parseDollarOrNull(videoAmount) : null,
      videoPercent: videosEnabled ? parseDollarOrNull(videoPercent) : null,
      videoFillsPerWeek: videosEnabled ? parseIntOrNull(videoFills) : null,
      tipBalanceUsd: parseDollarOrNull(tipBalance),
      battleBalanceUsd: parseDollarOrNull(battleBalance),
      notes: notes.trim() || null,
    };
    startTransition(async () => {
      const result = isEdit
        ? await updateCreatorEstimate({ id: estimate!.id, ...payload })
        : await createCreatorEstimate(payload);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(isEdit ? "Deal updated" : "Deal added");
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit deal" : "Add deal"}</DialogTitle>
          <DialogDescription>
            All fields except the name are optional. Withdraw cap is
            treated as a per-week cap; leaderboard cost is one-time.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Creator name / handle"
              maxLength={80}
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Daily fill (USD)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={dailyFill}
              onChange={(e) => setDailyFill(e.target.value)}
              placeholder="50"
            />
            <p className="text-[10px] text-muted-foreground">
              Raw $ / week ={" "}
              <span className="font-mono">
                {dailyFill ? fmt$((parseDollarOrNull(dailyFill) ?? 0) * 7) : "—"}
              </span>{" "}
              · balance-side only, capped by WD cap
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Deal length (weeks)
            </Label>
            <Input
              type="number"
              step="1"
              min="0"
              value={dealLength}
              onChange={(e) => setDealLength(e.target.value)}
              placeholder="4"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Withdraw % (of wager)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={wdPercent}
              onChange={(e) => setWdPercent(e.target.value)}
              placeholder="30"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Withdraw cap / week (USD)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={wdCap}
              onChange={(e) => setWdCap(e.target.value)}
              placeholder="500"
            />
          </div>

          {/* Video deal terms — optional section behind a button.
              Same shape as daily fill (amount + % + fills) but for
              videos. Per user spec: counts into the same weekly
              bucket as the WD cap, scaled by deal length. Hidden by
              default; button reveals the inputs. Removing the
              section sends null for all three so the row stays clean. */}
          <div className="sm:col-span-2">
            {videosEnabled ? (
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                    <Youtube className="size-3.5 text-rose-500" />
                    YouTube videos
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-6 text-muted-foreground hover:text-rose-500"
                    onClick={() => {
                      setVideosEnabled(false);
                      setVideoAmount("");
                      setVideoPercent("");
                      setVideoFills("");
                    }}
                    aria-label="Remove videos"
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      $ / video (USD)
                    </Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={videoAmount}
                      onChange={(e) => setVideoAmount(e.target.value)}
                      placeholder="200"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      % (recoup)
                    </Label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={videoPercent}
                      onChange={(e) => setVideoPercent(e.target.value)}
                      placeholder="50"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      Videos / week
                    </Label>
                    <Input
                      type="number"
                      step="1"
                      min="0"
                      value={videoFills}
                      onChange={(e) => setVideoFills(e.target.value)}
                      placeholder="2"
                    />
                  </div>
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  Net / week ={" "}
                  <span className="font-mono">
                    {videoAmount && videoFills
                      ? fmt$(
                          (parseDollarOrNull(videoAmount) ?? 0) *
                            (parseIntOrNull(videoFills) ?? 0) *
                            (1 -
                              (parseDollarOrNull(videoPercent) ?? 0) / 100),
                        )
                      : "—"}
                  </span>{" "}
                  · counts into the weekly bucket alongside the WD cap.
                </p>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="w-full justify-center text-muted-foreground hover:text-foreground"
                onClick={() => setVideosEnabled(true)}
              >
                <Youtube className="size-4 text-rose-500" />
                Add YouTube videos
              </Button>
            )}
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Leaderboard cost (USD, one-time)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={lbCost}
              onChange={(e) => setLbCost(e.target.value)}
              placeholder="1000"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Packy paid % (of LB)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={packyPaid}
              onChange={(e) => setPackyPaid(e.target.value)}
              placeholder="50"
            />
            <p className="text-[10px] text-muted-foreground">
              Raw LB cost ={" "}
              <span className="font-mono">
                {lbCost && packyPaid
                  ? fmt$(
                      (parseDollarOrNull(lbCost) ?? 0) *
                        ((parseDollarOrNull(packyPaid) ?? 0) / 100),
                    )
                  : "—"}
              </span>
            </p>
          </div>

          {/* Flat balances pre-loaded onto the creator's account.
              Per user spec: just added on top of Max Cost — no
              calculation, no scaling, no recoup. Sit above the
              notes field on purpose. */}
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Tip balance (USD, one-time)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={tipBalance}
              onChange={(e) => setTipBalance(e.target.value)}
              placeholder="100"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Battle balance (USD, one-time)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={battleBalance}
              onChange={(e) => setBattleBalance(e.target.value)}
              placeholder="100"
            />
          </div>

          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs text-muted-foreground">
              Additional deal notes
            </Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Platform, agreed terms, sponsor / brand, etc."
              maxLength={500}
            />
          </div>

          {/* Live Max Cost preview — same formula the card displays */}
          <div className="sm:col-span-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <Calculator className="size-3" />
                Max cost preview
              </div>
              <span className="font-mono text-sm font-bold tabular-nums text-rose-600 dark:text-rose-400">
                {fmt$(previewMax)}
              </span>
            </div>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              (WD cap + video net) × weeks + LB cost × packy %
              + tip balance + battle balance · daily fill is balance-side
              only (capped by WD cap)
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? "Saving…" : isEdit ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Delete with confirm ────────────────────────────────────────────

function DeleteEstimateButton({ estimate }: { estimate: CreatorEstimate }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteCreatorEstimate(estimate.id);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Deal removed");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        size="icon"
        variant="ghost"
        className="size-8 text-muted-foreground hover:text-rose-500"
        onClick={() => setOpen(true)}
        aria-label="Remove"
      >
        <Trash2 className="size-3.5" />
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {estimate.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Drops this deal estimate from the planning list. Doesn&apos;t
            affect any real account or platform data — this list is
            scratchpad only.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={pending}
            className="bg-rose-500 hover:bg-rose-500/90"
          >
            {pending ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
