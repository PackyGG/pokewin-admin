"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { CheckCircle2, HandCoins, Plus, Repeat2, Scale } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ux";
import { formatCurrency, formatDate } from "@/lib/utils/format";

import {
  loadCreatorCodesForApproval,
  loadCreatorNameForApproval,
  submitCreatorDealApproval,
  type CreatorLeaderboardApprovalPayload,
  type CreatorMultiplierApprovalPayload,
  type CreatorPnlApprovalPayload,
  type CreatorRewardApprovalPayload,
} from "./deal-approval-actions";
import {
  buildMultiplierDealDraft,
  MultiplierDealApprovalFields,
  parseMultiplierDealDraft,
  type MultiplierDealDraft,
} from "./multiplier-deal-approval-fields";
import {
  buildPnlDealDraft,
  parsePnlDealDraft,
  PnlDealApprovalFields,
  type PnlDealDraft,
} from "./pnl-deal-approval-fields";
import {
  buildRewardDraft,
  CreatorRewardDraftFields,
  parseRewardDraft,
  type CreatorRewardDraft,
} from "./creator-reward-draft-fields";
import {
  buildLeaderboardDraft,
  CreatorLeaderboardDraftFields,
  parseLeaderboardDraft,
  type CreatorLeaderboardDraft,
} from "./creator-leaderboard-draft-fields";
import {
  buildCreateDefaults,
  dealFormSchema,
  DealFormFields,
  toDealPayload,
  type DealFormState,
  type DealPayload,
} from "./deal-form-shared";

type Step = "type" | "deal" | "multiplier" | "pnl" | "rewards" | "leaderboard" | "confirm" | "queued";
type DealType = "fill" | "multiplier" | "pnl";

