"use client";

/**
 * Per-user battle limit overrides — highroller / VIP support.
 *
 * Backend resolution lives in CreationService.createBattle. For each row in
 * `user_battle_limits`:
 *
 *   max_value_usd      → overrides site_config.battle_max_value_usd
 *   base_bet_limit_usd → overrides site_config.battle_base_bet_limit_usd
 *
 * Each column is independently nullable: a row may override one limit
 * while leaving the other on the platform default. NULL == "fall back".
 *
 * Admin-only — the underlying actions use `requireAdmin()`, so non-admins
 * see read-only status (no buttons rendered).
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils/format";
import { updateUserBattleLimits, clearUserBattleLimits } from "./actions";
import type { UserDetail } from "./user-tabs-types";
import { InfoRow } from "./user-tabs-shared";

type BattleLimits = UserDetail["battleLimits"];

export function UserBattleLimitsCard({
  userId,
  limits,
  canManage,
}: {
  userId: string;
  limits: BattleLimits;
  canManage: boolean;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [isClearing, startClearTransition] = useTransition();
  const router = useRouter();

  const handleClear = () => {
    startClearTransition(async () => {
      const result = await clearUserBattleLimits(userId);
      if (result.success) {
        toast.success("Battle limit overrides removed");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Card>
      <CardContent className="pt-6 space-y-3">
        <div className="space-y-3">
          <InfoRow
            label="Max Battle Value"
            value={
              limits?.maxValueUsd != null
                ? formatCurrency(limits.maxValueUsd)
                : "Default ($10,000)"
            }
          />
          <InfoRow
            label="Base Bet Limit"
            value={
              limits?.baseBetLimitUsd != null
                ? formatCurrency(limits.baseBetLimitUsd)
                : "Default ($3,500)"
            }
          />
          <p className="text-xs text-muted-foreground">
            Empty fields fall back to the platform-wide defaults from{" "}
            <code className="font-mono">site_config</code>. The base bet limit
            scales with borrow %; the max value is the hard ceiling.
          </p>
        </div>

        {canManage && (
          <div className="flex gap-2 pt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditOpen(true)}
            >
              {limits ? "Edit Limits" : "Set Custom Limits"}
            </Button>
            {limits && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleClear}
                disabled={isClearing}
              >
                {isClearing ? "Clearing…" : "Reset to Defaults"}
              </Button>
            )}
          </div>
        )}

        <UserBattleLimitsDialog
          userId={userId}
          limits={limits}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
      </CardContent>
    </Card>
  );
}

function UserBattleLimitsDialog({
  userId,
  limits,
  open,
  onOpenChange,
}: {
  userId: string;
  limits: BattleLimits;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [maxValueUsd, setMaxValueUsd] = useState(
    limits?.maxValueUsd != null ? String(limits.maxValueUsd) : "",
  );
  const [baseBetLimitUsd, setBaseBetLimitUsd] = useState(
    limits?.baseBetLimitUsd != null ? String(limits.baseBetLimitUsd) : "",
  );
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Reset form whenever the dialog re-opens — admins editing repeatedly
  // shouldn't see stale input from a previous cancel.
  useEffect(() => {
    if (open) {
      setMaxValueUsd(
        limits?.maxValueUsd != null ? String(limits.maxValueUsd) : "",
      );
      setBaseBetLimitUsd(
        limits?.baseBetLimitUsd != null ? String(limits.baseBetLimitUsd) : "",
      );
    }
  }, [open, limits]);

  const handleSave = () => {
    const trimmedMax = maxValueUsd.trim();
    const trimmedBase = baseBetLimitUsd.trim();
    const parsedMax = trimmedMax === "" ? null : parseFloat(trimmedMax);
    const parsedBase = trimmedBase === "" ? null : parseFloat(trimmedBase);

    if (parsedMax !== null && (Number.isNaN(parsedMax) || parsedMax <= 0)) {
      toast.error("Max battle value must be a positive number");
      return;
    }
    if (parsedBase !== null && (Number.isNaN(parsedBase) || parsedBase <= 0)) {
      toast.error("Base bet limit must be a positive number");
      return;
    }

    startTransition(async () => {
      const result = await updateUserBattleLimits({
        userId,
        maxValueUsd: parsedMax,
        baseBetLimitUsd: parsedBase,
      });
      if (result.success) {
        toast.success("Battle limits updated");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Custom Battle Limits</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Max Battle Value (USD)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              placeholder="Leave empty to use default ($10,000)"
              value={maxValueUsd}
              onChange={(e) => setMaxValueUsd(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Hard ceiling on total pack cost when this user creates a battle.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Base Bet Limit (USD)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              placeholder="Leave empty to use default ($3,500)"
              value={baseBetLimitUsd}
              onChange={(e) => setBaseBetLimitUsd(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Base "out of pocket" cap. Backend scales this by{" "}
              <code className="font-mono">1 / (1 − borrow%)</code> at battle
              creation time.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
