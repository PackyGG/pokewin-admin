"use client";

import { memo, useCallback, useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, DollarSign, Clock, Trophy, Monitor, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils/format";
import { createDeal, updateDeal, deleteDeal } from "../actions";

type Deal = {
  id: string;
  dealName: string | null;
  dealType: string;
  amount: number;
  currency: string;
  startDate: string;
  endDate: string | null;
  status: string;
  notes: string | null;
  keepPercentage: number | null;
  currencyLimitAmount: number | null;
  currencyLimitResetDays: number | null;
  percentageLimit: number | null;
  tipLimit: number | null;
  tipLimitResetDays: number | null;
  leaderboardPrizePool: number | null;
  leaderboardOurShare: number | null;
  leaderboardFrequency: string | null;
  minStreamMinutes: number | null;
  maxFinancialExposure: number | null;
  createdAt: string;
};

const TYPE_LABELS: Record<string, string> = {
  flat_fee: "Flat Fee",
  rev_share: "Rev Share",
  hybrid: "Hybrid",
  custom: "Custom",
};


type DealFormData = {
  dealName: string;
  dealType: string;
  amount: string;
  currency: string;
  startDate: string;
  endDate: string;
  notes: string;
  keepPercentage: string;
  currencyLimitAmount: string;
  currencyLimitResetDays: string;
  percentageLimit: string;
  tipLimit: string;
  tipLimitResetDays: string;
  leaderboardPrizePool: string;
  leaderboardOurShare: string;
  leaderboardFrequency: string;
  minStreamMinutes: string;
};

const emptyForm: DealFormData = {
  dealName: "",
  dealType: "custom",
  amount: "",
  currency: "USD",
  startDate: "",
  endDate: "",
  notes: "",
  keepPercentage: "",
  currencyLimitAmount: "",
  currencyLimitResetDays: "",
  percentageLimit: "",
  tipLimit: "",
  tipLimitResetDays: "",
  leaderboardPrizePool: "",
  leaderboardOurShare: "",
  leaderboardFrequency: "",
  minStreamMinutes: "",
};

function optionalNumber(val: string): number | null {
  if (!val) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

export function DealsCard({ userId, deals }: { userId: string; deals: Deal[] }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [form, setForm] = useState<DealFormData>(emptyForm);
  const [isPending, startTransition] = useTransition();

  // Functional updater — every onChange used to do `setForm({ ...form, x })`
  // which captures the closed-over render snapshot. Under React 18 batching
  // + fast typing this lost intermediate keystrokes. Updater form is the
  // recommended pattern (see deal-form-dialog.tsx for the same approach).
  const update = useCallback(
    <K extends keyof DealFormData>(key: K, value: DealFormData[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  function openCreate() {
    setEditingDeal(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  // Stable identity so memoized DealCard child rows don't bust their
  // memo on every parent re-render.
  const openEdit = useCallback((deal: Deal) => {
    setEditingDeal(deal);
    setForm({
      dealName: deal.dealName ?? "",
      dealType: deal.dealType,
      amount: String(deal.amount),
      currency: deal.currency,
      startDate: deal.startDate.split("T")[0],
      endDate: deal.endDate ? deal.endDate.split("T")[0] : "",
      notes: deal.notes ?? "",
      keepPercentage: deal.keepPercentage != null ? String(deal.keepPercentage * 100) : "",
      currencyLimitAmount: deal.currencyLimitAmount != null ? String(deal.currencyLimitAmount) : "",
      currencyLimitResetDays: deal.currencyLimitResetDays != null ? String(deal.currencyLimitResetDays) : "",
      percentageLimit: deal.percentageLimit != null ? String(deal.percentageLimit * 100) : "",
      tipLimit: deal.tipLimit != null ? String(deal.tipLimit) : "",
      tipLimitResetDays: deal.tipLimitResetDays != null ? String(deal.tipLimitResetDays) : "",
      leaderboardPrizePool: deal.leaderboardPrizePool != null ? String(deal.leaderboardPrizePool) : "",
      leaderboardOurShare: deal.leaderboardOurShare != null ? String(deal.leaderboardOurShare * 100) : "",
      leaderboardFrequency: deal.leaderboardFrequency ?? "",
      minStreamMinutes: deal.minStreamMinutes != null ? String(deal.minStreamMinutes) : "",
    });
    setDialogOpen(true);
  }, []);

  function handleSubmit() {
    const amount = parseFloat(form.amount);
    if (isNaN(amount) || amount < 0) {
      toast.error("Invalid amount");
      return;
    }
    if (!form.startDate) {
      toast.error("Start date is required");
      return;
    }

    const keepPct = optionalNumber(form.keepPercentage);
    const lbShare = optionalNumber(form.leaderboardOurShare);

    startTransition(async () => {
      try {
        const payload = {
          dealName: form.dealName || undefined,
          dealType: form.dealType as "flat_fee" | "rev_share" | "hybrid" | "custom",
          amount,
          currency: form.currency,
          startDate: form.startDate,
          endDate: form.endDate || undefined,
          notes: form.notes || undefined,
          keepPercentage: keepPct != null ? keepPct / 100 : null,
          currencyLimitAmount: optionalNumber(form.currencyLimitAmount),
          currencyLimitResetDays: optionalNumber(form.currencyLimitResetDays) != null ? Math.round(optionalNumber(form.currencyLimitResetDays)!) : null,
          percentageLimit: optionalNumber(form.percentageLimit) != null ? optionalNumber(form.percentageLimit)! / 100 : null,
          tipLimit: optionalNumber(form.tipLimit),
          tipLimitResetDays: optionalNumber(form.tipLimitResetDays) != null ? Math.round(optionalNumber(form.tipLimitResetDays)!) : null,
          leaderboardPrizePool: optionalNumber(form.leaderboardPrizePool),
          leaderboardOurShare: lbShare != null ? lbShare / 100 : null,
          leaderboardFrequency: form.leaderboardFrequency || null,
          minStreamMinutes: optionalNumber(form.minStreamMinutes) != null ? Math.round(optionalNumber(form.minStreamMinutes)!) : null,
        };

        if (editingDeal) {
          await updateDeal(editingDeal.id, {
            ...payload,
            dealName: payload.dealName ?? null,
            endDate: form.endDate || null,
            notes: form.notes || null,
          });
          toast.success("Deal updated");
        } else {
          await createDeal(userId, payload);
          toast.success("Deal created");
        }
        setDialogOpen(false);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to save deal");
      }
    });
  }

  const handleDelete = useCallback((dealId: string) => {
    startTransition(async () => {
      try {
        await deleteDeal(dealId);
        toast.success("Deal deleted");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to delete deal");
      }
    });
  }, []);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Deals</CardTitle>
          <Button variant="ghost" size="sm" onClick={openCreate}>
            <Plus className="mr-1 size-3.5" />
            Add Deal
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {deals.map((d) => (
            <DealCard key={d.id} deal={d} onEdit={openEdit} onDelete={handleDelete} isPending={isPending} />
          ))}
          {deals.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">No deals yet.</p>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingDeal ? "Edit Deal" : "Create Deal"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-6 py-4">
            {/* Basic info */}
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Deal Name</Label>
                <Input
                  placeholder="e.g. Twitch streamer"
                  value={form.dealName}
                  onChange={(e) => update("dealName", e.target.value)}
                />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>Type</Label>
                  <Select value={form.dealType} onValueChange={(v) => v && update("dealType", v)}>
                    <SelectTrigger>
                      <span>{TYPE_LABELS[form.dealType] ?? form.dealType}</span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="flat_fee">Flat Fee</SelectItem>
                      <SelectItem value="rev_share">Rev Share</SelectItem>
                      <SelectItem value="hybrid">Hybrid</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Base Amount ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={form.amount}
                    onChange={(e) => update("amount", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Currency</Label>
                  <Input
                    value={form.currency}
                    onChange={(e) => update("currency", e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Start Date</Label>
                  <Input
                    type="date"
                    value={form.startDate}
                    onChange={(e) => update("startDate", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>End Date</Label>
                  <Input
                    type="date"
                    value={form.endDate}
                    onChange={(e) => update("endDate", e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* Revenue Share */}
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <DollarSign className="size-4" />
                Revenue Share
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Keep Percentage (%)</Label>
                  <Input
                    type="number"
                    step="1"
                    placeholder="20"
                    value={form.keepPercentage}
                    onChange={(e) => update("keepPercentage", e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* Withdrawal Limits */}
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Clock className="size-4" />
                Withdrawal Limits
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Currency Limit ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="200.00"
                    value={form.currencyLimitAmount}
                    onChange={(e) => update("currencyLimitAmount", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Reset Days</Label>
                  <Input
                    type="number"
                    min="1"
                    placeholder="7"
                    value={form.currencyLimitResetDays}
                    onChange={(e) => update("currencyLimitResetDays", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Percentage Limit (%)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    placeholder="10"
                    value={form.percentageLimit}
                    onChange={(e) => update("percentageLimit", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Tip Limit ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="10.00"
                    value={form.tipLimit}
                    onChange={(e) => update("tipLimit", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Tip Reset Days</Label>
                  <Input
                    type="number"
                    min="1"
                    placeholder="7"
                    value={form.tipLimitResetDays}
                    onChange={(e) => update("tipLimitResetDays", e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* Leaderboard */}
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Trophy className="size-4" />
                Leaderboard
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>Prize Pool ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="1000.00"
                    value={form.leaderboardPrizePool}
                    onChange={(e) => update("leaderboardPrizePool", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Our Share (%)</Label>
                  <Input
                    type="number"
                    step="1"
                    placeholder="50"
                    value={form.leaderboardOurShare}
                    onChange={(e) => update("leaderboardOurShare", e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Frequency</Label>
                  <Select value={form.leaderboardFrequency || null} onValueChange={(v) => update("leaderboardFrequency", v ?? "")}>
                    <SelectTrigger>
                      <span>{form.leaderboardFrequency ? { weekly: "Weekly", biweekly: "Bi-weekly", monthly: "Monthly" }[form.leaderboardFrequency] ?? form.leaderboardFrequency : "Select..."}</span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="biweekly">Bi-weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            {/* Stream Requirements */}
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Monitor className="size-4" />
                Stream Requirements
              </div>
              <div className="space-y-2">
                <Label>Min Stream Time (minutes)</Label>
                <Input
                  type="number"
                  placeholder="15"
                  value={form.minStreamMinutes}
                  onChange={(e) => update("minStreamMinutes", e.target.value)}
                />
              </div>
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                placeholder="Deal terms, conditions..."
                value={form.notes}
                onChange={(e) => update("notes", e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isPending}>
              {isPending ? "Saving..." : editingDeal ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  );
}

// React.memo so a list of deals doesn't re-render every card whenever
// the parent's transition state, modal state, or any unrelated bit of
// state flips. Callers pass stable useCallback'd handlers so the memo
// actually short-circuits.
const DealCard = memo(function DealCard({
  deal,
  onEdit,
  onDelete,
  isPending,
}: {
  deal: Deal;
  onEdit: (deal: Deal) => void;
  onDelete: (id: string) => void;
  isPending: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <div className="flex items-center gap-3">
          <CardTitle className="text-base font-semibold">
            {deal.dealName || TYPE_LABELS[deal.dealType] || deal.dealType}
          </CardTitle>
          <Badge variant="outline">{TYPE_LABELS[deal.dealType] ?? deal.dealType}</Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-7" onClick={() => onEdit(deal)} disabled={isPending}>
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-destructive hover:text-destructive"
            onClick={() => onDelete(deal.id)}
            disabled={isPending}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Base Amount */}
          <InfoBlock label="Base Amount" value={formatCurrency(deal.amount)} />

          {/* Duration */}
          <InfoBlock
            label="Duration"
            value={`${deal.startDate.split("T")[0]} — ${deal.endDate ? deal.endDate.split("T")[0] : "ongoing"}`}
          />

          {/* Keep Percentage */}
          {deal.keepPercentage != null && deal.keepPercentage > 0 && (
            <InfoBlock label="Keep %" value={`${(deal.keepPercentage * 100).toFixed(0)}%`} />
          )}

          {/* Withdrawal Limits */}
          {(deal.currencyLimitAmount != null || deal.percentageLimit != null || deal.tipLimit != null) && (
            <InfoBlock
              label="Withdrawal Limits"
              value={[
                deal.currencyLimitAmount != null ? `${formatCurrency(deal.currencyLimitAmount)}${deal.currencyLimitResetDays ? ` / ${deal.currencyLimitResetDays}d` : ""}` : null,
                deal.percentageLimit != null ? `${(deal.percentageLimit * 100).toFixed(2)}%` : null,
                deal.tipLimit != null ? `Tip: ${formatCurrency(deal.tipLimit)}${deal.tipLimitResetDays ? ` / ${deal.tipLimitResetDays}d` : ""}` : null,
              ].filter(Boolean).join(" · ")}
            />
          )}

          {/* Leaderboard */}
          {deal.leaderboardPrizePool != null && deal.leaderboardPrizePool > 0 && (
            <InfoBlock
              label="Leaderboard"
              value={`${formatCurrency(deal.leaderboardPrizePool)} pool`}
              sub={`${((deal.leaderboardOurShare ?? 0) * 100).toFixed(0)}% us · ${deal.leaderboardFrequency ?? "—"}`}
            />
          )}

          {/* Min Stream */}
          {deal.minStreamMinutes != null && (
            <InfoBlock label="Min Stream" value={`${deal.minStreamMinutes} min`} />
          )}

          {/* Max Financial Exposure */}
          {deal.maxFinancialExposure != null && (
            <div className="rounded-md border border-orange-500/30 bg-orange-500/10 p-3">
              <div className="flex items-center gap-1.5 text-xs text-orange-500">
                <AlertTriangle className="size-3" />
                Max Exposure / Month
              </div>
              <p className="mt-1 text-lg font-bold text-orange-500">
                {formatCurrency(deal.maxFinancialExposure)}
              </p>
            </div>
          )}
        </div>

        {deal.notes && (
          <p className="mt-3 text-sm text-muted-foreground">{deal.notes}</p>
        )}
      </CardContent>
    </Card>
  );
});

function InfoBlock({
  label,
  value,
  sub,
  subColor,
}: {
  label: string;
  value: string;
  sub?: string;
  subColor?: string;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
      {sub && <p className={`text-xs ${subColor ?? "text-muted-foreground"}`}>{sub}</p>}
    </div>
  );
}
