"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Globe2, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { EosTestConfig } from "@/lib/antifraud/eos-test-config-api";
import { saveGlobalEosFlow, setGlobalForceAllLosses } from "./actions";
import { EosFlowBuilder, isEosFlowValid } from "./eos-flow-builder";

export function EosTestConfigCard({ initial }: { initial: EosTestConfig }) {
  const router = useRouter();
  const [rules, setRules] = useState(initial.rules);
  const [enabled, setEnabled] = useState(initial.enabled || initial.userOnlyLoses);
  const [persistent, setPersistent] = useState(initial.persistent);
  const [randomized, setRandomized] = useState(initial.randomized);
  const [forceAllLosses, setForceAllLosses] = useState(initial.forceAllLosses);
  const [isPending, startTransition] = useTransition();
  const valid = isEosFlowValid(rules);

  function save() {
    if (!valid) {
      toast.error("Fix the invalid multiplier range before saving.");
      return;
    }
    startTransition(async () => {
      try {
        const saved = await saveGlobalEosFlow({
          rules, enabled, persistent, randomized, forceAllLosses,
        });
        setRules(saved.rules);
        setEnabled(saved.enabled);
        setPersistent(saved.persistent);
        setRandomized(saved.randomized);
        setForceAllLosses(saved.forceAllLosses);
        router.refresh();
        toast.success("Global EOS flow saved and restarted");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "EOS flow update failed");
      }
    });
  }

  function updateForceAllLosses(next: boolean) {
    startTransition(async () => {
      try {
        const saved = await setGlobalForceAllLosses(next);
        setForceAllLosses(saved.forceAllLosses);
        router.refresh();
        toast.success(next
          ? "All-battles loss override enabled"
          : "All-battles loss override disabled");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Global override update failed");
      }
    });
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b bg-muted/20">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe2 className="size-4 text-primary" />Global outcome flow
            </CardTitle>
            <p className="max-w-3xl text-sm text-muted-foreground">
              The default flow for {initial.environment} battles. Personal flows take priority unless the all-loss override is active.
            </p>
          </div>
          <label className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm font-medium">
            Global flow {enabled ? "enabled" : "paused"}
            <Switch aria-label="Enable global EOS flow" checked={enabled} onCheckedChange={setEnabled} />
          </label>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 pt-6">
        <div className={`flex flex-col gap-4 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between ${
          forceAllLosses
            ? "border-destructive/60 bg-destructive/10"
            : "border-amber-500/40 bg-amber-500/5"
        }`}>
          <div className="flex items-start gap-3">
            <AlertTriangle className={`mt-0.5 size-5 shrink-0 ${forceAllLosses ? "text-destructive" : "text-amber-500"}`} />
            <div>
              <p className="text-sm font-semibold">Force losses for every battle</p>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                Overrides every personal and global flow. Selects a creator loss;
                if the five-block window has no loss, it selects the lowest creator outcome.
              </p>
            </div>
          </div>
          <label className="flex shrink-0 items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm font-semibold">
            {forceAllLosses ? "Override active" : "Override off"}
            <Switch
              aria-label="Force losses for every EOS battle"
              checked={forceAllLosses}
              disabled={isPending}
              onCheckedChange={updateForceAllLosses}
            />
          </label>
        </div>
        <EosFlowBuilder
          id="global-eos-flow"
          rules={rules}
          persistent={persistent}
          randomized={randomized}
          onRulesChange={setRules}
          onPersistentChange={setPersistent}
          onRandomizedChange={setRandomized}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 p-3">
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-4 text-emerald-500" />Saving restarts this flow from its first rule.
          </span>
          <Button type="button" disabled={isPending || !valid} onClick={save}>
            {isPending && <Loader2 className="size-4 animate-spin" />}
            Save global flow
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
