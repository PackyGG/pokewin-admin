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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Affiliate Cut Expiration
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
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
