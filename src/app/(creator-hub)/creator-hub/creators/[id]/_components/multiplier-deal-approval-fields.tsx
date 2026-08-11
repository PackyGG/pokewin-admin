"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import type { CreatorMultiplierApprovalPayload } from "./deal-approval-actions";

export type MultiplierDealDraft = {
  approvalExpiresOn: string;
  requiredDepositUsd: string;
  multiplierX: string;
  wagerRequirementPct: string;
  maxTotalWagerUsd: string;
  maxPayoutUsd: string;
  minSessionMinutes: string;
  minBetCount: string;
  minWagerToFundingPct: string;
  kickVodRequired: boolean;
  autoRenew: boolean;
};

export function buildMultiplierDealDraft(): MultiplierDealDraft {
  const expiry = new Date();
  expiry.setUTCDate(expiry.getUTCDate() + 7);
  return {
    approvalExpiresOn: expiry.toISOString().slice(0, 10),
    requiredDepositUsd: "5",
    multiplierX: "5",
    wagerRequirementPct: "100",
    maxTotalWagerUsd: "",
    maxPayoutUsd: "",
    minSessionMinutes: "0",
    minBetCount: "0",
    minWagerToFundingPct: "0",
    kickVodRequired: false,
    autoRenew: true,
  };
}

function optionalMoney(value: string): number | null | undefined {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && Math.round(parsed * 100) === parsed * 100
    ? parsed
    : undefined;
}

export function parseMultiplierDealDraft(
  draft: MultiplierDealDraft,
): { payload: CreatorMultiplierApprovalPayload } | { error: string } {
  const expiry = new Date(`${draft.approvalExpiresOn}T23:59:59.999Z`);
  const deposit = Number(draft.requiredDepositUsd);
  const multiplier = Number(draft.multiplierX);
  const wager = Number(draft.wagerRequirementPct);
  const duration = Number(draft.minSessionMinutes);
  const bets = Number(draft.minBetCount);
  const wagerRatio = Number(draft.minWagerToFundingPct);
  const maxWager = optionalMoney(draft.maxTotalWagerUsd);
  const maxPayout = optionalMoney(draft.maxPayoutUsd);
  if (!Number.isFinite(expiry.getTime()) || expiry <= new Date()) return { error: "Approval expiry must be in the future" };
  if (!Number.isFinite(deposit) || deposit <= 0 || Math.round(deposit * 100) !== deposit * 100) return { error: "Minimum deposit must be a positive dollar amount" };
  if (!Number.isFinite(multiplier) || multiplier < 1) return { error: "Multiplier must be 1x or higher" };
  if (!Number.isFinite(wager) || wager < 0) return { error: "Wager requirement must be 0% or higher" };
  if (!Number.isInteger(duration) || duration < 0) return { error: "Minimum session must be a whole number of minutes" };
  if (!Number.isInteger(bets) || bets < 0) return { error: "Minimum bet count must be a whole number" };
  if (!Number.isFinite(wagerRatio) || wagerRatio < 0 || wagerRatio > 100) return { error: "Minimum wager / funding ratio must be 0–100%" };
  if (maxWager === undefined) return { error: "Max total wager must be a valid dollar amount or blank" };
  if (maxPayout === undefined) return { error: "Max payout must be a valid dollar amount or blank" };
  const multiplierBps = Math.round(multiplier * 10_000);
  return { payload: {
    approval_expires_at: expiry.toISOString(),
    required_deposit_usd: deposit,
    multiplier_bps: multiplierBps,
    withdrawable_bps: Math.round(100_000_000 / multiplierBps),
    wager_requirement_bps: Math.round(wager * 100),
    max_total_wager_usd: maxWager,
    max_payout_usd: maxPayout,
    min_session_duration_seconds: duration * 60,
    min_bet_count: bets,
    min_wager_to_funding_ratio_bps: Math.round(wagerRatio * 100),
    kick_vod_required: draft.kickVodRequired,
    auto_renew: draft.autoRenew,
  } };
}

export function MultiplierDealApprovalFields({
  draft,
  onChange,
  disabled,
}: {
  draft: MultiplierDealDraft;
  onChange: (draft: MultiplierDealDraft) => void;
  disabled: boolean;
}) {
  const update = <K extends keyof MultiplierDealDraft>(key: K, value: MultiplierDealDraft[K]) =>
    onChange({ ...draft, [key]: value });
  const multiplier = Number(draft.multiplierX);
  const withdrawable = Number.isFinite(multiplier) && multiplier > 0 ? 100 / multiplier : null;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Approval expires (UTC)"><Input type="date" value={draft.approvalExpiresOn} onChange={(event) => update("approvalExpiresOn", event.target.value)} disabled={disabled} /></Field>
        <Field label="Minimum deposit ($)"><Input type="number" min="0.01" step="0.01" value={draft.requiredDepositUsd} onChange={(event) => update("requiredDepositUsd", event.target.value)} disabled={disabled} /></Field>
        <Field label="Multiplier (x)"><Input type="number" min="1" step="0.1" value={draft.multiplierX} onChange={(event) => update("multiplierX", event.target.value)} disabled={disabled} /></Field>
        <Field label="Withdrawable"><Input value={withdrawable == null ? "—" : `${withdrawable.toFixed(2)}%`} disabled readOnly /></Field>
        <Field label="Wager requirement (%)"><Input type="number" min="0" step="1" value={draft.wagerRequirementPct} onChange={(event) => update("wagerRequirementPct", event.target.value)} disabled={disabled} /></Field>
        <Field label="Minimum session (minutes)"><Input type="number" min="0" step="1" value={draft.minSessionMinutes} onChange={(event) => update("minSessionMinutes", event.target.value)} disabled={disabled} /></Field>
        <Field label="Max total wager ($)"><Input type="number" min="0" step="0.01" placeholder="No cap" value={draft.maxTotalWagerUsd} onChange={(event) => update("maxTotalWagerUsd", event.target.value)} disabled={disabled} /></Field>
        <Field label="Max payout ($)"><Input type="number" min="0" step="0.01" placeholder="No cap" value={draft.maxPayoutUsd} onChange={(event) => update("maxPayoutUsd", event.target.value)} disabled={disabled} /></Field>
        <Field label="Minimum bet count"><Input type="number" min="0" step="1" value={draft.minBetCount} onChange={(event) => update("minBetCount", event.target.value)} disabled={disabled} /></Field>
        <Field label="Min wager / funding (%)"><Input type="number" min="0" max="100" step="1" value={draft.minWagerToFundingPct} onChange={(event) => update("minWagerToFundingPct", event.target.value)} disabled={disabled} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Toggle label="Require Kick VOD" checked={draft.kickVodRequired} onCheckedChange={(value) => update("kickVodRequired", value)} disabled={disabled} />
        <Toggle label="Auto-renew after settlement" checked={draft.autoRenew} onCheckedChange={(value) => update("autoRenew", value)} disabled={disabled} />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label className="text-xs">{label}</Label>{children}</div>;
}

function Toggle({ label, checked, onCheckedChange, disabled }: { label: string; checked: boolean; onCheckedChange: (value: boolean) => void; disabled: boolean }) {
  return <div className="flex items-center justify-between rounded-lg border p-3"><Label className="text-sm">{label}</Label><Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} /></div>;
}
