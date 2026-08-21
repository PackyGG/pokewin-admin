"use client";

import { useState, useTransition } from "react";
import { ListOrdered, Loader2, Search, Trash2, UserRoundCog } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { EosTestConfig, EosUserConfig, EosUserRule } from "@/lib/antifraud/eos-test-config-api";
import { removeEosUserConfig, saveEosUserConfig, searchEosUsers } from "./actions";
import { EosFlowBuilder, eosRuleSummary, isEosFlowValid } from "./eos-flow-builder";

type UserResult = Awaited<ReturnType<typeof searchEosUsers>>[number];

const defaultRules: EosUserRule[] = [{
  target: "loss",
  strategy: "lowest_multiplier",
  count: 1,
  minMultiplier: null,
  maxMultiplier: null,
}];

function cloneRules(rules: EosUserRule[]): EosUserRule[] {
  return rules.map((rule) => ({ ...rule }));
}

export function EosUserSequences({ environment, initial, forceAllLosses }: {
  environment: EosTestConfig["environment"];
  initial: EosUserConfig[];
  forceAllLosses: boolean;
}) {
  const [configs, setConfigs] = useState(initial);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [selected, setSelected] = useState<UserResult | null>(null);
  const [rules, setRules] = useState<EosUserRule[]>(cloneRules(defaultRules));
  const [persistent, setPersistent] = useState(true);
  const [randomized, setRandomized] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [isPending, startTransition] = useTransition();
  const valid = isEosFlowValid(rules);

  function search() {
    startTransition(async () => {
      try {
        setResults(await searchEosUsers(query));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "User search failed");
      }
    });
  }

  function loadConfig(user: UserResult, existing?: EosUserConfig) {
    setSelected(user);
    setRules(cloneRules(existing?.rules ?? defaultRules));
    setPersistent(existing?.persistent ?? true);
    setRandomized(existing?.randomized ?? false);
    setEnabled(existing?.enabled ?? true);
    setResults([]);
  }

  function save() {
    if (!selected || !valid) {
      if (!valid) toast.error("Fix the invalid multiplier range before saving.");
      return;
    }
    startTransition(async () => {
      try {
        const saved = await saveEosUserConfig({
          userId: selected.userId,
          username: selected.username ?? selected.displayUsername,
          rules,
          persistent,
          randomized,
          enabled,
        });
        setConfigs((current) => [saved, ...current.filter((config) => config.userId !== saved.userId)]);
        setRules(cloneRules(saved.rules));
        toast.success("Personal EOS flow saved and restarted");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Outcome control save failed");
      }
    });
  }

  function remove(userId: string) {
    startTransition(async () => {
      try {
        await removeEosUserConfig(userId);
        setConfigs((current) => current.filter((config) => config.userId !== userId));
        if (selected?.userId === userId) setSelected(null);
        toast.success("Personal EOS outcome control removed");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Outcome control removal failed");
      }
    });
  }

  return (
    <div className="grid items-start gap-5 2xl:grid-cols-[minmax(0,1fr)_400px]">
      <Card className="min-w-0 overflow-hidden">
        <CardHeader className="border-b bg-muted/20">
          <CardTitle className="flex items-center gap-2 text-base"><UserRoundCog className="size-4 text-primary" />Per-user outcome control</CardTitle>
          <p className="max-w-3xl text-sm text-muted-foreground">Build a personal {environment} flow. While enabled, it overrides the global flow for this user only.</p>
        </CardHeader>
        <CardContent className="space-y-5 pt-6">
          {forceAllLosses && (
            <div role="status" className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs font-medium text-destructive">
              The global all-battles loss override is active. Personal flows remain saved but are temporarily bypassed.
            </div>
          )}
          <div className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input aria-label="Search EOS users" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && query.trim().length >= 2) search(); }} placeholder={`Search ${environment} user ID or username`} />
              <Button type="button" variant="outline" disabled={isPending || query.trim().length < 2} onClick={search}>{isPending ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}Search</Button>
            </div>
            {results.length > 0 && (
              <div className="divide-y rounded-lg border" role="listbox" aria-label="EOS user search results">
                {results.map((user) => (
                  <button key={user.userId} type="button" role="option" aria-selected={selected?.userId === user.userId} className="flex w-full flex-col gap-1 p-3 text-left hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between" onClick={() => loadConfig(user, configs.find((config) => config.userId === user.userId))}>
                    <span className="text-sm font-medium">{user.displayUsername ?? user.username ?? "Unnamed user"}</span>
                    <span className="break-all font-mono text-[11px] text-muted-foreground">{user.userId}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {selected ? (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/20 p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{selected.displayUsername ?? selected.username ?? "Unnamed user"}</p>
                  <p className="break-all font-mono text-[11px] text-muted-foreground">{selected.userId}</p>
                </div>
                <label className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm font-medium">
                  Personal flow {enabled ? "enabled" : "paused"}
                  <Switch aria-label="Enable personal EOS flow" checked={enabled} onCheckedChange={setEnabled} />
                </label>
              </div>
              <EosFlowBuilder id={`user-eos-flow-${selected.userId}`} rules={rules} persistent={persistent} randomized={randomized} onRulesChange={setRules} onPersistentChange={setPersistent} onRandomizedChange={setRandomized} />
              <div className="flex justify-end border-t pt-4">
                <Button type="button" disabled={isPending || !valid} onClick={save}>{isPending && <Loader2 className="size-4 animate-spin" />}Save personal flow</Button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Search for a {environment} user to create or edit a personal flow.</div>
          )}
        </CardContent>
      </Card>

      <Card className="2xl:sticky 2xl:top-5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base"><ListOrdered className="size-4 text-primary" />Configured users</CardTitle>
          <p className="text-sm text-muted-foreground">{configs.length} personal {configs.length === 1 ? "flow" : "flows"}</p>
        </CardHeader>
        <CardContent className="max-h-[70vh] space-y-3 overflow-y-auto">
          {configs.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No personal outcome controls configured.</p>}
          {configs.map((config) => {
            const activeRule = config.rules[config.currentRuleIndex];
            const totalBattles = config.rules.reduce((sum, rule) => sum + rule.count, 0);
            const completedBattles = config.rules.slice(0, config.currentRuleIndex).reduce((sum, rule) => sum + rule.count, 0) + (activeRule ? activeRule.count - config.remainingInRule : totalBattles);
            const progress = totalBattles > 0 ? Math.min(100, Math.round((completedBattles / totalBattles) * 100)) : 0;
            const status = config.enabled ? (config.persistent ? "Running" : "Active") : (activeRule ? "Paused" : "Complete");
            return (
              <div key={config.userId} className={`space-y-3 rounded-lg border p-3 ${selected?.userId === config.userId ? "border-primary bg-primary/5" : ""}`}>
                <div className="flex items-start justify-between gap-3">
                  <button type="button" className="min-w-0 text-left" onClick={() => loadConfig({ userId: config.userId, username: config.username, displayUsername: null }, config)}>
                    <p className="truncate text-sm font-semibold">{config.username ?? "Unnamed user"}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{config.userId}</p>
                  </button>
                  <div className="flex items-center gap-1">
                    <Badge variant={config.enabled ? "default" : "secondary"}>{status}</Badge>
                    <Button type="button" size="icon" variant="ghost" aria-label={`Remove ${config.username ?? config.userId}`} onClick={() => remove(config.userId)}><Trash2 className="size-4" /></Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {config.randomized ? "Weighted random" : config.persistent ? "Repeating sequence" : activeRule ? `Step ${config.currentRuleIndex + 1} of ${config.rules.length}` : "Sequence finished"}
                  {activeRule && ` · ${eosRuleSummary(activeRule)}`}
                </p>
                {!config.persistent && activeRule && (
                  <div className="space-y-1" aria-label={`${progress}% complete`}>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div>
                    <p className="text-right text-[10px] text-muted-foreground">{config.remainingInRule} in current step</p>
                  </div>
                )}
                <div className="flex flex-wrap gap-1">
                  {config.rules.map((rule, index) => <Badge key={`${config.userId}-${index}`} variant="outline" className="max-w-full truncate text-[10px]">{rule.count}× {eosRuleSummary(rule)}</Badge>)}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
