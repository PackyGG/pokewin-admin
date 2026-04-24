"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, DollarSign, Clock, Trophy, Monitor, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils/format";
import { createDeal, updateDeal, deleteDeal, manualFill } from "../actions";

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
  dailyFillAmount: number | null;
  dailyFillTime: string | null;
  dailyFillEnabled: boolean;
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
  dailyFillAmount: string;
  dailyFillTime: string;
  dailyFillEnabled: boolean;
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
  dailyFillAmount: "",
  dailyFillTime: "13:00",
  dailyFillEnabled: false,
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
  const [fillingDealId, setFillingDealId] = useState<string | null>(null);
  const [fillConfirmDeal, setFillConfirmDeal] = useState<Deal | null>(null);

  function openCreate() {
    setEditingDeal(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  function openEdit(deal: Deal) {
    setEditingDeal(deal);
    setForm({
      dealName: deal.dealName ?? "",
      dealType: deal.dealType,
      amount: String(deal.amount),
      currency: deal.currency,
      startDate: deal.startDate.split("T")[0],
      endDate: deal.endDate ? deal.endDate.split("T")[0] : "",
      notes: deal.notes ?? "",
      dailyFillAmount: deal.dailyFillAmount != null ? String(deal.dailyFillAmount) : "",
      dailyFillTime: deal.dailyFillTime ?? "13:00",
      dailyFillEnabled: deal.dailyFillEnabled,
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
  }

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
          dailyFillAmount: optionalNumber(form.dailyFillAmount),
          dailyFillTime: form.dailyFillTime || null,
          dailyFillEnabled: form.dailyFillEnabled,
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

  function handleDelete(dealId: string) {
    startTransition(async () => {
      try {
        await deleteDeal(dealId);
        toast.success("Deal deleted");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to delete deal");
      }
    });
  }

  function handleManualFill(dealId: string) {
    const deal = deals.find((d) => d.id === dealId);
    if (deal) setFillConfirmDeal(deal);
  }

  function confirmFill() {
    if (!fillConfirmDeal) return;
    const dealId = fillConfirmDeal.id;
    setFillConfirmDeal(null);
    setFillingDealId(dealId);
    startTransition(async () => {
      try {
        await manualFill(userId, dealId);
        toast.success("Balance filled successfully");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to fill balance");
      } finally {
        setFillingDealId(null);
      }
    });
  }

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
            <DealCard key={d.id} deal={d} onEdit={openEdit} onDelete={handleDelete} onFill={handleManualFill} isPending={isPending} fillingDealId={fillingDealId} />
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
                  onChange={(e) => setForm({ ...form, dealName: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Type</Label>
                  <Select value={form.dealType} onValueChange={(v) => v && setForm({ ...form, dealType: v })}>
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
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Currency</Label>
                  <Input
                    value={form.currency}
                    onChange={(e) => setForm({ ...form, currency: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Start Date</Label>
                  <Input
                    type="date"
                    value={form.startDate}
                    onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>End Date</Label>
                  <Input
                    type="date"
                    value={form.endDate}
                    onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  />
                </div>
              </div>
            </div>

            {/* Balance Fill */}
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <DollarSign className="size-4" />
                Balance Fill
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Daily Fill ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="500.00"
                    value={form.dailyFillAmount}
                    onChange={(e) => setForm({ ...form, dailyFillAmount: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Fill Time (UTC)</Label>
                  <Input
                    type="time"
                    value={form.dailyFillTime}
                    onChange={(e) => setForm({ ...form, dailyFillTime: e.target.value })}
                  />
                </div>
                <div className="flex items-end gap-2 pb-1">
                  <Switch
                    checked={form.dailyFillEnabled}
                    onCheckedChange={(v) => setForm({ ...form, dailyFillEnabled: v })}
                  />
                  <Label className="text-sm">Enabled</Label>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Keep Percentage (%)</Label>
                  <Input
                    type="number"
                    step="1"
                    placeholder="20"
                    value={form.keepPercentage}
                    onChange={(e) => setForm({ ...form, keepPercentage: e.target.value })}
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
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Currency Limit ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="200.00"
                    value={form.currencyLimitAmount}
                    onChange={(e) => setForm({ ...form, currencyLimitAmount: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Reset Days</Label>
                  <Input
                    type="number"
                    min="1"
                    placeholder="7"
                    value={form.currencyLimitResetDays}
                    onChange={(e) => setForm({ ...form, currencyLimitResetDays: e.target.value })}
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
                    onChange={(e) => setForm({ ...form, percentageLimit: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Tip Limit ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="10.00"
                    value={form.tipLimit}
                    onChange={(e) => setForm({ ...form, tipLimit: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Tip Reset Days</Label>
                  <Input
                    type="number"
                    min="1"
                    placeholder="7"
                    value={form.tipLimitResetDays}
                    onChange={(e) => setForm({ ...form, tipLimitResetDays: e.target.value })}
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
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Prize Pool ($)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="1000.00"
                    value={form.leaderboardPrizePool}
                    onChange={(e) => setForm({ ...form, leaderboardPrizePool: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Our Share (%)</Label>
                  <Input
                    type="number"
                    step="1"
                    placeholder="50"
                    value={form.leaderboardOurShare}
                    onChange={(e) => setForm({ ...form, leaderboardOurShare: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Frequency</Label>
                  <Select value={form.leaderboardFrequency || null} onValueChange={(v) => setForm({ ...form, leaderboardFrequency: v ?? "" })}>
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
                  onChange={(e) => setForm({ ...form, minStreamMinutes: e.target.value })}
                />
              </div>
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                placeholder="Deal terms, conditions..."
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
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

      {/* Fill Now confirmation */}
      <Dialog open={!!fillConfirmDeal} onOpenChange={(open) => !open && setFillConfirmDeal(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirm Manual Fill</DialogTitle>
          </DialogHeader>
          {fillConfirmDeal && (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">You are about to manually fill the balance for this deal:</p>
              <div className="rounded-lg border p-3 space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Deal</span>
                  <span className="font-medium">{fillConfirmDeal.dealName || TYPE_LABELS[fillConfirmDeal.dealType] || fillConfirmDeal.dealType}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Fill Amount</span>
                  <span className="font-medium">{formatCurrency(fillConfirmDeal.dailyFillAmount ?? 0)}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">This will immediately credit the fill amount to the creator&apos;s balance.</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setFillConfirmDeal(null)}>Cancel</Button>
            <Button onClick={confirmFill}>Confirm Fill</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DealCard({
  deal,
  onEdit,
  onDelete,
  onFill,
  isPending,
  fillingDealId,
}: {
  deal: Deal;
  onEdit: (deal: Deal) => void;
  onDelete: (id: string) => void;
  onFill: (id: string) => void;
  isPending: boolean;
  fillingDealId: string | null;
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
          {deal.dailyFillAmount != null && deal.dailyFillAmount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="mr-1 h-7 text-xs"
              onClick={() => onFill(deal.id)}
              disabled={isPending || fillingDealId === deal.id}
            >
              <DollarSign className="mr-1 size-3" />
              {fillingDealId === deal.id ? "Filling..." : "Fill Now"}
            </Button>
          )}
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

          {/* Daily Fill */}
          {deal.dailyFillAmount != null && deal.dailyFillAmount > 0 && (
            <InfoBlock
              label="Daily Fill"
              value={`${formatCurrency(deal.dailyFillAmount)} @ ${deal.dailyFillTime ?? "13:00"} UTC`}
              sub={deal.dailyFillEnabled ? "Active" : "Disabled"}
              subColor={deal.dailyFillEnabled ? "text-green-500" : "text-muted-foreground"}
            />
          )}

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
}

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
