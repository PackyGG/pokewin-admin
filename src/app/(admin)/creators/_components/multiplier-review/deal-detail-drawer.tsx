"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  ExternalLink,
  Flag,
  PowerOff,
  Trash2,
  XCircle,
} from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { MultiplierDealResponse } from "@/lib/backend-api";
import { formatDateTime, formatRelative } from "@/lib/utils/format";

import { MultiplierApproveDialog } from "./approve-dialog";
import { MultiplierRejectDialog } from "./reject-dialog";
import { MultiplierFlagDialog } from "./flag-dialog";
import { MultiplierForceEndDialog } from "./force-end-dialog";
import { MultiplierCancelDialog } from "./cancel-dialog";
import {
  MULTIPLIER_STATUS_BADGE,
  MULTIPLIER_STATUS_LABEL,
  formatBps,
  formatFlagCode,
  formatMultiplier,
  formatStringUsd,
} from "./shared";

type Props = {
  deal: MultiplierDealResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onActionSuccess?: () => void;
};

/**
 * Side drawer showing every meaningful field of a single multiplier deal
 * with all action buttons embedded. Used identically on the creator
 * detail page (in the multiplier subtab) and on the global review queue
 * page — the only state it owns is the open/close toggle.
 *
 * Action buttons surface contextually:
 *   - pending_deposit/funded → Edit (placeholder), Cancel
 *   - live                   → Force-end
 *   - pending_review/flagged → Approve, Reject, Flag (additional manual)
 *   - terminal               → read-only
 *
 * The `onActionSuccess` callback is fired after any mutation succeeds so
 * the parent can revalidate / close the drawer. revalidatePath in the
 * server action also refreshes the Server Component data on next read.
 */
