"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { updateAffiliateCutExpiration } from "../actions";

export function AffiliateExpirationCard({
  initialDays,
}: {
  // null = no expiration configured, otherwise a positive integer number of days
  initialDays: number | null;
}) {
  const [input, setInput] = useState<string>(
    initialDays !== null && initialDays > 0 ? String(initialDays) : "",
  );
  const [isPending, startTransition] = useTransition();

  const trimmed = input.trim();
  const parsed = trimmed === "" ? null : Number(trimmed);
  const parsedInvalid =
    trimmed !== "" && (!Number.isFinite(parsed) || parsed! < 0);
  const savedStr = initialDays !== null && initialDays > 0 ? String(initialDays) : "";
  const hasChanges = trimmed !== savedStr;

  function handleSave() {
    if (parsedInvalid) {
      toast.error("Enter a non-negative number or leave empty");
      return;
    }
    startTransition(async () => {
      try {
        const result = await updateAffiliateCutExpiration(parsed);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Affiliate cut expiration updated");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update");
      }
    });
  }

  // Display string for the current stored value. The card was missing
  // a clear "this is what's set right now" read-out — the input
  // mirrors the saved value but admins editing the field can't tell
  // at a glance whether the live config is the same as what they
  // typed. This pulls the saved number out of the input concern and
  // displays it once at the top.
  const currentDisplay =
    initialDays !== null && initialDays > 0
      ? `${initialDays} day${initialDays === 1 ? "" : "s"}`
      : "Unlimited (lifetime)";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Affiliate Cut Expiration
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Currently-saved value pinned at the top so admins can see
            the live config at a glance, separate from whatever they're
            typing into the input below. */}
        <div className="flex items-baseline gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Currently
          </span>
          <span className="text-sm font-semibold tabular-nums">
            {currentDisplay}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          How many days after a user signs up via an affiliate code the
          affiliate keeps earning commission on that user&apos;s activity.
          Leave empty (or 0) for no expiration — affiliates earn for the
          user&apos;s lifetime.
        </p>
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Expiration (days)</Label>
            <Input
              type="number"
              min="0"
              max="3650"
              placeholder="Unlimited"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="h-8 w-40"
              disabled={isPending}
            />
          </div>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isPending || !hasChanges || parsedInvalid}
          >
            {isPending ? "Saving..." : "Save"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {parsed && parsed > 0
              ? `~ ${(parsed / 30).toFixed(1)} months`
              : "No expiration"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Stored in{" "}
          <code className="rounded bg-muted px-1 text-[11px]">
            site_config.affiliate_cut_expiration_days
          </code>
          . The game backend reads this key when crediting affiliate
          commission.
        </p>
      </CardContent>
    </Card>
  );
}
