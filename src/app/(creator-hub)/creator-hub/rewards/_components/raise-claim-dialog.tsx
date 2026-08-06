"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import type { CreatorRewardProgramWithStats } from "@/lib/creator-vip/types";

import {
  previewCreatorRewardEntitlement,
  raiseCreatorRewardClaimForUser,
} from "../actions";
import { Flag } from "./claim-flags";

/**
 * Look a player up on this program, see what they'd get, and optionally raise
 * the claim for them — the same server path the Discord bot will use, so the
 * review queue can be exercised before any bot exists.
 */
export function RaiseClaimDialog({
  program,
  open,
  onOpenChange,
}: {
  program: CreatorRewardProgramWithStats;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<{
    userId: string;
    username: string | null;
    leg: "wager" | "ftd_lossback";
    ftdLostUsd: number | null;
    ftdDepositUsd: number | null;
    isVip: boolean;
    appliedRewardUsd: number;
    qualifyingWagerUsd: number;
    lifetimeWagerUsd: number;
    forfeitedWagerUsd: number;
    runStartedAt: string;
    availableWagerUsd: number;
    priorConsumedUsd: number;
    units: number;
    amountUsd: number;
    wagerToNextUnitUsd: number;
    blockedReason: string | null;
  } | null>(null);
  const [checking, startCheck] = useTransition();
  const [raising, startRaise] = useTransition();

  function check() {
    startCheck(async () => {
      const res = await previewCreatorRewardEntitlement({
        programId: program.id,
        query: query.trim(),
      });
      if (!res.success) {
        setPreview(null);
        toast.error(res.error);
        return;
      }
      setPreview(res.data);
    });
  }

  function raise() {
    if (!preview) return;
    startRaise(async () => {
      const res = await raiseCreatorRewardClaimForUser({
        programId: program.id,
        // The preview already resolved WHICH leg has something payable, so
        // the claim is filed against that same leg — no second guess.
        leg: preview.leg,
        userId: preview.userId,
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(
        `Claim raised for ${formatCurrency(res.data.amountUsd)} — it's in Requests`,
      );
      setPreview(null);
      setQuery("");
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setPreview(null);
          setQuery("");
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Check a player</DialogTitle>
          <DialogDescription>
            See what they&apos;ve earned on {program.name}, and raise the claim
            for them if you want.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  check();
                }
              }}
              placeholder="Username, email or user ID"
              aria-label="Player to check"
              disabled={checking || raising}
            />
            <Button
              variant="outline"
              onClick={check}
              disabled={checking || raising || query.trim() === ""}
            >
              {checking ? "…" : "Check"}
            </Button>
          </div>

          {preview && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">
                  {preview.username ?? preview.userId}
                </span>
                {/* Same flag the claim rows use — one VIP purple, not two. */}
                {preview.isVip && <Flag tone="vip">VIP</Flag>}
                {preview.leg === "wager" && program.thresholdUsd != null && (
                  <span className="text-xs text-muted-foreground">
                    {formatCurrency(preview.appliedRewardUsd)} per{" "}
                    {formatCurrency(program.thresholdUsd)}
                  </span>
                )}
              </div>
              {preview.leg === "ftd_lossback" ? (
                <>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>First deposit</span>
                    <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(preview.ftdDepositUsd ?? 0)}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Lost so far</span>
                    <span className="tabular-nums">
                      {formatCurrency(preview.ftdLostUsd ?? 0)}
                    </span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>
                    Wagered since {formatDateTime(preview.runStartedAt)}
                  </span>
                  <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
                    {formatCurrency(preview.qualifyingWagerUsd)}
                  </span>
                </div>
              )}
              {preview.forfeitedWagerUsd > 0 && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Lost to a code switch</span>
                  <span className="tabular-nums">
                    −{formatCurrency(preview.forfeitedWagerUsd)}
                  </span>
                </div>
              )}
              {preview.priorConsumedUsd > 0 && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Already claimed against</span>
                  <span className="tabular-nums">
                    −{formatCurrency(preview.priorConsumedUsd)}
                  </span>
                </div>
              )}
              <div className="flex justify-between border-t pt-2">
                <span>Claimable now</span>
                <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(preview.amountUsd)}
                </span>
              </div>
              {preview.blockedReason ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {preview.blockedReason}
                </p>
              ) : (
                preview.units === 0 &&
                preview.leg === "wager" &&
                program.rewardUsd != null && (
                  <p className="text-xs text-muted-foreground">
                    {formatCurrency(preview.wagerToNextUnitUsd)} more wager
                    needed for the next {formatCurrency(program.rewardUsd)}.
                  </p>
                )
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={raising}
          >
            Close
          </Button>
          <Button
            onClick={raise}
            disabled={raising || !preview || preview.units < 1}
          >
            {raising ? "Raising…" : "Raise claim"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
