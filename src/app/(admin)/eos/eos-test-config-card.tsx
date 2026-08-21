"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus, Repeat2, ShieldCheck, Shuffle, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { EosTestConfig, EosUserRule } from "@/lib/antifraud/eos-test-config-api";
import { saveGlobalEosFlow } from "./actions";

const targets: Record<EosUserRule["target"], string> = { loss: "Creator loses", win: "Creator wins", any: "Any outcome" };
const strategies: Record<EosUserRule["strategy"], string> = { random: "Random matching result", lowest_profit: "Lowest money result", highest_profit: "Highest money result" };

export function EosTestConfigCard({ initial }: { initial: EosTestConfig }) {
  const [rules, setRules] = useState(initial.rules);
  const [enabled, setEnabled] = useState(initial.enabled || initial.userOnlyLoses);
  const [persistent, setPersistent] = useState(initial.persistent);
  const [randomized, setRandomized] = useState(initial.randomized);
  const [isPending, startTransition] = useTransition();
  const updateRule = (index: number, patch: Partial<EosUserRule>) => setRules((current) => current.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule));
  const save = () => startTransition(async () => {
    try {
      const saved = await saveGlobalEosFlow({ rules, enabled, persistent, randomized });
      setRules(saved.rules); setEnabled(saved.enabled); setPersistent(saved.persistent); setRandomized(saved.randomized);
      toast.success("Global EOS flow saved and reset to step 1");
    } catch (error) { toast.error(error instanceof Error ? error.message : "EOS flow update failed"); }
  });

  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Shuffle className="size-4 text-primary" />Global outcome flow</CardTitle><p className="text-sm text-muted-foreground">Applies to {initial.environment} battles without an active per-user override.</p></CardHeader>
    <CardContent className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-3">
        <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm font-medium">Flow enabled<Switch checked={enabled} onCheckedChange={setEnabled} /></label>
        <button type="button" onClick={() => { setPersistent((value) => !value); if (persistent) setRandomized(false); }} className={`rounded-lg border p-3 text-left ${persistent ? "border-primary bg-primary/5" : ""}`}><span className="flex items-center gap-2 text-sm font-semibold"><Repeat2 className="size-4" />{persistent ? "Repeat continuously" : "Run once"}</span></button>
        <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm font-medium"><span><span className="block">Weighted random order</span><span className="text-xs font-normal text-muted-foreground">Counts become weights</span></span><Switch checked={randomized} disabled={!persistent} onCheckedChange={setRandomized} /></label>
      </div>
      <div className="space-y-3">
        {rules.map((rule, index) => <div key={index} className="grid gap-3 rounded-lg bg-muted/35 p-4 md:grid-cols-[1fr_1fr_120px_auto]">
          <label className="space-y-1 text-xs font-medium">Outcome<select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={rule.target} onChange={(event) => updateRule(index, { target: event.target.value as EosUserRule["target"] })}>{Object.entries(targets).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="space-y-1 text-xs font-medium">Selection<select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={rule.strategy} onChange={(event) => updateRule(index, { strategy: event.target.value as EosUserRule["strategy"] })}>{Object.entries(strategies).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="space-y-1 text-xs font-medium">{randomized ? "Weight" : "Battles"}<Input type="number" min={1} max={100} value={rule.count} onChange={(event) => updateRule(index, { count: Math.min(100, Math.max(1, Number(event.target.value) || 1)) })} /></label>
          <Button type="button" size="icon" variant="ghost" className="self-end" disabled={rules.length === 1} aria-label={`Remove global step ${index + 1}`} onClick={() => setRules((current) => current.filter((_, ruleIndex) => ruleIndex !== index))}><Trash2 className="size-4" /></Button>
        </div>)}
        <Button type="button" variant="outline" disabled={rules.length >= 20} onClick={() => setRules((current) => [...current, { target: "any", strategy: "random", count: 1 }])}><Plus className="size-4" />Add global step</Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground"><span className="flex items-center gap-2"><ShieldCheck className="size-4 text-emerald-500" />Per-user flows take priority. Saving restarts this global flow.</span><Button type="button" disabled={isPending} onClick={save}>{isPending && <Loader2 className="size-4 animate-spin" />}Save global flow</Button></div>
    </CardContent>
  </Card>;
}
