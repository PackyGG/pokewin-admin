"use client";

import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { CreatorLeaderboardApprovalPayload } from "./deal-approval-actions";
import { parseUtcInput } from "./deal-form-shared";

/**
 * Leaderboard step of the creator approval dialogs — the mirror image of
 * `CreatorRewardDraftFields`.
 *
 * Deliberately narrower than the standalone instant-create dialog: no code
 * picker (a board always runs on the creator's full current code set, resolved
 * server-side) and, when bundled into a deal, no dates either (the board runs
 * exactly the deal window). Only the standalone approval dialog shows the
 * window inputs.
 */

export type CreatorLeaderboardDraft = {
  title: string;
  codes: string[];
  siteBonus: string;
  sponsoredPct: string;
  tiers: Array<{ position: string; amount: string }>;
  /** Standalone dialog only; a bundled board inherits the deal window. */
  startsAt: string;
  endsAt: string;
};

/** Five tiers is the floor the backend create schema enforces. */
const DEFAULT_TIERS = [1, 2, 3, 4, 5].map((position) => ({
  position: String(position),
  amount: "",
}));

export function buildLeaderboardDraft(
  codes: string[],
  creatorName: string,
): CreatorLeaderboardDraft {
  return {
    title: `${creatorName} Leaderboard`,
    codes,
    siteBonus: "",
    // Bundled boards default to a 50/50 split rather than the 100% the
    // standalone instant-create dialog assumes.
    sponsoredPct: "50",
    tiers: DEFAULT_TIERS.map((tier) => ({ ...tier })),
    startsAt: "",
    endsAt: "",
  };
}

export function leaderboardTierSum(draft: CreatorLeaderboardDraft): number {
  return draft.tiers.reduce((total, tier) => total + (Number(tier.amount) || 0), 0);
}

export function parseLeaderboardDraft(
  draft: CreatorLeaderboardDraft,
  options: { requireWindow?: boolean } = {},
): { payload: CreatorLeaderboardApprovalPayload } | { error: string } {
  const title = draft.title.trim();
  if (title.length < 2) return { error: "Enter a leaderboard title" };
  if (title.length > 100) return { error: "Title must be 100 characters or less" };
  if (draft.codes.length === 0) {
    return { error: "This creator has no affiliate codes, so a leaderboard cannot be created" };
  }

  const siteBonus = Number(draft.siteBonus);
  if (!Number.isFinite(siteBonus) || siteBonus <= 0) {
    return { error: "Total prize pool must be greater than zero" };
  }

  const sponsoredPct = Number(draft.sponsoredPct);
  if (!Number.isFinite(sponsoredPct) || sponsoredPct < 0 || sponsoredPct > 100) {
    return { error: "House share % must be between 0 and 100" };
  }

  const tiers = draft.tiers
    .map((tier) => ({
      position: Number(tier.position),
      prizeAmountUsd: Number(tier.amount),
    }))
    .filter(
      (tier) =>
        Number.isInteger(tier.position) &&
        tier.position > 0 &&
        Number.isFinite(tier.prizeAmountUsd) &&
        tier.prizeAmountUsd > 0,
    )
    .sort((left, right) => left.position - right.position);

  if (tiers.length < 5) return { error: "At least 5 prize tiers are required" };
  if (new Set(tiers.map((tier) => tier.position)).size !== tiers.length) {
    return { error: "Prize positions must be unique" };
  }
  const tierSum = tiers.reduce((total, tier) => total + tier.prizeAmountUsd, 0);
  if (tierSum > siteBonus + 1e-6) {
    return { error: "Prize tiers cannot exceed the total prize pool" };
  }

  // Bundled boards send the deal window; the server overwrites both values
  // either way, so these are shape-only.
  let startsAt = "";
  let endsAt = "";
  if (options.requireWindow) {
    const parsedStart = parseUtcInput(draft.startsAt);
    const parsedEnd = parseUtcInput(draft.endsAt);
    if (!parsedStart) return { error: "Enter a valid start date" };
    if (!parsedEnd) return { error: "Enter a valid end date" };
    if (new Date(parsedEnd) <= new Date(parsedStart)) {
      return { error: "End must be after the start" };
    }
    if (new Date(parsedEnd) <= new Date()) {
      return { error: "End must be in the future" };
    }
    startsAt = parsedStart;
    endsAt = parsedEnd;
  }

  return {
    payload: {
      title,
      prizeTiers: tiers,
      siteBonusUsd: siteBonus,
      sponsoredPct,
      codes: draft.codes,
      startsAt,
      endsAt,
    },
  };
}

