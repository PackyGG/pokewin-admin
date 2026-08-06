"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import type { CreatorRewardApprovalPayload } from "./deal-approval-actions";

export type CreatorRewardDraft = {
  name: string;
  codes: string[];
  wagerOn: boolean;
  lossbackOn: boolean;
  threshold: string;
  reward: string;
  vipReward: string;
  lossbackPct: string;
  minDeposit: string;
  cap: string;
};

export function buildRewardDraft(codes: string[]): CreatorRewardDraft {
  return {
    name: "",
    codes,
    wagerOn: true,
    lossbackOn: true,
    threshold: "1000",
    reward: "5",
    vipReward: "",
    lossbackPct: "5",
    minDeposit: "50",
    cap: "",
  };
}

export function parseRewardDraft(
  draft: CreatorRewardDraft,
): { payload: CreatorRewardApprovalPayload } | { error: string } {
  if (draft.name.trim().length < 2) return { error: "Enter a program name" };
  if (draft.codes.length === 0) return { error: "Pick at least one creator code" };
  if (!draft.wagerOn && !draft.lossbackOn) {
    return { error: "Turn on at least one reward" };
  }

  const threshold = Number(draft.threshold);
  const reward = Number(draft.reward);
  const vipReward = draft.vipReward.trim() === "" ? null : Number(draft.vipReward);
  const lossbackPct = Number(draft.lossbackPct);
  const minDeposit = Number(draft.minDeposit);
  const cap = draft.cap.trim() === "" ? null : Number(draft.cap);

  if (
    draft.wagerOn &&
    (!Number.isFinite(threshold) ||
      threshold <= 0 ||
      !Number.isFinite(reward) ||
      reward <= 0 ||
      reward >= threshold)
  ) {
    return { error: "Reward must be positive and below the wager threshold" };
  }
  if (
    draft.wagerOn &&
    vipReward != null &&
    (!Number.isFinite(vipReward) || vipReward < reward || vipReward >= threshold)
  ) {
    return { error: "VIP reward must be at least the standard reward and below the threshold" };
  }
  if (
    draft.lossbackOn &&
    (!Number.isFinite(lossbackPct) ||
      lossbackPct <= 0 ||
      lossbackPct >= 100 ||
      !Number.isFinite(minDeposit) ||
      minDeposit <= 0)
  ) {
    return { error: "Lossback must be below 100% with a positive minimum deposit" };
  }
  if (cap != null && (!Number.isFinite(cap) || cap <= 0)) {
    return { error: "Lifetime cap must be positive or left empty" };
  }

  return {
    payload: {
      name: draft.name.trim(),
      codes: draft.codes,
      thresholdUsd: draft.wagerOn ? threshold : null,
      rewardUsd: draft.wagerOn ? reward : null,
      vipRewardUsd: draft.wagerOn ? vipReward : null,
      lossbackPct: draft.lossbackOn ? lossbackPct : null,
      minDepositUsd: draft.lossbackOn ? minDeposit : null,
      maxRewardPerUserUsd: cap,
    },
  };
}

export function CreatorRewardDraftFields({
  creatorLabel,
  availableCodes,
  draft,
  onChange,
  disabled,
}: {
  creatorLabel: string;
  availableCodes: string[];
  draft: CreatorRewardDraft;
  onChange: (next: CreatorRewardDraft) => void;
  disabled: boolean;
}) {
  const set = <K extends keyof CreatorRewardDraft>(
    key: K,
    value: CreatorRewardDraft[K],
  ) => onChange({ ...draft, [key]: value });

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <span className="font-medium">{creatorLabel}</span>
        <span className="block text-[11px] text-muted-foreground">
          Fixed to the creator receiving this deal.
        </span>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="approval_reward_name">Program name</Label>
        <Input
          id="approval_reward_name"
          value={draft.name}
          onChange={(event) => set("name", event.target.value)}
          placeholder="Creator VIP rewards"
          disabled={disabled}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Codes this program accrues on</Label>
        {availableCodes.length === 0 ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            This creator has no affiliate codes, so a reward program cannot be included.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {availableCodes.map((code) => {
              const selected = draft.codes.includes(code);
              return (
                <Button
                  key={code}
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-pressed={selected}
                  className={cn(
                    "h-7 font-mono text-xs",
                    selected && "border-primary bg-primary/10 text-foreground",
                  )}
                  onClick={() =>
                    set(
                      "codes",
                      selected
                        ? draft.codes.filter((item) => item !== code)
                        : [...draft.codes, code],
                    )
                  }
                  disabled={disabled}
                >
                  {code}
                </Button>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-2 rounded-md border p-3">
        <label className="flex items-start gap-2.5">
          <Switch
            checked={draft.wagerOn}
            onCheckedChange={(value) => set("wagerOn", value)}
            disabled={disabled}
          />
          <span className="text-sm">
            Wager milestones
            <span className="block text-[11px] text-muted-foreground">
              Recurring reward for each full wager threshold.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2.5">
          <Switch
            checked={draft.lossbackOn}
            onCheckedChange={(value) => set("lossbackOn", value)}
            disabled={disabled}
          />
          <span className="text-sm">
            First-deposit lossback
            <span className="block text-[11px] text-muted-foreground">
              One-time percentage of the loss from the first deposit.
            </span>
          </span>
        </label>
      </div>

      {draft.wagerOn && (
        <div className="grid gap-3 sm:grid-cols-2">
          <MoneyField label="Wager threshold" value={draft.threshold} onChange={(v) => set("threshold", v)} disabled={disabled} />
          <MoneyField label="Standard reward" value={draft.reward} onChange={(v) => set("reward", v)} disabled={disabled} />
          <MoneyField label="VIP reward (optional)" value={draft.vipReward} onChange={(v) => set("vipReward", v)} disabled={disabled} />
        </div>
      )}

      {draft.lossbackOn && (
        <div className="grid gap-3 sm:grid-cols-2">
          <MoneyField label="Lossback percent" value={draft.lossbackPct} onChange={(v) => set("lossbackPct", v)} disabled={disabled} suffix="%" />
          <MoneyField label="Minimum first deposit" value={draft.minDeposit} onChange={(v) => set("minDeposit", v)} disabled={disabled} />
        </div>
      )}

      <MoneyField
        label="Lifetime cap per user (optional)"
        value={draft.cap}
        onChange={(value) => set("cap", value)}
        disabled={disabled}
      />
    </div>
  );
}

function MoneyField({
  label,
  value,
  onChange,
  disabled,
  suffix = "USD",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  suffix?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex justify-between">
        <span>{label}</span>
        <span className="text-[10px] font-normal text-muted-foreground">{suffix}</span>
      </Label>
      <Input
        type="number"
        min="0"
        step="0.01"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </div>
  );
}
