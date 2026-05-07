"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Calculator,
  Pencil,
  Plus,
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

function rawWeeklyAmount(e: CreatorEstimate): number {
  return (e.dailyFillUsd ?? 0) * 7;
}

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
  const weekly =
    rawWeeklyAmount(e) + (e.withdrawalCapUsd ?? 0) + weeklyVideoNet(e);
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

function EstimateCard({ estimate }: { estimate: CreatorEstimate }) {
  const [editOpen, setEditOpen] = useState(false);
  const max = maxCost(estimate);
  const weekly = rawWeeklyAmount(estimate);
  const lbRaw = rawLbCost(estimate);

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border/60 bg-card p-5 transition-all hover:-translate-y-px hover:border-border hover:shadow-lg sm:p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 size-40 rounded-full bg-rose-500/0 blur-3xl transition-colors duration-500 group-hover:bg-rose-500/[0.08]"
      />

      <div className="relative space-y-5">
        {/* Identity + actions */}
        <div className="flex items-start gap-3">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-rose-500/10 text-rose-500">
            <Users className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold leading-tight">
              {estimate.name}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {estimate.dealLengthWeeks
                ? `${estimate.dealLengthWeeks}-week deal · `
                : ""}
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

        {/* Headline: Max Cost — rose because it's house outflow */}
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Calculator className="size-3" />
            Max cost (over deal)
          </div>
          <p className="mt-0.5 text-2xl font-bold tabular-nums text-rose-600 dark:text-rose-400">
            {fmt$(max)}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            (raw weekly + WD cap + video net) × weeks + raw LB cost + tip + battle
          </p>
        </div>

        {/* Field grid — every column the user listed, raw inputs +
            computed derivations side by side. */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
          <Stat label="Daily fill">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {fmt$(estimate.dailyFillUsd)}
            </span>
          </Stat>
          <Stat label="Raw $ / week">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {estimate.dailyFillUsd ? fmt$(weekly) : "—"}
            </span>
          </Stat>
          <Stat label="Withdraw %">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {estimate.withdrawalPercent !== null
                ? `${estimate.withdrawalPercent}%`
                : "—"}
            </span>
          </Stat>
          <Stat label="Withdraw cap / wk">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {fmt$(estimate.withdrawalCapUsd)}
            </span>
          </Stat>
          <Stat label="Leaderboard cost">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {fmt$(estimate.leaderboardCostUsd)}
            </span>
          </Stat>
          <Stat label="Packy paid %">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {estimate.packyPaidPercent !== null
                ? `${estimate.packyPaidPercent}%`
                : "—"}
            </span>
          </Stat>
          <Stat label="Raw LB cost">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {estimate.leaderboardCostUsd && estimate.packyPaidPercent
                ? fmt$(lbRaw)
                : "—"}
            </span>
          </Stat>
          <Stat label="Deal length">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {estimate.dealLengthWeeks
                ? `${estimate.dealLengthWeeks} wk${estimate.dealLengthWeeks === 1 ? "" : "s"}`
                : "—"}
            </span>
          </Stat>
          {/* Video deal terms — same shape as daily fill but per
              video. Counts into the same weekly bucket as the WD
              cap so it scales with deal length. */}
          <Stat label="Video $ / each">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {fmt$(estimate.videoAmountUsd)}
            </span>
          </Stat>
          <Stat label="Video %">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {estimate.videoPercent !== null
                ? `${estimate.videoPercent}%`
                : "—"}
            </span>
          </Stat>
          <Stat label="Videos / week">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {estimate.videoFillsPerWeek !== null
                ? estimate.videoFillsPerWeek
                : "—"}
            </span>
          </Stat>
          <Stat label="Video net / week">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {estimate.videoAmountUsd && estimate.videoFillsPerWeek
                ? fmt$(weeklyVideoNet(estimate))
                : "—"}
            </span>
          </Stat>
          {/* Flat balances — added straight to Max Cost. Captioned
              "+" so it's obvious they're additive, not weekly. */}
          <Stat label="Tip balance">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {estimate.tipBalanceUsd !== null
                ? `+ ${fmt$(estimate.tipBalanceUsd)}`
                : "—"}
            </span>
          </Stat>
          <Stat label="Battle balance">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {estimate.battleBalanceUsd !== null
                ? `+ ${fmt$(estimate.battleBalanceUsd)}`
                : "—"}
            </span>
          </Stat>
        </div>

        {estimate.notes && (
          <p className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
            {estimate.notes}
          </p>
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

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5">{children}</div>
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
  // outcome of their inputs without having to save first. Tip +
  // battle balances are added flat (no scaling) — same as the
  // server-side maxCost helper. Video net counts into the weekly
  // bucket alongside the WD cap, but only when the videos section
  // is toggled on (otherwise it's saved as null).
  const previewMax = (() => {
    const daily = parseDollarOrNull(dailyFill) ?? 0;
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
      (daily * 7 + cap + videoNet) * weeks +
      lb * (share / 100) +
      tip +
      battle
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
              </span>
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
              (daily × 7 + WD cap + video net) × weeks + LB cost × packy %
              + tip balance + battle balance
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
