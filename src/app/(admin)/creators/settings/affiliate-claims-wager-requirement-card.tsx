"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ux";
import { updateAffiliateClaimsWagerRequirementAction } from "./affiliate-claims-wager-requirement-actions";

const BPS_PER_X = 10000;
const MAX_BPS = 1_000_000;

function bpsToX(bps: number): string {
  return String(bps / BPS_PER_X);
}

export function AffiliateClaimsWagerRequirementCard({
  initialBps,
}: {
  /** null = backend unreachable (degraded state). */
  initialBps: number | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(
    initialBps != null ? bpsToX(initialBps) : "",
  );

  if (initialBps === null) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Affiliate-Claims Wager Requirement
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The wager-requirement endpoints aren&apos;t reachable on the
                current backend deploy. This setting becomes editable once the
                feature ships.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const raw = value.trim();
  const x = raw === "" ? null : Number(raw);
  const bpsHint =
    x !== null && Number.isFinite(x) && x >= 0
      ? `= ${Math.min(MAX_BPS, Math.max(0, Math.round(x * BPS_PER_X)))} bps`
      : "= — bps";
  const savedStr = bpsToX(initialBps);
  const hasChanges = raw !== savedStr;

  function handleSave() {
    if (raw === "") {
      toast.error("Enter a multiplier (×)");
      return;
    }
    if (!Number.isFinite(x!) || x! < 0) {
      toast.error("Multiplier must be a non-negative number");
      return;
    }
    const bps = Math.min(MAX_BPS, Math.max(0, Math.round(x! * BPS_PER_X)));
    if (bps === initialBps) {
      toast.info("No changes to save");
      return;
    }

    startTransition(async () => {
      const result = await updateAffiliateClaimsWagerRequirementAction(bps);
      if (result.success) {
        toast.success("Affiliate-claims wager requirement updated");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Affiliate-Claims Wager Requirement
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Multiplier on lifetime affiliate commission claims a user must wager
          before any withdrawal. Default 1×. <code>0×</code> disables it.
          Per-user overrides live on the user detail page.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs">Requirement (×)</Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {bpsHint}
              </span>
            </div>
            <Input
              type="number"
              step="0.05"
              min="0"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-8 w-40"
              disabled={isPending}
            />
          </div>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isPending || !hasChanges}
          >
            {isPending && <Spinner size={15} className="text-current" />}
            {isPending ? "Saving..." : "Save"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Stored via the backend wager-requirement defaults API (
          <code className="rounded bg-muted px-1 text-[11px]">
            affiliate_wager_requirement_bps
          </code>
          ). Previously edited on /security.
        </p>
      </CardContent>
    </Card>
  );
}
