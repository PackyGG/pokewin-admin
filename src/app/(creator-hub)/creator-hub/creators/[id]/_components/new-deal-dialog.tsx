"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { CheckCircle2, HandCoins, Plus } from "lucide-react";
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
  type CreatorRewardApprovalPayload,
} from "./deal-approval-actions";
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

type Step = "deal" | "rewards" | "leaderboard" | "confirm" | "queued";

export function NewDealDialog({ userId }: { userId: string }) {
  const initialDeal = useMemo(() => buildCreateDefaults(), []);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("deal");
  const [deal, setDeal] = useState<DealFormState>(initialDeal);
  const [dealPayload, setDealPayload] = useState<DealPayload | null>(null);
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
    setStep("deal");
    setDeal(defaults);
    setDealPayload(null);
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
      startsAt: dealPayload?.week_start_utc ?? parsed.payload.startsAt,
      endsAt: dealPayload?.week_end_utc ?? parsed.payload.endsAt,
    });
    setStep("confirm");
  }

  function submit() {
    if (!dealPayload) return;
    startTransition(async () => {
      const result = await submitCreatorDealApproval({
        creatorUserId: userId,
        dealPayload,
        rewardPayload,
        leaderboardPayload,
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
            {step === "deal" && "New creator deal"}
            {step === "rewards" && "Creator reward program"}
            {step === "leaderboard" && "Affiliate leaderboard"}
            {step === "confirm" && "Confirm approval request"}
            {step === "queued" && "Sent for creator approval"}
          </DialogTitle>
          <DialogDescription>
            {step === "deal" &&
              "Select the start date and deal length."}
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

        {step === "deal" && (
          <DealFormFields
            form={deal}
            update={updateDeal}
            pending={pending}
            idPrefix="new_deal"
            mode="create"
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

        {step === "confirm" && dealPayload && (
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

        {step === "queued" && queued && (
          <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
            <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="size-5" />
              Approval request saved
            </div>
            <p className="text-sm text-muted-foreground">
              {queued.deliveryQueued
                ? "Discord delivery is queued. The deal and rewards remain inactive until the creator approves."
                : "The request is saved, but Discord delivery was not queued. Its delivery state is retained for retry."}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              {queued.requestId} · {queued.status}
            </p>
          </div>
        )}

        <DialogFooter>
          {step === "deal" && (
            <>
              <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
              <Button type="button" onClick={continueFromDeal} disabled={pending}>Next</Button>
            </>
          )}
          {step === "rewards" && (
            <>
              <Button type="button" variant="outline" onClick={() => setStep("deal")} disabled={pending}>Back</Button>
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
              <Button type="button" variant="outline" onClick={() => setStep("leaderboard")} disabled={pending}>Back</Button>
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
