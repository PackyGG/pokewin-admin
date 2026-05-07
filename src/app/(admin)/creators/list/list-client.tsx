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
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { formatRelative } from "@/lib/utils/format";
import {
  createCreatorEstimate,
  deleteCreatorEstimate,
  updateCreatorEstimate,
} from "./actions";

type Cadence = "weekly" | "biweekly" | "monthly";

export type CreatorEstimate = {
  id: string;
  name: string;
  cadence: Cadence;
  fillAmountUsd: number | null;
  fillPercent: number | null;
  withdrawalCapUsd: number | null;
  withdrawalPercent: number | null;
  tipCapUsd: number | null;
  freeBattleCapUsd: number | null;
  notes: string | null;
  createdAt: string;
};

const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: "Weekly",
  biweekly: "Bi-weekly",
  monthly: "Monthly",
};

const CADENCE_COLORS: Record<Cadence, string> = {
  weekly:
    "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  biweekly:
    "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  monthly:
    "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
};

function periodsPerMonth(c: Cadence): number {
  if (c === "weekly") return 52 / 12;
  if (c === "biweekly") return 26 / 12;
  return 1;
}

function maxMonthlySpend(e: CreatorEstimate): number {
  const fill = e.fillAmountUsd ?? 0;
  const fillKeep = e.fillPercent ?? 0;
  const fillNet = fill * (1 - fillKeep / 100);
  const wd = e.withdrawalCapUsd ?? 0;
  const tip = e.tipCapUsd ?? 0;
  const fb = e.freeBattleCapUsd ?? 0;
  return (fillNet + wd + tip + fb) * periodsPerMonth(e.cadence);
}

function fmt$(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

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

// ── Card ──────────────────────────────────────────────────────────

function EstimateCard({ estimate }: { estimate: CreatorEstimate }) {
  const [editOpen, setEditOpen] = useState(false);
  const monthly = maxMonthlySpend(estimate);

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
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge
                variant="outline"
                className={
                  "text-[10px] " + CADENCE_COLORS[estimate.cadence]
                }
              >
                {CADENCE_LABELS[estimate.cadence]}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                added {formatRelative(estimate.createdAt)}
              </span>
            </div>
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

        {/* Headline: max monthly spend (worst case) — rose because
            it's a house outflow per CLAUDE.md house POV. */}
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Calculator className="size-3" />
            Max monthly spend
          </div>
          <p className="mt-0.5 text-2xl font-bold tabular-nums text-rose-600 dark:text-rose-400">
            {fmt$(monthly)}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Worst case — every cap consumed, fills net of recoup
          </p>
        </div>

        {/* Caps grid */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-3">
          <Stat label="Fill / period">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {fmt$(estimate.fillAmountUsd)}
              {estimate.fillPercent !== null && (
                <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                  · keep {estimate.fillPercent}%
                </span>
              )}
            </span>
          </Stat>
          <Stat label="WD cap">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {fmt$(estimate.withdrawalCapUsd)}
              {estimate.withdrawalPercent !== null && (
                <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                  · {estimate.withdrawalPercent}%
                </span>
              )}
            </span>
          </Stat>
          <Stat label="Tip cap">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {fmt$(estimate.tipCapUsd)}
            </span>
          </Stat>
          <Stat label="Free battle cap">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {fmt$(estimate.freeBattleCapUsd)}
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
  const [cadence, setCadence] = useState<Cadence>(
    estimate?.cadence ?? "monthly",
  );
  const [fillAmount, setFillAmount] = useState(
    estimate?.fillAmountUsd != null ? String(estimate.fillAmountUsd) : "",
  );
  const [fillPercent, setFillPercent] = useState(
    estimate?.fillPercent != null ? String(estimate.fillPercent) : "",
  );
  const [wdCap, setWdCap] = useState(
    estimate?.withdrawalCapUsd != null
      ? String(estimate.withdrawalCapUsd)
      : "",
  );
  const [wdPercent, setWdPercent] = useState(
    estimate?.withdrawalPercent != null
      ? String(estimate.withdrawalPercent)
      : "",
  );
  const [tipCap, setTipCap] = useState(
    estimate?.tipCapUsd != null ? String(estimate.tipCapUsd) : "",
  );
  const [fbCap, setFbCap] = useState(
    estimate?.freeBattleCapUsd != null
      ? String(estimate.freeBattleCapUsd)
      : "",
  );
  const [notes, setNotes] = useState(estimate?.notes ?? "");
  const [pending, startTransition] = useTransition();

  // Reset whenever the dialog opens against a different row.
  useEffect(() => {
    if (open) {
      setName(estimate?.name ?? "");
      setCadence(estimate?.cadence ?? "monthly");
      setFillAmount(
        estimate?.fillAmountUsd != null ? String(estimate.fillAmountUsd) : "",
      );
      setFillPercent(
        estimate?.fillPercent != null ? String(estimate.fillPercent) : "",
      );
      setWdCap(
        estimate?.withdrawalCapUsd != null
          ? String(estimate.withdrawalCapUsd)
          : "",
      );
      setWdPercent(
        estimate?.withdrawalPercent != null
          ? String(estimate.withdrawalPercent)
          : "",
      );
      setTipCap(estimate?.tipCapUsd != null ? String(estimate.tipCapUsd) : "");
      setFbCap(
        estimate?.freeBattleCapUsd != null
          ? String(estimate.freeBattleCapUsd)
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

  function handleSubmit() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    const payload = {
      name: name.trim(),
      cadence,
      fillAmountUsd: parseDollarOrNull(fillAmount),
      fillPercent: parseDollarOrNull(fillPercent),
      withdrawalCapUsd: parseDollarOrNull(wdCap),
      withdrawalPercent: parseDollarOrNull(wdPercent),
      tipCapUsd: parseDollarOrNull(tipCap),
      freeBattleCapUsd: parseDollarOrNull(fbCap),
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit deal" : "Add deal"}</DialogTitle>
          <DialogDescription>
            All caps and percentages are optional. Use whichever
            fields apply to this deal.
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
            <Label className="text-xs text-muted-foreground">Cadence</Label>
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value as Cadence)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Fill amount (USD per period)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={fillAmount}
              onChange={(e) => setFillAmount(e.target.value)}
              placeholder="500"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Fill recoup % (house keeps)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              max="100"
              value={fillPercent}
              onChange={(e) => setFillPercent(e.target.value)}
              placeholder="20"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Withdrawal cap (USD per period)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={wdCap}
              onChange={(e) => setWdCap(e.target.value)}
              placeholder="1000"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Withdrawal % (of wager)
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
              Tip cap (USD per period)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={tipCap}
              onChange={(e) => setTipCap(e.target.value)}
              placeholder="200"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Free battle cap (USD per period)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={fbCap}
              onChange={(e) => setFbCap(e.target.value)}
              placeholder="100"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs text-muted-foreground">Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Platform, agreed terms, etc."
              maxLength={500}
            />
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