export function NewDealDialog({ userId }: { userId: string }) {
  const initialDeal = useMemo(() => buildCreateDefaults(), []);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("type");
  const [dealType, setDealType] = useState<DealType | null>(null);
  const [deal, setDeal] = useState<DealFormState>(initialDeal);
  const [dealPayload, setDealPayload] = useState<DealPayload | null>(null);
  const [multiplierDraft, setMultiplierDraft] = useState<MultiplierDealDraft>(() => buildMultiplierDealDraft());
  const [multiplierPayload, setMultiplierPayload] = useState<CreatorMultiplierApprovalPayload | null>(null);
  const [pnlDraft, setPnlDraft] = useState<PnlDealDraft>(() => buildPnlDealDraft());
  const [pnlPayload, setPnlPayload] = useState<CreatorPnlApprovalPayload | null>(null);
  const [availableCodes, setAvailableCodes] = useState<string[]>([]);
  const [rewardDraft, setRewardDraft] = useState<CreatorRewardDraft>(() =>
    buildRewardDraft([]),
  );
  const [rewardPayload, setRewardPayload] =
    useState<CreatorRewardApprovalPayload | null>(null);
  const [leaderboardDraft, setLeaderboardDraft] =
    useState<CreatorLeaderboardDraft>(() => buildLeaderboardDraft([], userId));
  const [leaderboardPayload, setLeaderboardPayload] =
    useState<CreatorLeaderboardApprovalPayload | null>(null);
  const [queued, setQueued] = useState<{
    requestId: string;
    status: string;
    deliveryQueued: boolean;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([
      loadCreatorCodesForApproval(userId),
      loadCreatorNameForApproval(userId),
    ])
      .then(([codes, creatorName]) => {
        if (cancelled) return;
        setAvailableCodes(codes);
        setRewardDraft(buildRewardDraft(codes));
        setLeaderboardDraft(buildLeaderboardDraft(codes, creatorName));
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load this creator's codes");
      });
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  function reset() {
    const defaults = buildCreateDefaults();
    setStep("type");
    setDealType(null);
    setDeal(defaults);
    setDealPayload(null);
    setMultiplierDraft(buildMultiplierDealDraft());
    setMultiplierPayload(null);
    setPnlDraft(buildPnlDealDraft());
    setPnlPayload(null);
    setAvailableCodes([]);
    setRewardDraft(buildRewardDraft([]));
    setRewardPayload(null);
    setLeaderboardDraft(buildLeaderboardDraft([], userId));
    setLeaderboardPayload(null);
    setQueued(null);
  }

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (next) reset();
  }

  function updateDeal<K extends keyof DealFormState>(
    key: K,
    value: DealFormState[K],
  ) {
    setDeal((current) => ({ ...current, [key]: value }));
  }

  function continueFromDeal() {
    const parsed = dealFormSchema.safeParse(deal);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid deal input");
      return;
    }
    const payload = toDealPayload(parsed.data, { forceLeaderboardsOff: true });
    if (!payload) {
      toast.error("Enter a valid start date and duration");
      return;
    }
    setDealPayload(payload);
    setStep("rewards");
  }

  function continueFromMultiplier() {
    const parsed = parseMultiplierDealDraft(multiplierDraft);
    if ("error" in parsed) {
      toast.error(parsed.error);
      return;
    }
    setMultiplierPayload(parsed.payload);
    setStep("confirm");
  }

  function continueFromPnl() {
    const parsed = parsePnlDealDraft(pnlDraft);
    if ("error" in parsed) {
      toast.error(parsed.error);
      return;
    }
    setPnlPayload(parsed.payload);
    setStep("rewards");
  }

  function continueFromRewards() {
    const parsed = parseRewardDraft(rewardDraft);
    if ("error" in parsed) {
      toast.error(parsed.error);
      return;
    }
    setRewardPayload(parsed.payload);
    setStep("leaderboard");
  }

  function continueFromLeaderboard() {
    const parsed = parseLeaderboardDraft(leaderboardDraft);
    if ("error" in parsed) {
      toast.error(parsed.error);
      return;
    }
    // The leaderboard is bundled with this deal, so its window is the same
    // validated UTC window. The API derives it server-side, but the payload
    // schema still requires ISO values before that derivation runs.
    setLeaderboardPayload({
      ...parsed.payload,
      startsAt:
        dealType === "pnl"
          ? (pnlPayload?.frame_start_utc ?? parsed.payload.startsAt)
          : (dealPayload?.week_start_utc ?? parsed.payload.startsAt),
      endsAt:
        dealType === "pnl"
          ? (pnlPayload?.frame_end_utc ?? parsed.payload.endsAt)
          : (dealPayload?.week_end_utc ?? parsed.payload.endsAt),
    });
    setStep("confirm");
  }

  function submit() {
    if (dealType === "fill" && !dealPayload) return;
    if (dealType === "multiplier" && !multiplierPayload) return;
    if (dealType === "pnl" && !pnlPayload) return;
    startTransition(async () => {
      const result = await submitCreatorDealApproval({
        creatorUserId: userId,
        dealPayload: dealType === "fill" ? dealPayload : null,
        multiplierPayload: dealType === "multiplier" ? multiplierPayload : null,
        pnlPayload: dealType === "pnl" ? pnlPayload : null,
        rewardPayload: dealType === "fill" || dealType === "pnl" ? rewardPayload : null,
        leaderboardPayload: dealType === "fill" || dealType === "pnl" ? leaderboardPayload : null,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setQueued(result);
      setStep("queued");
      toast.success("Creator approval queued");
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Plus className="mr-1 size-3.5" />
        New Deal
      </DialogTrigger>

      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-400">
              <HandCoins className="size-4" />
            </span>
            {step === "type" && "Choose deal type"}
            {step === "deal" && "New creator deal"}
            {step === "multiplier" && "New multiplier deal"}
            {step === "pnl" && "New PnL deal"}
            {step === "rewards" && "Creator reward program"}
            {step === "leaderboard" && "Affiliate leaderboard"}
            {step === "confirm" && "Confirm approval request"}
            {step === "queued" && "Sent for creator approval"}
          </DialogTitle>
          <DialogDescription>
            {step === "type" && "Send a fill, multiplier, or frame-based PnL deal through the creator's Discord approval flow."}
            {step === "deal" &&
              "Select the start date and deal length."}
            {step === "multiplier" &&
              "Set the deposit, multiplier, wagering, and activity requirements."}
            {step === "pnl" &&
              "Set the frame, positive-profit share, content funding, tips, and sponsorship limits."}
            {step === "rewards" &&
              "Optional. Add rewards now, or skip this step and submit only the deal."}
            {step === "leaderboard" &&
              "Optional. Site-funded, runs the deal window on all of this creator's codes."}
            {step === "confirm" &&
              "Nothing is created yet. The creator or a linked site admin must approve these terms in Discord."}
            {step === "queued" &&
              "The creator channel will receive the deal, reward details, and current terms."}
          </DialogDescription>
        </DialogHeader>

        {step === "type" && (
          <div className="grid gap-3 sm:grid-cols-3">
            <button type="button" className="rounded-xl border p-5 text-left transition-colors hover:border-emerald-500 hover:bg-emerald-500/5" onClick={() => { setDealType("fill"); setStep("deal"); }}>
              <HandCoins className="mb-3 size-5 text-emerald-600" />
              <div className="font-semibold">Fill deal</div>
              <p className="mt-1 text-sm text-muted-foreground">Scheduled fills, withdrawal conversion, tips, and sponsorship limits. Can bundle rewards and a leaderboard.</p>
            </button>
            <button type="button" className="rounded-xl border p-5 text-left transition-colors hover:border-violet-500 hover:bg-violet-500/5" onClick={() => { setDealType("multiplier"); setStep("multiplier"); }}>
              <Repeat2 className="mb-3 size-5 text-violet-600" />
              <div className="font-semibold">Multiplier deal</div>
              <p className="mt-1 text-sm text-muted-foreground">Deposit-based balance multiplier with wagering, payout, and stream activity requirements.</p>
            </button>
            <button type="button" className="rounded-xl border p-5 text-left transition-colors hover:border-pink-500 hover:bg-pink-500/5" onClick={() => { setDealType("pnl"); setStep("pnl"); }}>
              <Scale className="mb-3 size-5 text-pink-600" />
              <div className="font-semibold">PnL deal</div>
              <p className="mt-1 text-sm text-muted-foreground">Creator receives a percentage of positive realized PnL over one fixed deal frame.</p>
            </button>
          </div>
        )}

        {step === "deal" && (
          <DealFormFields
            form={deal}
            update={updateDeal}
            pending={pending}
            idPrefix="new_deal"
            mode="create"
          />
        )}

        {step === "multiplier" && (
          <MultiplierDealApprovalFields draft={multiplierDraft} onChange={setMultiplierDraft} disabled={pending} />
        )}

        {step === "pnl" && (
          <PnlDealApprovalFields
            draft={pnlDraft}
            onChange={setPnlDraft}
            disabled={pending}
          />
        )}

        {step === "rewards" && (
          <CreatorRewardDraftFields
            availableCodes={availableCodes}
            draft={rewardDraft}
            onChange={setRewardDraft}
            disabled={pending}
          />
        )}

        {step === "leaderboard" && (
          <CreatorLeaderboardDraftFields
            draft={leaderboardDraft}
            onChange={setLeaderboardDraft}
            disabled={pending}
          />
        )}

        {step === "confirm" && dealType === "fill" && dealPayload && (
          <div className="space-y-4">
            <ReviewSection title="Deal">
              <ReviewRow label="Starts" value={formatDate(dealPayload.week_start_utc, "UTC")} />
              <ReviewRow label="Ends" value={formatDate(dealPayload.week_end_utc, "UTC")} />
              <ReviewRow label="Fills" value={`${dealPayload.fills_allowed} × ${formatCurrency(dealPayload.per_fill_amount_usd)}`} />
              <ReviewRow label="Creator keeps" value={`${dealPayload.conversion_rate_bps / 100}%`} />
              <ReviewRow label="Fill cooldown" value={`${dealPayload.cooldown_minutes} minutes`} />
              <ReviewRow label="Withdrawal cap" value={dealPayload.total_withdraw_cap_usd == null ? "No limit" : formatCurrency(dealPayload.total_withdraw_cap_usd)} />
              <ReviewRow label="Tips" value={`${formatCurrency(dealPayload.max_tip_per_user_usd)} per user · ${formatCurrency(dealPayload.max_tip_per_stream_usd)} per stream`} />
              <ReviewRow label="Sponsorships" value={`${formatCurrency(dealPayload.max_sponsored_battle_usd)} per battle · ${formatCurrency(dealPayload.max_sponsorship_per_stream_usd)} per stream`} />
            </ReviewSection>
            <ReviewSection title="Rewards">
              {rewardPayload ? (
                <>
                  <ReviewRow label="Program" value={rewardPayload.name} />
                  <ReviewRow label="Codes" value={rewardPayload.codes.join(", ")} />
                  <ReviewRow label="Program ends" value={formatDate(dealPayload.week_end_utc, "UTC")} />
                  {rewardPayload.thresholdUsd != null && rewardPayload.rewardUsd != null && (
                    <ReviewRow label="Wager milestone" value={`${formatCurrency(rewardPayload.thresholdUsd)} wager → ${formatCurrency(rewardPayload.rewardUsd)} reward${rewardPayload.vipRewardUsd == null ? "" : ` · VIP ${formatCurrency(rewardPayload.vipRewardUsd)}`}`} />
                  )}
                  {rewardPayload.lossbackPct != null && rewardPayload.minDepositUsd != null && (
                    <ReviewRow label="First-deposit lossback" value={`${rewardPayload.lossbackPct}% on deposits from ${formatCurrency(rewardPayload.minDepositUsd)}`} />
                  )}
                  <ReviewRow label="Per-user cap" value={rewardPayload.maxRewardPerUserUsd == null ? "No cap" : formatCurrency(rewardPayload.maxRewardPerUserUsd)} />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Skipped — no reward program will be created.</p>
              )}
            </ReviewSection>
            <ReviewSection title="Leaderboard">
              {leaderboardPayload ? (
                <>
                  <ReviewRow label="Title" value={leaderboardPayload.title} />
                  <ReviewRow label="Codes" value={leaderboardPayload.codes.join(", ")} />
                  <ReviewRow label="Runs" value={`${formatDate(dealPayload.week_start_utc, "UTC")} → ${formatDate(dealPayload.week_end_utc, "UTC")}`} />
                  <ReviewRow label="Prize pool" value={`${formatCurrency(leaderboardPayload.siteBonusUsd)} site-funded`} />
                  <ReviewRow label="Prize tiers" value={`${leaderboardPayload.prizeTiers.length} places · ${formatCurrency(leaderboardPayload.prizeTiers.reduce((total, tier) => total + tier.prizeAmountUsd, 0))} allocated`} />
                  <ReviewRow label="House share" value={`${leaderboardPayload.sponsoredPct}%`} />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Skipped — no leaderboard will be created.</p>
              )}
            </ReviewSection>
          </div>
        )}

        {step === "confirm" && dealType === "multiplier" && multiplierPayload && (
          <div className="space-y-4">
            <ReviewSection title="Multiplier deal">
              <ReviewRow label="Approval expires" value={formatDate(multiplierPayload.approval_expires_at, "UTC")} />
              <ReviewRow label="Minimum deposit" value={formatCurrency(multiplierPayload.required_deposit_usd)} />
              <ReviewRow label="Multiplier" value={`${multiplierPayload.multiplier_bps / 10_000}x`} />
              <ReviewRow label="Withdrawable" value={`${multiplierPayload.withdrawable_bps / 100}%`} />
              <ReviewRow label="Wager requirement" value={`${multiplierPayload.wager_requirement_bps / 100}%`} />
              <ReviewRow label="Max total wager" value={multiplierPayload.max_total_wager_usd == null ? "No cap" : formatCurrency(multiplierPayload.max_total_wager_usd)} />
              <ReviewRow label="Max payout" value={multiplierPayload.max_payout_usd == null ? "No cap" : formatCurrency(multiplierPayload.max_payout_usd)} />
              <ReviewRow label="Activity floor" value={`${multiplierPayload.min_session_duration_seconds / 60} min · ${multiplierPayload.min_bet_count} bets · ${multiplierPayload.min_wager_to_funding_ratio_bps / 100}% wager/funding`} />
              <ReviewRow label="Kick VOD" value={multiplierPayload.kick_vod_required ? "Required" : "Not required"} />
              <ReviewRow label="Auto-renew" value={multiplierPayload.auto_renew ? "Enabled" : "Disabled"} />
            </ReviewSection>
          </div>
        )}

        {step === "confirm" && dealType === "pnl" && pnlPayload && (
          <div className="space-y-4">
            <ReviewSection title="PnL deal">
              <ReviewRow label="Frame" value={`${formatDate(pnlPayload.frame_start_utc, "UTC")} → ${formatDate(pnlPayload.frame_end_utc, "UTC")}`} />
              <ReviewRow label="Creator share" value={`${pnlPayload.positive_pnl_share_bps / 100}% of positive realized PnL`} />
              <ReviewRow label="Negative PnL" value="Creator payout resets to $0 for this frame" />
              {pnlPayload.funding.type === "non_withdrawable_fills" ? (
                <>
                  <ReviewRow label="Funding" value={`${pnlPayload.funding.fills_allowed} × ${formatCurrency(pnlPayload.funding.per_fill_amount_usd)} non-withdrawable fills`} />
                  <ReviewRow label="Fill cooldown" value={`${pnlPayload.funding.cooldown_minutes} minutes`} />
                </>
              ) : pnlPayload.funding.type === "new_multiplier" ? (
                <>
                  <ReviewRow label="Funding" value={`${pnlPayload.funding.multiplier_bps / 10_000}x multiplier on ${formatCurrency(pnlPayload.funding.required_deposit_usd)} minimum deposit`} />
                  <ReviewRow label="Real-money attribution" value={`${pnlPayload.funding.withdrawable_bps / 100}% of multiplier-session activity`} />
                  <ReviewRow label="Wager requirement" value={`${pnlPayload.funding.wager_requirement_bps / 100}%`} />
                </>
              ) : (
                <ReviewRow label="Funding" value={`Linked multiplier ${pnlPayload.funding.multiplier_deal_id}`} />
              )}
              <ReviewRow label="Tips" value={`${formatCurrency(pnlPayload.max_tip_per_user_usd)} per user · ${formatCurrency(pnlPayload.max_tip_per_stream_usd)} per stream`} />
              <ReviewRow label="Sponsorships" value={`${formatCurrency(pnlPayload.max_sponsored_battle_usd)} per battle · ${formatCurrency(pnlPayload.max_sponsorship_per_stream_usd)} per stream`} />
            </ReviewSection>
            <ReviewSection title="Rewards">
              {rewardPayload ? (
                <>
                  <ReviewRow label="Program" value={rewardPayload.name} />
                  <ReviewRow label="Codes" value={rewardPayload.codes.join(", ")} />
                  <ReviewRow label="Runs through" value={formatDate(pnlPayload.frame_end_utc, "UTC")} />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Skipped — no reward program will be created.</p>
              )}
            </ReviewSection>
            <ReviewSection title="Leaderboard">
              {leaderboardPayload ? (
                <>
                  <ReviewRow label="Title" value={leaderboardPayload.title} />
                  <ReviewRow label="Frame" value={`${formatDate(pnlPayload.frame_start_utc, "UTC")} → ${formatDate(pnlPayload.frame_end_utc, "UTC")}`} />
                  <ReviewRow label="Prize pool" value={`${formatCurrency(leaderboardPayload.siteBonusUsd)} site-funded · ${leaderboardPayload.sponsoredPct}% house share`} />
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Skipped — no leaderboard will be created.</p>
              )}
            </ReviewSection>
          </div>
        )}

        {step === "queued" && queued && (
          <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
            <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="size-5" />
              Approval request saved
            </div>
            <p className="text-sm text-muted-foreground">
              {queued.deliveryQueued
                ? "Discord delivery is queued. Nothing will be created or activated until the creator approves."
                : "The request is saved, but Discord delivery was not queued. Its delivery state is retained for retry."}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              {queued.requestId} · {queued.status}
            </p>
          </div>
        )}

        <DialogFooter>
          {step === "type" && (
            <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
          )}
          {step === "deal" && (
            <>
              <Button type="button" variant="outline" onClick={() => setStep("type")} disabled={pending}>Back</Button>
              <Button type="button" onClick={continueFromDeal} disabled={pending}>Next</Button>
            </>
          )}
          {step === "multiplier" && (
            <>
              <Button type="button" variant="outline" onClick={() => setStep("type")} disabled={pending}>Back</Button>
              <Button type="button" onClick={continueFromMultiplier} disabled={pending}>Review</Button>
            </>
          )}
          {step === "pnl" && (
            <>
              <Button type="button" variant="outline" onClick={() => setStep("type")} disabled={pending}>Back</Button>
              <Button type="button" onClick={continueFromPnl} disabled={pending}>Next</Button>
            </>
          )}
          {step === "rewards" && (
            <>
              <Button type="button" variant="outline" onClick={() => setStep(dealType === "pnl" ? "pnl" : "deal")} disabled={pending}>Back</Button>
              <Button type="button" variant="ghost" onClick={() => { setRewardPayload(null); setStep("leaderboard"); }} disabled={pending}>Skip rewards</Button>
              <Button type="button" onClick={continueFromRewards} disabled={pending || availableCodes.length === 0}>Next</Button>
            </>
          )}
          {step === "leaderboard" && (
            <>
              <Button type="button" variant="outline" onClick={() => setStep("rewards")} disabled={pending}>Back</Button>
              <Button type="button" variant="ghost" onClick={() => { setLeaderboardPayload(null); setStep("confirm"); }} disabled={pending}>Skip leaderboard</Button>
              <Button type="button" onClick={continueFromLeaderboard} disabled={pending || availableCodes.length === 0}>Next</Button>
            </>
          )}
          {step === "confirm" && (
            <>
              <Button type="button" variant="outline" onClick={() => setStep(dealType === "multiplier" ? "multiplier" : "leaderboard")} disabled={pending}>Back</Button>
              <Button type="button" onClick={submit} disabled={pending}>
                {pending && <Spinner size={14} />}
                {pending ? "Queueing…" : "Send to Discord"}
              </Button>
            </>
          )}
          {step === "queued" && (
            <DialogClose render={<Button />}>Done</DialogClose>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