export function CreatorLeaderboardDraftFields({
  draft,
  onChange,
  disabled,
  showWindow = false,
}: {
  draft: CreatorLeaderboardDraft;
  onChange: (next: CreatorLeaderboardDraft) => void;
  disabled: boolean;
  showWindow?: boolean;
}) {
  const set = <K extends keyof CreatorLeaderboardDraft>(
    key: K,
    value: CreatorLeaderboardDraft[K],
  ) => onChange({ ...draft, [key]: value });

  const totalPool = Number(draft.siteBonus) || 0;
  const tierSum = leaderboardTierSum(draft);
  const tierSumExceeds = tierSum > totalPool + 1e-6;

  function updateTier(index: number, field: "position" | "amount", value: string) {
    set(
      "tiers",
      draft.tiers.map((tier, i) => (i === index ? { ...tier, [field]: value } : tier)),
    );
  }

  function addTier() {
    const nextPosition =
      draft.tiers.length === 0
        ? 1
        : Math.max(...draft.tiers.map((tier) => Number(tier.position) || 0)) + 1;
    set("tiers", [...draft.tiers, { position: String(nextPosition), amount: "" }]);
  }

  function removeTier(index: number) {
    set(
      "tiers",
      draft.tiers.filter((_, i) => i !== index),
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Title: <span className="font-medium text-foreground">{draft.title}</span>
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="approval_lb_pool">Total prize pool (USD, site-funded)</Label>
        <Input
          id="approval_lb_pool"
          type="number"
          min={0}
          step="0.01"
          value={draft.siteBonus}
          onChange={(event) => set("siteBonus", event.target.value)}
          placeholder="5000"
          disabled={disabled}
        />
        <p className="text-[11px] text-muted-foreground">
          Runs on all {draft.codes.length} of this creator&apos;s affiliate codes.
        </p>
      </div>

      {showWindow && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="approval_lb_start">Starts (UTC)</Label>
            <Input
              id="approval_lb_start"
              type="datetime-local"
              value={draft.startsAt}
              onChange={(event) => set("startsAt", event.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="approval_lb_end">Ends (UTC)</Label>
            <Input
              id="approval_lb_end"
              type="datetime-local"
              value={draft.endsAt}
              onChange={(event) => set("endsAt", event.target.value)}
              disabled={disabled}
            />
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Prize tiers</Label>
          <span
            className={
              tierSumExceeds
                ? "text-xs font-medium text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            Sum: ${tierSum.toFixed(2)} / ${totalPool.toFixed(2)}
          </span>
        </div>
        <div className="space-y-2">
          {draft.tiers.map((tier, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                step={1}
                placeholder="Pos"
                value={tier.position}
                onChange={(event) => updateTier(index, "position", event.target.value)}
                className="w-16 sm:w-24"
                disabled={disabled}
              />
              <Input
                type="number"
                min={0}
                step="0.01"
                placeholder="Amount USD"
                value={tier.amount}
                onChange={(event) => updateTier(index, "amount", event.target.value)}
                className="flex-1"
                disabled={disabled}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeTier(index)}
                className="shrink-0"
                disabled={disabled}
                aria-label={`Remove tier ${index + 1}`}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addTier}
            disabled={disabled}
          >
            <Plus className="mr-1 size-4" />
            Add tier
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="approval_lb_sponsored">House share % (cost math only)</Label>
        <Input
          id="approval_lb_sponsored"
          type="number"
          min={0}
          max={100}
          step={1}
          value={draft.sponsoredPct}
          onChange={(event) => set("sponsoredPct", event.target.value)}
          placeholder="50"
          disabled={disabled}
        />
        <p className="text-[11px] text-muted-foreground">
          Portion of the prize pool the house pays on-site. Default 50%.
        </p>
      </div>
    </div>
  );
}
