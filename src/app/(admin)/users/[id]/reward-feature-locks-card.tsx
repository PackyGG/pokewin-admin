"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { AlertTriangle, BadgeDollarSign, Gift, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  type UserFeatureLocks,
} from "@/lib/backend-api/feature-locks";
import {
  REWARD_LOCK_CATEGORIES,
  type RewardLockCategory,
} from "@/lib/contracts/reward-locks";
import {
  updateUserFiatAutoApprovalAction,
  updateUserRewardLocksAction,
} from "./reward-feature-locks-actions";

const REWARD_LOCK_OPTIONS: Array<{
  key: RewardLockCategory;
  label: string;
  description: string;
}> = [
  {
    key: "tips",
    label: "Tips",
    description: "Blocks sending and receiving creator tips.",
  },
  {
    key: "rain",
    label: "Rain",
    description: "Blocks joining rain and contributing rain tips.",
  },
  {
    key: "daily_packs",
    label: "Daily packs",
    description: "Blocks opening daily reward packs.",
  },
  {
    key: "sponsored_battles",
    label: "Sponsored battles",
    description: "Blocks creating or joining sponsored battles.",
  },
  {
    key: "rakeback",
    label: "Rakeback",
    description: "Blocks normal and early rakeback claims.",
  },
  {
    key: "leaderboards",
    label: "Leaderboards & races",
    description: "Blocks leaderboard and race prize claims.",
  },
];

export function RewardFeatureLocksCard({
  userId,
  data,
  canManageRewardLocks,
  canManageFiatAutoApproval,
}: {
  userId: string;
  data: UserFeatureLocks | null;
  canManageRewardLocks: boolean;
  canManageFiatAutoApproval: boolean;
}) {
  const [rewardPending, startRewardTransition] = useTransition();
  const [fiatPending, startFiatTransition] = useTransition();
  const [categories, setCategories] = useState<RewardLockCategory[]>(
    data?.locked_reward_categories ?? [],
  );
  const [fiatAutoApproval, setFiatAutoApproval] = useState(
    data?.fiat_deposit_auto_approval_enabled ?? false,
  );

  useEffect(() => {
    setCategories(data?.locked_reward_categories ?? []);
  }, [data?.locked_reward_categories]);

  useEffect(() => {
    setFiatAutoApproval(data?.fiat_deposit_auto_approval_enabled ?? false);
  }, [data?.fiat_deposit_auto_approval_enabled]);

  const lockedSet = useMemo(() => new Set(categories), [categories]);
  const allRewardsLocked = REWARD_LOCK_CATEGORIES.every((category) =>
    lockedSet.has(category),
  );
  const rewardStatus =
    categories.length === 0
      ? "Open"
      : allRewardsLocked
        ? "All locked"
        : `${categories.length} locked`;

  if (!data) {
    return (
      <Card className="border-dashed">
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">Backend controls unavailable</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                Reward locks and the Fiat auto-approval override could not be
                loaded. No change is available until the authoritative backend
                state can be read.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const saveRewardCategories = (next: RewardLockCategory[]) => {
    const previous = categories;
    setCategories(next);
    startRewardTransition(async () => {
      const result = await updateUserRewardLocksAction({
        userId,
        categories: next,
      });
      if (result.success) {
        setCategories(result.data.locked_reward_categories);
        toast.success(
          result.data.locked_reward_categories.length === 0
            ? "Reward access unlocked"
            : "Reward locks updated",
        );
        return;
      }
      setCategories(previous);
      toast.error(result.error);
    });
  };

  const saveFiatAutoApproval = (enabled: boolean) => {
    const previous = fiatAutoApproval;
    setFiatAutoApproval(enabled);
    startFiatTransition(async () => {
      const result = await updateUserFiatAutoApprovalAction({ userId, enabled });
      if (result.success) {
        setFiatAutoApproval(result.data.enabled);
        toast.success(
          result.data.enabled
            ? "Fiat auto-approval override enabled"
            : "Fiat auto-approval override disabled",
        );
        return;
      }
      setFiatAutoApproval(previous);
      toast.error(result.error);
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Gift className="size-4 text-muted-foreground" />
              Reward access
            </CardTitle>
            <CardDescription>
              Locks are independent and can be combined. The master switch
              selects or clears every reward category.
            </CardDescription>
          </div>
          <Badge
            variant="outline"
            className={
              categories.length > 0
                ? "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
                : "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            }
          >
            {rewardStatus}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-rose-500/25 bg-rose-500/5 p-3">
          <div>
            <p className="text-sm font-medium">Whole rewards lock</p>
            <p className="text-xs text-muted-foreground">
              Blocks every reward category listed below.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {rewardPending && <Loader2 className="size-4 animate-spin" />}
            <Switch
              aria-label="Whole rewards lock"
              checked={allRewardsLocked}
              disabled={!canManageRewardLocks || rewardPending}
              onCheckedChange={(checked) =>
                saveRewardCategories(
                  checked ? [...REWARD_LOCK_CATEGORIES] : [],
                )
              }
            />
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {REWARD_LOCK_OPTIONS.map((option) => {
            const locked = lockedSet.has(option.key);
            return (
              <div
                key={option.key}
                className="flex items-start justify-between gap-3 rounded-lg border bg-muted/20 p-3"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{option.label}</span>
                    <Badge
                      variant="outline"
                      className={
                        locked
                          ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                          : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      }
                    >
                      {locked ? "Locked" : "Open"}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {option.description}
                  </p>
                </div>
                <Switch
                  aria-label={`${option.label} lock`}
                  checked={locked}
                  disabled={!canManageRewardLocks || rewardPending}
                  onCheckedChange={(checked) =>
                    saveRewardCategories(
                      checked
                        ? [...categories, option.key]
                        : categories.filter((category) => category !== option.key),
                    )
                  }
                />
              </div>
            );
          })}
        </div>

        <div className="border-t pt-5">
          <div className="flex items-start justify-between gap-4 rounded-lg border border-blue-500/25 bg-blue-500/5 p-3">
            <div className="space-y-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                <BadgeDollarSign className="size-4 text-blue-600 dark:text-blue-400" />
                Fiat deposit auto-approval override
              </p>
              <p className="max-w-2xl text-xs text-muted-foreground">
                When enabled, this user&apos;s verified Fiat deposits credit
                automatically even while the global automatic-credit switch is
                off. Fraud, KYC, dispute, refund, and compliance checks still
                apply.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={
                  fiatAutoApproval
                    ? "border-blue-500/30 bg-blue-500/15 text-blue-600 dark:text-blue-400"
                    : "text-muted-foreground"
                }
              >
                {fiatAutoApproval ? "Override on" : "Uses global policy"}
              </Badge>
              {fiatPending && <Loader2 className="size-4 animate-spin" />}
              <Switch
                aria-label="Fiat deposit auto-approval override"
                checked={fiatAutoApproval}
                disabled={!canManageFiatAutoApproval || fiatPending}
                onCheckedChange={saveFiatAutoApproval}
              />
            </div>
          </div>
          {!canManageFiatAutoApproval && (
            <p className="mt-2 text-xs text-muted-foreground">
              Administrator access is required to change the Fiat override.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
