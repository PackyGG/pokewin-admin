"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  CREATOR_PNL_DEAL_DURATION_DAYS,
  CREATOR_PNL_MAX_MULTIPLIER_X,
  isCreatorPnlDealDurationAllowed,
} from "@/lib/creator-pnl-contract";

import type { CreatorPnlApprovalPayload } from "./deal-approval-actions";
import { endDateForDuration, parseUtcInput, toUtcDateInputValue } from "./deal-form-shared";

export type PnlFundingMode = "fills" | "multiplier";

export type PnlDealDraft = {
  startsOn: string;
  durationDays: string;
  sharePct: string;
  fundingMode: PnlFundingMode;
  fillsAllowed: string;
  perFillUsd: string;
  cooldownMinutes: string;
  requiredDepositUsd: string;
  multiplierX: string;
  wagerRequirementPct: string;
  maxTotalWagerUsd: string;
  maxPayoutUsd: string;
  minSessionMinutes: string;
  minBetCount: string;
  minWagerToFundingPct: string;
  kickVodRequired: boolean;
  maxTipPerStreamUsd: string;
  maxTipPerUserUsd: string;
  maxSponsoredBattleUsd: string;
  maxSponsorshipPerStreamUsd: string;
};

const PNL_SHARE_QUICK_PICKS = [5, 10, 20, 25, 30] as const;
const PNL_WEEK_QUICK_PICKS = [1, 2, 3, 4] as const;

export function buildPnlDealDraft(): PnlDealDraft {
  return {
    startsOn: toUtcDateInputValue(new Date()),
    durationDays: "7",
    sharePct: "20",
    fundingMode: "fills",
    fillsAllowed: "7",
    perFillUsd: "100",
    cooldownMinutes: "300",
    requiredDepositUsd: "5",
    multiplierX: "5",
    wagerRequirementPct: "100",
    maxTotalWagerUsd: "",
    maxPayoutUsd: "",
    minSessionMinutes: "0",
    minBetCount: "0",
    minWagerToFundingPct: "0",
    kickVodRequired: false,
    maxTipPerStreamUsd: "100",
    maxTipPerUserUsd: "20",
    maxSponsoredBattleUsd: "50",
    maxSponsorshipPerStreamUsd: "200",
  };
}

function cents(value: string, options: { positive?: boolean } = {}): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  const lowerBoundOk = options.positive ? parsed > 0 : parsed >= 0;
  return Number.isFinite(parsed) && lowerBoundOk && Math.round(parsed * 100) === parsed * 100
    ? parsed
    : null;
}

