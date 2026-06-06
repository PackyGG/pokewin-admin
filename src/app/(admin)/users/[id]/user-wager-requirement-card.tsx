"use client";

/**
 * Per-user withdrawal wager-requirement override.
 *
 * Resolution lives on the game backend: a per-user override (0 = EXEMPT
 * from the ENTIRE requirement, bonus part included) falls back to the
 * site-wide default. Everything is in basis points (10000 bps = 1×); the
 * UI shows ×-multipliers with the raw bps alongside.
 *
 * Admin-only — the underlying actions use requireAdmin(), so non-admins
 * (canManage=false) see read-only status with no buttons.
 *
 * `data === null` means the backend read failed (the wager-requirement
 * branch isn't deployed yet) — render a muted "awaiting backend deploy"
 * state rather than crashing the Account tab.
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
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
import { InfoRow } from "./user-tabs-shared";
import {
  setUserWagerRequirementAction,
  clearUserWagerRequirementAction,
} from "./wager-requirement-actions";
import type { UserWagerRequirement } from "@/lib/backend-api/wager-requirements";

const BPS_PER_X = 10000;
const MAX_BPS = 1_000_000;

function formatX(bps: number): string {
  return `${bps / BPS_PER_X}×`;
}

function overrideLabel(bps: number | null): string {
  if (bps === null) return "None — uses site default";
  if (bps === 0) return "EXEMPT (0×) — no requirement";
  return `${formatX(bps)} (${bps} bps)`;
}

export function UserWagerRequirementCard({
  userId,
  data,
  canManage,
}: {
  userId: string;
  data: UserWagerRequirement | null;
  canManage: boolean;
}) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (!data) {
    return (
      <Card className="border-dashed">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The withdrawal wager-requirement endpoints aren&apos;t
                reachable on the current backend deploy. Per-user overrides
                become available once the feature ships to the backend.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const hasOverride = data.wager_requirement_bps !== null;

  const handleExempt = () => {
    startTransition(async () => {
      const result = await setUserWagerRequirementAction({ userId, bps: 0 });
      if (result.success) {
        toast.success("User exempted from the wager requirement");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleClear = () => {
    startTransition(async () => {
      const result = await clearUserWagerRequirementAction(userId);
      if (result.success) {
        toast.success("Override removed — user falls back to the default");
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
            label="Site default"
            value={`${formatX(data.default_wager_requirement_bps)} (${data.default_wager_requirement_bps} bps)`}
          />
          <InfoRow
            label="Override"
            value={overrideLabel(data.wager_requirement_bps)}
          />
          <InfoRow
            label="Effective"
            value={`${formatX(data.effective_wager_requirement_bps)} (${data.effective_wager_requirement_bps} bps)`}
          />
          <p className="text-xs text-muted-foreground">
            The deposit-based multiplier a user must wager before withdrawing.
            An override of <code className="font-mono">0×</code> fully exempts
            the user (bonus requirement included). With no override the user
            uses the site default from{" "}
            <code className="font-mono">site_config</code>.
          </p>
        </div>

        {canManage && (
          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              {hasOverride ? "Edit override" : "Set custom override"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleExempt}
              disabled={isPending || data.wager_requirement_bps === 0}
            >
              Exempt user (0×)
            </Button>
            {hasOverride && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleClear}
                disabled={isPending}
              >
                {isPending ? "Working…" : "Clear override"}
              </Button>
            )}
          </div>
        )}

        <UserWagerRequirementDialog
          userId={userId}
          currentBps={data.wager_requirement_bps}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
      </CardContent>
    </Card>
  );
}

function UserWagerRequirementDialog({
  userId,
  currentBps,
  open,
  onOpenChange,
}: {
  userId: string;
  currentBps: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [value, setValue] = useState(
    currentBps != null ? String(currentBps / BPS_PER_X) : "",
  );
  const [isPending, startTransition] = useTransition();

  // Reset the form whenever the dialog re-opens so a previous cancel
  // doesn't leave stale input.
  useEffect(() => {
    if (open) {
      setValue(currentBps != null ? String(currentBps / BPS_PER_X) : "");
    }
  }, [open, currentBps]);

  const x = value.trim() === "" ? null : Number(value);
  const bpsPreview =
    x !== null && Number.isFinite(x) && x >= 0
      ? Math.min(MAX_BPS, Math.max(0, Math.round(x * BPS_PER_X)))
      : null;

  const handleSave = () => {
    if (value.trim() === "") {
      toast.error("Enter a multiplier (0 to exempt the user)");
      return;
    }
    if (x === null || !Number.isFinite(x) || x < 0) {
      toast.error("Multiplier must be a non-negative number");
      return;
    }
    const bps = Math.min(MAX_BPS, Math.max(0, Math.round(x * BPS_PER_X)));

    startTransition(async () => {
      const result = await setUserWagerRequirementAction({ userId, bps });
      if (result.success) {
        toast.success("Wager requirement override saved");
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
          <DialogTitle>Custom Wager Requirement</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs text-muted-foreground">
                Multiplier (×)
              </Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {bpsPreview !== null ? `= ${bpsPreview} bps` : "= — bps"}
              </span>
            </div>
            <Input
              type="number"
              step="0.05"
              min="0"
              placeholder="e.g. 1 for 1×, 0 to exempt"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Overrides the deposit-based requirement for this user.{" "}
              <code className="font-mono">0</code> fully exempts them (bonus
              requirement included). Clearing the override (from the card)
              returns them to the site default.
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
