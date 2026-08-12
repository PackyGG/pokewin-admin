"use client";

import { useState, useTransition } from "react";
import { Ban, History } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ux";
import type { AdminCreatorPnlDeal } from "@/lib/creator-pnl-settlement";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils/format";

import { cancelCreatorPnlDealAction } from "./pnl-settlement-actions";

function n(value: string | null) { return Number(value ?? 0) || 0; }

export function PnlDealControls(props: {
  userId: string;
  current: AdminCreatorPnlDeal | null;
  previous: AdminCreatorPnlDeal[];
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const cancellable = Boolean(props.current && ["scheduled", "active", "settlement_pending", "calculated"].includes(props.current.status));
  return (
    <div className="flex items-center gap-2">
      {props.previous.length > 0 && (
        <Button size="sm" variant="outline" onClick={() => setHistoryOpen(true)}>
          <History className="size-3.5" /> Previous PnL
        </Button>
      )}
      {cancellable && (
        <Button size="sm" variant="destructive" onClick={() => setCancelOpen(true)}>
          <Ban className="size-3.5" /> Cancel
        </Button>
      )}

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader><DialogTitle>Previous PnL deals</DialogTitle><DialogDescription>Final frames, payouts, and stored settlement breakdowns.</DialogDescription></DialogHeader>
          <div className="space-y-3">
            {[...props.previous].sort((a, b) => b.frame_end_utc.localeCompare(a.frame_end_utc)).map((deal) => (
              <div key={deal.id} className="rounded-lg border p-3 text-xs">
                <div className="flex justify-between gap-2"><Badge variant="outline">{deal.status.replaceAll("_", " ")}</Badge><span>{formatDate(deal.frame_start_utc)} → {formatDate(deal.frame_end_utc)}</span></div>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <span>Share <b>{deal.positive_pnl_share_bps / 100}%</b></span>
                  <span>Funding <b>{deal.funding_mode.replaceAll("_", " ")}</b></span>
                  <span>Frame PnL <b>{deal.frame_site_pnl_usd == null ? "—" : formatCurrency(n(deal.frame_site_pnl_usd))}</b></span>
                  <span>Computed share <b>{deal.creator_share_usd == null ? "—" : formatCurrency(n(deal.creator_share_usd))}</b></span>
                </div>
                {deal.credited_amount_usd != null && (
                  <p className="mt-2">
                    Contractual credit <b>{formatCurrency(n(deal.credited_amount_usd))}</b>
                    {deal.credit_ledger_id ? ` · ledger ${deal.credit_ledger_id}` : ""}
                    {deal.credited_at ? ` · ${formatDateTime(deal.credited_at)}` : ""}
                    {deal.credited_by_admin_user_id ? ` · admin ${deal.credited_by_admin_user_id}` : ""}
                  </p>
                )}
                {deal.settlement_reason && <p className="mt-1 text-muted-foreground">Settlement note: {deal.settlement_reason}</p>}
                {deal.settlement_breakdown && <pre className="mt-2 max-h-44 overflow-auto rounded bg-muted/40 p-2 text-[10px]">{JSON.stringify(deal.settlement_breakdown, null, 2)}</pre>}
                {deal.cancellation_reason && <p className="mt-2 text-muted-foreground">Reason: {deal.cancellation_reason}</p>}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={(open) => !pending && setCancelOpen(open)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Cancel PnL deal</DialogTitle><DialogDescription>This permanently cancels the uncredited frame. It cannot be resumed.</DialogDescription></DialogHeader>
          {props.current?.funding_mode === "linked_multiplier" && <p className="text-xs text-muted-foreground">The pre-existing linked multiplier deal will be preserved; only this PnL contract and its bundled leaderboard/reward program are cancelled.</p>}
          <div className="space-y-1.5"><Label htmlFor="pnl-cancel-reason">Reason</Label><Input id="pnl-cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} disabled={pending} /></div>
          <DialogFooter><DialogClose render={<Button variant="outline" disabled={pending} />}>Keep deal</DialogClose><Button variant="destructive" disabled={pending || reason.trim().length < 3} onClick={() => startTransition(async () => {
            if (!props.current) return;
            const result = await cancelCreatorPnlDealAction({ userId: props.userId, dealId: props.current.id, reason });
            if (!result.success) { toast.error(result.error); return; }
            toast.success("PnL deal cancelled"); setCancelOpen(false);
          })}>{pending ? <Spinner size={14} /> : <Ban className="size-4" />}{pending ? "Cancelling…" : "Cancel PnL deal"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