export function parsePnlDealDraft(
  draft: PnlDealDraft,
): { payload: CreatorPnlApprovalPayload } | { error: string } {
  const frameStart = parseUtcInput(draft.startsOn);
  const durationDays = Number(draft.durationDays);
  const frameEnd = frameStart && Number.isInteger(durationDays)
    ? endDateForDuration(draft.startsOn, durationDays)
    : "";
  const sharePct = Number(draft.sharePct);
  if (!frameStart || !frameEnd) return { error: "Enter a valid UTC start date and duration" };
  if (new Date(frameEnd) <= new Date()) return { error: "The PnL deal must end in the future" };
  if (!isCreatorPnlDealDurationAllowed(frameStart, frameEnd)) {
    return { error: "PnL deal duration must be exactly 1, 2, 3, or 4 weeks" };
  }
  if (!Number.isFinite(sharePct) || sharePct <= 0 || sharePct > 100) {
    return { error: "Creator PnL share must be greater than 0% and at most 100%" };
  }

  const maxTipPerStream = cents(draft.maxTipPerStreamUsd);
  const maxTipPerUser = cents(draft.maxTipPerUserUsd);
  const maxSponsoredBattle = cents(draft.maxSponsoredBattleUsd);
  const maxSponsorshipPerStream = cents(draft.maxSponsorshipPerStreamUsd);
  if ([maxTipPerStream, maxTipPerUser, maxSponsoredBattle, maxSponsorshipPerStream].some((value) => value == null)) {
    return { error: "Tip and sponsorship limits must be valid non-negative dollar amounts" };
  }
  if (maxSponsorshipPerStream! < maxSponsoredBattle!) {
    return { error: "Per-stream sponsorship must cover at least one sponsored battle" };
  }

  let funding: CreatorPnlApprovalPayload["funding"];
  if (draft.fundingMode === "fills") {
    const fillsAllowed = Number(draft.fillsAllowed);
    const perFill = cents(draft.perFillUsd, { positive: true });
    const cooldown = Number(draft.cooldownMinutes);
    if (!Number.isInteger(fillsAllowed) || fillsAllowed < 1) {
      return { error: "Non-withdrawable fills must be a positive whole number" };
    }
    if (perFill == null) return { error: "Per-fill amount must be a positive dollar amount" };
    if (!Number.isInteger(cooldown) || cooldown < 0) {
      return { error: "Fill cooldown must be a non-negative whole number of minutes" };
    }
    funding = {
      type: "non_withdrawable_fills",
      fills_allowed: fillsAllowed,
      per_fill_amount_usd: perFill,
      cooldown_minutes: cooldown,
    };
  } else {
    const deposit = cents(draft.requiredDepositUsd, { positive: true });
    const multiplier = Number(draft.multiplierX);
    const wager = Number(draft.wagerRequirementPct);
    const maxWager = draft.maxTotalWagerUsd.trim() === "" ? null : cents(draft.maxTotalWagerUsd);
    const maxPayout = draft.maxPayoutUsd.trim() === "" ? null : cents(draft.maxPayoutUsd);
    const minSessionMinutes = Number(draft.minSessionMinutes);
    const minBetCount = Number(draft.minBetCount);
    const minWagerToFunding = Number(draft.minWagerToFundingPct);
    if (deposit == null) return { error: "Minimum deposit must be a positive dollar amount" };
    if (!Number.isFinite(multiplier) || multiplier < 2 || multiplier > CREATOR_PNL_MAX_MULTIPLIER_X) {
      return { error: `PnL multiplier must be between 2x and ${CREATOR_PNL_MAX_MULTIPLIER_X}x` };
    }
    if (!Number.isFinite(wager) || wager < 0) return { error: "Wager requirement must be 0% or higher" };
    if (draft.maxTotalWagerUsd.trim() !== "" && maxWager == null) return { error: "Max wager must be a valid dollar amount or blank" };
    if (draft.maxPayoutUsd.trim() !== "" && maxPayout == null) return { error: "Max payout must be a valid dollar amount or blank" };
    if (!Number.isInteger(minSessionMinutes) || minSessionMinutes < 0) return { error: "Minimum session must be whole minutes" };
    if (!Number.isInteger(minBetCount) || minBetCount < 0) return { error: "Minimum bet count must be a whole number" };
    if (!Number.isFinite(minWagerToFunding) || minWagerToFunding < 0 || minWagerToFunding > 100) {
      return { error: "Minimum wager/funding ratio must be between 0% and 100%" };
    }
    const multiplierBps = Math.round(multiplier * 10_000);
    funding = {
      type: "new_multiplier",
      required_deposit_usd: deposit,
      multiplier_bps: multiplierBps,
      withdrawable_bps: Math.round(100_000_000 / multiplierBps),
      wager_requirement_bps: Math.round(wager * 100),
      max_total_wager_usd: maxWager,
      max_payout_usd: maxPayout,
      min_session_duration_seconds: minSessionMinutes * 60,
      min_bet_count: minBetCount,
      min_wager_to_funding_ratio_bps: Math.round(minWagerToFunding * 100),
      kick_vod_required: draft.kickVodRequired,
      auto_renew: false,
    };
  }

  return {
    payload: {
      frame_start_utc: frameStart,
      frame_end_utc: frameEnd,
      positive_pnl_share_bps: Math.round(sharePct * 100),
      funding,
      max_tip_per_stream_usd: maxTipPerStream!,
      max_tip_per_user_usd: maxTipPerUser!,
      max_sponsored_battle_usd: maxSponsoredBattle!,
      max_sponsorship_per_stream_usd: maxSponsorshipPerStream!,
    },
  };
}