export function MultiplierDealDetailDrawer({
  deal,
  open,
  onOpenChange,
  onActionSuccess,
}: Props) {
  if (!deal) return null;

  const isOffer =
    deal.status === "pending_deposit" || deal.status === "funded";
  const isLive = deal.status === "live";
  const isReviewable =
    deal.status === "pending_review" || deal.status === "flagged";

  const handleSuccess = () => {
    onActionSuccess?.();
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full overflow-hidden p-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <SheetTitle className="text-base">Multiplier Deal</SheetTitle>
            <Badge
              variant="outline"
              className={MULTIPLIER_STATUS_BADGE[deal.status]}
            >
              {MULTIPLIER_STATUS_LABEL[deal.status]}
            </Badge>
          </div>
          <SheetDescription className="text-xs">
            {deal.id}
          </SheetDescription>
        </SheetHeader>

        <div className="h-[calc(100vh-180px)] overflow-y-auto">
          <div className="space-y-6 px-6 py-4">
            <ContractSection deal={deal} />
            {(deal.activated_at || deal.ended_at) && (
              <LifecycleSection deal={deal} />
            )}
            {deal.activated_at && <FundingSection deal={deal} />}
            {deal.ended_at && <EndOfStreamSection deal={deal} />}
            {deal.settled_at && <SettlementSection deal={deal} />}
            {deal.flagged_reasons && deal.flagged_reasons.length > 0 && (
              <FlagsSection deal={deal} />
            )}
            <TosSection deal={deal} />
            {deal.state_log && deal.state_log.length > 0 && (
              <StateLogSection deal={deal} />
            )}
          </div>
        </div>

        <div className="border-t bg-background px-6 py-3">
          <div className="flex flex-wrap items-center justify-end gap-2">
            {isOffer && (
              <MultiplierCancelDialog
                deal={deal}
                trigger={
                  <Button variant="ghost" size="sm">
                    <Trash2 className="mr-1.5 size-3.5" />
                    Cancel offer
                  </Button>
                }
                onSuccess={handleSuccess}
              />
            )}
            {isLive && (
              <MultiplierForceEndDialog
                deal={deal}
                trigger={
                  <Button variant="destructive" size="sm">
                    <PowerOff className="mr-1.5 size-3.5" />
                    Force-end
                  </Button>
                }
                onSuccess={handleSuccess}
              />
            )}
            {isReviewable && (
              <>
                <MultiplierFlagDialog
                  deal={deal}
                  trigger={
                    <Button variant="ghost" size="sm">
                      <Flag className="mr-1.5 size-3.5" />
                      Flag
                    </Button>
                  }
                  onSuccess={onActionSuccess}
                />
                <MultiplierRejectDialog
                  deal={deal}
                  trigger={
                    <Button variant="destructive" size="sm">
                      <XCircle className="mr-1.5 size-3.5" />
                      Reject
                    </Button>
                  }
                  onSuccess={handleSuccess}
                />
                <MultiplierApproveDialog
                  deal={deal}
                  trigger={
                    <Button size="sm">
                      <CheckCircle2 className="mr-1.5 size-3.5" />
                      Approve
                    </Button>
                  }
                  onSuccess={handleSuccess}
                />
              </>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Sections — small dumb sub-components for each meaningful slice
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-1.5 rounded-lg border p-3 text-sm">
        {children}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={valueClass ?? "text-sm font-medium"}>{value}</span>
    </div>
  );
}

function ContractSection({ deal }: { deal: MultiplierDealResponse }) {
  return (
    <Section title="Contract">
      <Row
        label="Required deposit"
        value={formatStringUsd(deal.required_deposit_usd)}
      />
      <Row
        label="Multiplier"
        value={formatMultiplier(deal.multiplier_bps)}
      />
      <Row
        label="Withdrawable"
        value={formatBps(deal.withdrawable_bps)}
      />
      <Row
        label="Wager requirement"
        value={`${formatBps(deal.wager_requirement_bps)} of loaded`}
      />
      {deal.max_total_wager_usd && (
        <Row
          label="Max total wager"
          value={formatStringUsd(deal.max_total_wager_usd)}
        />
      )}
      {deal.max_payout_usd && (
        <Row
          label="Max payout"
          value={formatStringUsd(deal.max_payout_usd)}
        />
      )}
      <Separator className="my-1" />
      <Row
        label="Min duration"
        value={`${Math.round(deal.min_session_duration_seconds / 60)} min`}
      />
      <Row label="Min bet count" value={deal.min_bet_count} />
      <Row
        label="Min wager / loaded"
        value={formatBps(deal.min_wager_to_funding_ratio_bps)}
      />
      <Row
        label="Kick VOD required"
        value={deal.kick_vod_required ? "Yes" : "No"}
      />
    </Section>
  );
}

function LifecycleSection({ deal }: { deal: MultiplierDealResponse }) {
  return (
    <Section title="Lifecycle">
      {deal.deposit_locked_at && (
        <Row
          label="Deposit locked"
          value={formatDateTime(deal.deposit_locked_at)}
        />
      )}
      {deal.activated_at && (
        <Row label="Activated" value={formatDateTime(deal.activated_at)} />
      )}
      {deal.ended_at && (
        <Row label="Ended" value={formatDateTime(deal.ended_at)} />
      )}
      {deal.auto_end_at && !deal.ended_at && (
        <Row
          label="Auto-end at"
          value={
            <span className="flex items-center gap-1">
              <Clock className="size-3" />
              {formatRelative(deal.auto_end_at)}
            </span>
          }
        />
      )}
      {deal.reviewed_at && (
        <Row
          label="Reviewed"
          value={formatDateTime(deal.reviewed_at)}
        />
      )}
      {deal.settled_at && (
        <Row label="Settled" value={formatDateTime(deal.settled_at)} />
      )}
    </Section>
  );
}

function FundingSection({ deal }: { deal: MultiplierDealResponse }) {
  return (
    <Section title="Funding Snapshot">
      <Row
        label="User deposit"
        value={formatStringUsd(deal.user_funding_usd)}
      />
      <Row
        label="Platform credit"
        value={formatStringUsd(deal.platform_funding_usd)}
      />
      <Row
        label="Total loaded"
        value={formatStringUsd(deal.total_loaded_usd)}
        valueClass="text-sm font-semibold"
      />
      <Separator className="my-1" />
      <Row
        label="Fill spent"
        value={formatStringUsd(deal.fill_spent_usd)}
      />
      <Row
        label="Fill refunded"
        value={formatStringUsd(deal.fill_refunded_usd)}
      />
      <Row
        label="Fill remaining"
        value={formatStringUsd(deal.fill_remaining_usd)}
      />
      <Separator className="my-1" />
      <Row
        label="Wager accumulated"
        value={formatStringUsd(deal.wager_accumulated_usd)}
      />
      <Row label="Bets placed" value={deal.bet_count} />
    </Section>
  );
}

function EndOfStreamSection({ deal }: { deal: MultiplierDealResponse }) {
  return (
    <Section title="End of Stream">
      <Row
        label="Ending balance"
        value={formatStringUsd(deal.ending_balance_usd)}
        valueClass="text-sm font-semibold"
      />
      <Row
        label="Kick VOD"
        value={
          deal.kick_vod_url ? (
            <a
              href={deal.kick_vod_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-500 hover:underline"
            >
              Open <ExternalLink className="size-3" />
            </a>
          ) : (
            <span className="text-muted-foreground">—</span>
          )
        }
      />
    </Section>
  );
}

function SettlementSection({ deal }: { deal: MultiplierDealResponse }) {
  return (
    <Section title="Settlement">
      {deal.review_decision && (
        <Row
          label="Decision"
          value={
            <Badge
              variant="outline"
              className={
                deal.review_decision === "approved"
                  ? MULTIPLIER_STATUS_BADGE.approved
                  : MULTIPLIER_STATUS_BADGE.rejected
              }
            >
              {deal.review_decision}
            </Badge>
          }
        />
      )}
      {deal.review_reason && (
        <Row
          label="Reason"
          value={
            <span className="text-right text-xs text-muted-foreground">
              {deal.review_reason}
            </span>
          }
        />
      )}
      {deal.withdrawable_voucher_usd && (
        <Row
          label="Payout voucher"
          value={formatStringUsd(deal.withdrawable_voucher_usd)}
          valueClass="text-sm font-semibold text-rose-500"
        />
      )}
      {deal.forfeited_usd && (
        <Row
          label="Total forfeited"
          value={formatStringUsd(deal.forfeited_usd)}
          valueClass="text-sm font-semibold text-emerald-500"
        />
      )}
      {deal.deposit_refunded_usd && (
        <Row
          label="Deposit refunded"
          value={formatStringUsd(deal.deposit_refunded_usd)}
          valueClass="text-sm font-medium text-rose-500"
        />
      )}
      {deal.deposit_forfeited_usd &&
        Number(deal.deposit_forfeited_usd) > 0 && (
          <Row
            label="Deposit forfeited"
            value={formatStringUsd(deal.deposit_forfeited_usd)}
            valueClass="text-sm font-medium text-emerald-500"
          />
        )}
    </Section>
  );
}

function FlagsSection({ deal }: { deal: MultiplierDealResponse }) {
  const flags = deal.flagged_reasons ?? [];
  return (
    <Section title={`Flags (${flags.length})`}>
      <div className="space-y-2">
        {flags.map((f, i) => (
          <div
            key={`${f.code}-${i}`}
            className="rounded-md border border-orange-500/30 bg-orange-500/5 p-2"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-orange-500" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-xs font-semibold">
                  {formatFlagCode(f.code)}
                  {f.code.startsWith("MANUAL:") && (
                    <Badge
                      variant="outline"
                      className="ml-2 h-4 text-[10px]"
                    >
                      manual
                    </Badge>
                  )}
                </div>
                {Object.keys(f.detail).length > 0 && (
                  <pre className="whitespace-pre-wrap break-all text-[11px] text-muted-foreground">
                    {JSON.stringify(f.detail, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function TosSection({ deal }: { deal: MultiplierDealResponse }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Section title="TOS">
      <Row label="Version" value={deal.terms_version} />
      {deal.tos_accepted_at && (
        <Row
          label="Accepted"
          value={formatDateTime(deal.tos_accepted_at)}
        />
      )}
      {deal.tos_accepted_ip && (
        <Row
          label="From IP"
          value={
            <span className="font-mono text-xs">
              {deal.tos_accepted_ip}
            </span>
          }
        />
      )}
      <div>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-xs text-blue-500 hover:underline"
        >
          {expanded ? "Hide" : "Show"} terms text
        </button>
        {expanded && (
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-[11px]">
            {deal.terms_text}
          </pre>
        )}
      </div>
    </Section>
  );
}

function StateLogSection({ deal }: { deal: MultiplierDealResponse }) {
  const log = deal.state_log ?? [];
  return (
    <Section title={`State Log (${log.length})`}>
      <div className="space-y-2">
        {log.map((entry, i) => {
          const from = String(entry.from ?? "—");
          const to = String(entry.to ?? "—");
          const by = entry.by ? String(entry.by) : null;
          const reason = entry.reason ? String(entry.reason) : null;
          const at = entry.at ? String(entry.at) : null;
          return (
            <div key={i} className="rounded-md border p-2 text-xs">
              <div className="flex items-center gap-1.5">
                <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                  {from}
                </Badge>
                <span className="text-muted-foreground">→</span>
                <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                  {to}
                </Badge>
                {at && (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {formatRelative(at)}
                  </span>
                )}
              </div>
              {reason && (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {reason}
                  {by && <span className="ml-2 font-mono">by {by}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
