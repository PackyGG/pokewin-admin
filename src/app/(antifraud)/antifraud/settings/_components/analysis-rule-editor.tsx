"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { clientActionError } from "@/lib/errors/client-action-error";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { AntifraudAnalysisRule } from "@/lib/antifraud/network-api";
import { setAntifraudAnalysisRule } from "../actions";

export function AnalysisRuleEditor({
  rule,
}: {
  rule: AntifraudAnalysisRule;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = React.useState(rule.enabled);
  const [points, setPoints] = React.useState(String(rule.points));
  const [threshold, setThreshold] = React.useState(String(rule.threshold));
  const [pending, startTransition] = React.useTransition();
  return (
    <form
      className="space-y-2 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        const nextPoints = Number(points);
        const nextThreshold = Number(threshold);
        if (
          !Number.isInteger(nextPoints) ||
          nextPoints < -500 ||
          nextPoints > 500
        ) {
          toast.error("Points must be a whole number from -500 to 500");
          return;
        }
        if (
          !Number.isFinite(nextThreshold) ||
          nextThreshold < 0 ||
          nextThreshold > 1_000_000
        ) {
          toast.error("Threshold must be between 0 and 1,000,000");
          return;
        }
        startTransition(async () => {
          try {
            const result = await setAntifraudAnalysisRule({
              key: rule.key,
              enabled,
              points: nextPoints,
              threshold: nextThreshold,
            });
            if (!result.success) {
              toast.error(result.error);
              return;
            }
            toast.success(`${rule.name} saved`);
            router.refresh();
          } catch (error) {
            toast.error(
              clientActionError(error, "Rule could not be saved"),
            );
          }
        });
      }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{rule.name}</p>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {rule.category}
          </span>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {rule.description}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Enabled
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={pending}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Trigger
          <Input
            type="number"
            min={0}
            max={1_000_000}
            step="0.1"
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            className="h-8 w-24 font-mono text-xs"
            disabled={pending}
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Points
          <Input
            type="number"
            min={-500}
            max={500}
            step={1}
            value={points}
            onChange={(event) => setPoints(event.target.value)}
            className="h-8 w-20 font-mono text-xs"
            disabled={pending}
          />
        </label>
        <Button
          type="submit"
          size="icon-sm"
          variant="outline"
          disabled={pending}
          className="ml-auto"
        >
          <Save className="size-3.5" />
          <span className="sr-only">Save {rule.name}</span>
        </Button>
      </div>
    </form>
  );
}