export function PnlDealApprovalFields({
  draft,
  onChange,
  disabled,
}: {
  draft: PnlDealDraft;
  onChange: (draft: PnlDealDraft) => void;
  disabled: boolean;
}) {
  const set = <K extends keyof PnlDealDraft>(key: K, value: PnlDealDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const multiplier = Number(draft.multiplierX);
  const realMoneyPct = Number.isFinite(multiplier) && multiplier >= 2 ? 100 / multiplier : null;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Starts (UTC)"><Input type="date" value={draft.startsOn} onChange={(event) => set("startsOn", event.target.value)} disabled={disabled} /></Field>
        <Field label="Length">
          <div className="grid grid-cols-4 gap-1">
            {PNL_WEEK_QUICK_PICKS.map((weeks) => {
              const days = weeks * 7;
              return (
                <button
                  key={weeks}
                  type="button"
                  disabled={disabled}
                  onClick={() => set("durationDays", String(days))}
                  className={cn(
                    "rounded-md border px-2 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    Number(draft.durationDays) === days
                      ? "border-pink-500 bg-pink-500/10 text-pink-600 dark:text-pink-400"
                      : "hover:border-pink-500/50 hover:bg-muted/50",
                  )}
                >
                  {weeks}w
                </button>
              );
            })}
          </div>
          <span className="text-[11px] text-muted-foreground">
            {CREATOR_PNL_DEAL_DURATION_DAYS.join(", ")} days
          </span>
        </Field>
        <Field label="Creator share of positive PnL">
          <div className="space-y-2">
            <Input type="number" min="0.01" max="100" step="0.01" value={draft.sharePct} onChange={(event) => set("sharePct", event.target.value)} disabled={disabled} />
            <div className="grid grid-cols-5 gap-1">
              {PNL_SHARE_QUICK_PICKS.map((percentage) => (
                <button
                  key={percentage}
                  type="button"
                  disabled={disabled}
                  onClick={() => set("sharePct", String(percentage))}
                  className={cn(
                    "rounded-md border px-1.5 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    Number(draft.sharePct) === percentage
                      ? "border-pink-500 bg-pink-500/10 text-pink-600 dark:text-pink-400"
                      : "hover:border-pink-500/50 hover:bg-muted/50",
                  )}
                >
                  {percentage}%
                </button>
              ))}
            </div>
          </div>
        </Field>
      </div>

      <section className="space-y-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Content funding</h3>
          <p className="text-[11px] text-muted-foreground">Choose exactly one. PnL fills can never be withdrawn; multiplier play counts only its real-money share.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <FundingButton selected={draft.fundingMode === "fills"} onClick={() => set("fundingMode", "fills")} title="Non-withdrawable fills" text="House-funded content balance. Conversion and withdrawal are disabled." />
          <FundingButton selected={draft.fundingMode === "multiplier"} onClick={() => set("fundingMode", "multiplier")} title="New multiplier" text={`Creator deposits real money. Multiplier can be 2x to ${CREATOR_PNL_MAX_MULTIPLIER_X}x.`} />
        </div>
      </section>

      {draft.fundingMode === "fills" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Fills"><Input type="number" min="1" step="1" value={draft.fillsAllowed} onChange={(event) => set("fillsAllowed", event.target.value)} disabled={disabled} /></Field>
          <Field label="Per fill (USD)"><Input type="number" min="0.01" step="0.01" value={draft.perFillUsd} onChange={(event) => set("perFillUsd", event.target.value)} disabled={disabled} /></Field>
          <Field label="Cooldown (minutes)"><Input type="number" min="0" step="1" value={draft.cooldownMinutes} onChange={(event) => set("cooldownMinutes", event.target.value)} disabled={disabled} /></Field>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Minimum deposit (USD)"><Input type="number" min="0.01" step="0.01" value={draft.requiredDepositUsd} onChange={(event) => set("requiredDepositUsd", event.target.value)} disabled={disabled} /></Field>
            <Field label="Multiplier"><Input type="number" min="2" max={CREATOR_PNL_MAX_MULTIPLIER_X} step="0.01" value={draft.multiplierX} onChange={(event) => set("multiplierX", event.target.value)} disabled={disabled} /></Field>
            <Field label="Real-money share"><Input readOnly disabled value={realMoneyPct == null ? "—" : `${realMoneyPct.toFixed(2)}%`} /></Field>
            <Field label="Wager requirement"><Input type="number" min="0" step="0.01" value={draft.wagerRequirementPct} onChange={(event) => set("wagerRequirementPct", event.target.value)} disabled={disabled} /></Field>
            <Field label="Max total wager (optional)"><Input type="number" min="0" step="0.01" placeholder="No cap" value={draft.maxTotalWagerUsd} onChange={(event) => set("maxTotalWagerUsd", event.target.value)} disabled={disabled} /></Field>
            <Field label="Max payout (optional)"><Input type="number" min="0" step="0.01" placeholder="No cap" value={draft.maxPayoutUsd} onChange={(event) => set("maxPayoutUsd", event.target.value)} disabled={disabled} /></Field>
            <Field label="Minimum session (minutes)"><Input type="number" min="0" step="1" value={draft.minSessionMinutes} onChange={(event) => set("minSessionMinutes", event.target.value)} disabled={disabled} /></Field>
            <Field label="Minimum bet count"><Input type="number" min="0" step="1" value={draft.minBetCount} onChange={(event) => set("minBetCount", event.target.value)} disabled={disabled} /></Field>
            <Field label="Min wager/funding"><Input type="number" min="0" max="100" step="0.01" value={draft.minWagerToFundingPct} onChange={(event) => set("minWagerToFundingPct", event.target.value)} disabled={disabled} /></Field>
          </div>
          <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
            Require Kick VOD
            <Switch checked={draft.kickVodRequired} onCheckedChange={(value) => set("kickVodRequired", value)} disabled={disabled} />
          </label>
        </div>
      )}

      <section className="space-y-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tips & sponsored battles</h3>
          <p className="text-[11px] text-muted-foreground">Realized spend is deducted from the frame PnL.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tip per stream (USD)"><Input type="number" min="0" step="0.01" value={draft.maxTipPerStreamUsd} onChange={(event) => set("maxTipPerStreamUsd", event.target.value)} disabled={disabled} /></Field>
          <Field label="Tip per user (USD)"><Input type="number" min="0" step="0.01" value={draft.maxTipPerUserUsd} onChange={(event) => set("maxTipPerUserUsd", event.target.value)} disabled={disabled} /></Field>
          <Field label="Sponsored battle (USD)"><Input type="number" min="0" step="0.01" value={draft.maxSponsoredBattleUsd} onChange={(event) => set("maxSponsoredBattleUsd", event.target.value)} disabled={disabled} /></Field>
          <Field label="Sponsorship per stream (USD)"><Input type="number" min="0" step="0.01" value={draft.maxSponsorshipPerStreamUsd} onChange={(event) => set("maxSponsorshipPerStreamUsd", event.target.value)} disabled={disabled} /></Field>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label className="text-xs">{label}</Label>{children}</div>;
}

function FundingButton({ selected, onClick, title, text }: { selected: boolean; onClick: () => void; title: string; text: string }) {
  return (
    <button type="button" onClick={onClick} className={cn("rounded-lg border p-3 text-left", selected && "border-pink-500 bg-pink-500/5 ring-1 ring-pink-500/20")}>
      <span className="block text-sm font-semibold">{title}</span>
      <span className="mt-1 block text-xs text-muted-foreground">{text}</span>
    </button>
  );
}
