"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Globe2, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import type { EosTestConfig } from "@/lib/antifraud/eos-test-config-api";
import {
  saveGlobalEosFlow,
  setGlobalEosEnabled,
  setGlobalForceAllLosses,
} from "./actions";
import { EosFlowBuilder, isEosFlowValid } from "./eos-flow-builder";

export function EosTestConfigCard({ initial }: { initial: EosTestConfig }) {
  const router = useRouter();
  const [rules, setRules] = useState(initial.rules);
  const [enabled, setEnabled] = useState(initial.enabled || initial.userOnlyLoses);
  const [persistent, setPersistent] = useState(initial.persistent);
  const [randomized, setRandomized] = useState(initial.randomized);
  const [forceAllLosses, setForceAllLosses] = useState(initial.forceAllLosses);
  const [savedConfig, setSavedConfig] = useState(initial);
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const valid = isEosFlowValid(rules);
  const dirty = enabled !== savedConfig.enabled
    || persistent !== savedConfig.persistent
    || randomized !== savedConfig.randomized
    || JSON.stringify(rules) !== JSON.stringify(savedConfig.rules);

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
        setSavedConfig(saved);
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
        setSavedConfig(saved);
        router.refresh();
        toast.success(next
          ? "All-battles loss override enabled"
          : "All-battles loss override disabled");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Global override update failed");
      }
    });
  }

  function updateEnabled(next: boolean) {
    startTransition(async () => {
      try {
        const saved = await setGlobalEosEnabled(next);
        setEnabled(saved.enabled);
        setSavedConfig(saved);
        router.refresh();
        toast.success(next
          ? "Global flow resumed at its saved position"
          : "Global flow paused at its current position");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Global flow status update failed");
      }
    });
  }

  return (
    <Card className="w-full overflow-visible">
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-base">
              <Globe2 className="size-4 text-primary" />Global outcome flow
              {dirty && <Badge variant="secondary">Unsaved changes</Badge>}
            </CardTitle>
            <p className="max-w-3xl text-sm text-muted-foreground">
              The default flow for {initial.environment} battles. Personal flows take priority unless the all-loss override is active.
            </p>
            <p className="text-xs text-muted-foreground">
              {savedConfig.updatedAt
                ? `Last updated ${new Date(savedConfig.updatedAt).toLocaleString()}${savedConfig.updatedBy ? ` by ${savedConfig.updatedBy}` : ""}`
                : "No global flow has been saved yet"}
            </p>
          </div>
          <label className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2 text-sm font-medium">
            Global flow {enabled ? "enabled" : "paused"}
            <Switch
              aria-label="Enable global EOS flow"
              checked={enabled}
              disabled={isPending}
              onCheckedChange={updateEnabled}
            />
          </label>
        </div>
      </CardHeader>
      <CardContent className="space-y-6 pt-1">
        <div className={`flex flex-col gap-4 rounded-xl p-4 sm:flex-row sm:items-center sm:justify-between ${
          forceAllLosses
            ? "bg-destructive/10 ring-1 ring-destructive/35"
            : "bg-muted/35 ring-1 ring-foreground/10"
        }`}>
          <div className="flex items-start gap-3">
            <AlertTriangle
              aria-hidden="true"
              className={`mt-0.5 size-5 shrink-0 ${
                forceAllLosses ? "text-destructive" : "text-muted-foreground"
              }`}
            />
            <div>
              <p className="text-sm font-semibold">Emergency force-loss override</p>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                Overrides every personal and global flow. If no creator loss exists,
                EOS selects the candidate with the lowest creator profit.
              </p>
            </div>
          </div>
          <label className="flex shrink-0 items-center justify-between gap-3 rounded-lg bg-background/80 px-3 py-2 text-sm font-semibold sm:justify-start">
            {forceAllLosses ? "Active" : "Off"}
            <Switch
              aria-label="Force losses for every EOS battle"
              checked={forceAllLosses}
              disabled={isPending}
              onCheckedChange={(next) => {
                if (next) setForceConfirmOpen(true);
                else updateForceAllLosses(false);
              }}
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
        <div className="sticky bottom-0 z-20 -mx-4 flex flex-col gap-3 border-t bg-background/90 px-4 py-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-4 text-emerald-500" />Ordered targets retry when unavailable. Saving restarts at rule one.
          </span>
          <Button type="button" className="w-full sm:w-auto" disabled={isPending || !valid} onClick={save}>
            {isPending && <Loader2 className="size-4 animate-spin" />}
            Save &amp; restart global flow
          </Button>
        </div>
      </CardContent>
      <AlertDialog open={forceConfirmOpen} onOpenChange={setForceConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Force losses for every creator?</AlertDialogTitle>
            <AlertDialogDescription>
              This immediately overrides every global and personal flow in {initial.environment}.
              When no loss exists, EOS selects the lowest creator outcome.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setForceConfirmOpen(false);
                updateForceAllLosses(true);
              }}
            >
              Enable force losses
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
