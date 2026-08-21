"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ListOrdered, Loader2, Search, Trash2, UserRoundCog } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  EosTestConfig,
  EosUserConfig,
  EosUserRule,
  EosUserSelection,
} from "@/lib/antifraud/eos-test-config-api";
import {
  getEosUserSelections,
  removeEosUserConfig,
  saveEosUserConfig,
  searchEosUsers,
  setEosUserEnabled,
  setEosUserForceLosses,
} from "./actions";
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

export function EosUserSequences({ environment, initial, forceAllLosses, focusUser }: {
  environment: EosTestConfig["environment"];
  initial: EosUserConfig[];
  forceAllLosses: boolean;
  focusUser?: UserResult | null;
}) {
  const router = useRouter();
  const focusedConfig = focusUser
    ? initial.find((config) => config.userId === focusUser.userId)
    : undefined;
  const [configs, setConfigs] = useState(initial);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [selected, setSelected] = useState<UserResult | null>(focusUser ?? null);
  const [rules, setRules] = useState<EosUserRule[]>(
    cloneRules(focusedConfig?.rules ?? defaultRules),
  );
  const [persistent, setPersistent] = useState(focusedConfig?.persistent ?? true);
  const [randomized, setRandomized] = useState(focusedConfig?.randomized ?? false);
  const [enabled, setEnabled] = useState(focusedConfig?.enabled ?? true);
  const [forceLosses, setForceLosses] = useState(focusedConfig?.forceLosses ?? false);
  const [history, setHistory] = useState<EosUserSelection[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [configFilter, setConfigFilter] = useState("");
  const [removeTarget, setRemoveTarget] = useState<EosUserConfig | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isHistoryPending, startHistoryTransition] = useTransition();
  const valid = isEosFlowValid(rules);
  const visibleConfigs = configs.filter((config) => {
    const needle = configFilter.trim().toLowerCase();
    return needle.length === 0
      || config.userId.toLowerCase().includes(needle)
      || config.username?.toLowerCase().includes(needle);
  });

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
    setForceLosses(existing?.forceLosses ?? false);
    setHistory(null);
    setHistoryError(null);
    setResults([]);
  }

  function loadHistory(userId = selected?.userId) {
    if (!userId) return;
    setHistoryError(null);
    startHistoryTransition(async () => {
      try {
        setHistory(await getEosUserSelections(userId));
      } catch (error) {
        setHistoryError(error instanceof Error ? error.message : "Battle history failed to load");
      }
    });
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
          forceLosses,
        });
        setConfigs((current) => [saved, ...current.filter((config) => config.userId !== saved.userId)]);
        setRules(cloneRules(saved.rules));
        setPersistent(saved.persistent);
        setRandomized(saved.randomized);
        setEnabled(saved.enabled);
        setForceLosses(saved.forceLosses);
        router.refresh();
        toast.success("Personal EOS flow saved and restarted");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Outcome control save failed");
      }
    });
  }

  function updateEnabled(next: boolean) {
    if (!selected) return;
    const existing = configs.some((config) => config.userId === selected.userId);
    if (!existing) {
      setEnabled(next);
      return;
    }
    startTransition(async () => {
      try {
        const saved = await setEosUserEnabled({
          userId: selected.userId,
          enabled: next,
        });
        setConfigs((current) => [saved, ...current.filter((config) => config.userId !== saved.userId)]);
        setEnabled(saved.enabled);
        router.refresh();
        toast.success(next
          ? "Personal flow resumed at its saved position"
          : "Personal flow paused at its current position");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Personal flow status update failed");
      }
    });
  }

  function updateForceLosses(next: boolean) {
    if (!selected) return;
    const existing = configs.some((config) => config.userId === selected.userId);
    if (!existing) {
      setForceLosses(next);
      return;
    }
    startTransition(async () => {
      try {
        const saved = await setEosUserForceLosses({
          userId: selected.userId,
          forceLosses: next,
        });
        setConfigs((current) => [saved, ...current.filter((config) => config.userId !== saved.userId)]);
        setForceLosses(saved.forceLosses);
        router.refresh();
        toast.success(next
          ? "Lose-only override enabled for this user"
          : "Lose-only override disabled for this user");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "User override update failed");
      }
    });
  }

  function remove(userId: string) {
    startTransition(async () => {
      try {
        await removeEosUserConfig(userId);
        setConfigs((current) => current.filter((config) => config.userId !== userId));
        if (selected?.userId === userId) setSelected(null);
        router.refresh();
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
              </div>
              <Tabs defaultValue="flow" onValueChange={(value) => {
                if (value === "history" && history === null && !isHistoryPending) {
                  loadHistory(selected.userId);
                }
              }}>
                <TabsList>
                  <TabsTrigger value="flow">Flow controls</TabsTrigger>
                  <TabsTrigger value="history">Battle history</TabsTrigger>
                </TabsList>
                <TabsContent value="flow" className="space-y-5 pt-2">
                  <div className="flex justify-end">
                    <label className="flex items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm font-medium">
                      Personal flow {enabled ? "enabled" : "paused"}
                      <Switch
                        aria-label="Enable personal EOS flow"
                        checked={enabled}
                        disabled={isPending}
                        onCheckedChange={updateEnabled}
                      />
                    </label>
                  </div>
                  <div className={`flex flex-col gap-4 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between ${
                    forceLosses
                      ? "border-destructive/60 bg-destructive/10"
                      : "border-amber-500/40 bg-amber-500/5"
                  }`}>
                    <div className="flex items-start gap-3">
                      <AlertTriangle className={`mt-0.5 size-5 shrink-0 ${forceLosses ? "text-destructive" : "text-amber-500"}`} />
                      <div>
                        <p className="text-sm font-semibold">Lose only for this user</p>
                        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                          Overrides this user&apos;s saved flow without resetting it. Selects a loss;
                          if no loss is possible, it selects the lowest creator outcome.
                        </p>
                      </div>
                    </div>
                    <label className="flex shrink-0 items-center gap-3 rounded-lg border bg-background px-3 py-2 text-sm font-semibold">
                      {forceLosses ? "Override active" : "Override off"}
                      <Switch
                        aria-label="Force losses for this EOS user"
                        checked={forceLosses}
                        disabled={isPending}
                        onCheckedChange={updateForceLosses}
                      />
                    </label>
                  </div>
                  <EosFlowBuilder id={`user-eos-flow-${selected.userId}`} rules={rules} persistent={persistent} randomized={randomized} onRulesChange={setRules} onPersistentChange={setPersistent} onRandomizedChange={setRandomized} />
                  <div className="flex justify-end border-t pt-4">
                    <Button type="button" disabled={isPending || !valid} onClick={save}>{isPending && <Loader2 className="size-4 animate-spin" />}Save &amp; restart personal flow</Button>
                  </div>
                </TabsContent>
                <TabsContent value="history" className="space-y-3 pt-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">Recent {environment} EOS decisions. Stored for 30 days.</p>
                    <Button type="button" size="sm" variant="outline" disabled={isHistoryPending} onClick={() => loadHistory(selected.userId)}>
                      {isHistoryPending && <Loader2 className="size-4 animate-spin" />}Refresh
                    </Button>
                  </div>
                  {historyError && (
                    <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{historyError}</div>
                  )}
                  {isHistoryPending && history === null && (
                    <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading battle history</div>
                  )}
                  {history?.length === 0 && (
                    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No auditable EOS battles yet. New battles will appear here.</div>
                  )}
                  {history?.map((entry) => {
                    const wins = entry.candidates.filter((candidate) => candidate.creatorWonBattle).length;
                    const status = entry.fallbackReason === "target_unavailable"
                      ? `Requested ${entry.requestedTarget} unavailable`
                      : entry.fallbackReason === "range_unavailable"
                        ? "Multiplier range unavailable"
                        : entry.requestedTarget ? "Matched request" : "Random selection";
                    return (
                      <details key={entry.battleId} className="group rounded-lg border bg-card p-3">
                        <summary className="cursor-pointer list-none space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs font-medium">{new Date(entry.selectedAt).toLocaleString()}</span>
                            <Badge variant={entry.fallbackReason ? "destructive" : "secondary"}>{status}</Badge>
                          </div>
                          <div className="grid gap-2 text-xs sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                            <div>
                              <span className="text-muted-foreground">Requested </span>
                              <span className="font-semibold uppercase">{entry.requestedTarget ?? "random"}</span>
                              {entry.requestedStrategy && <span className="text-muted-foreground"> · {entry.requestedStrategy.replaceAll("_", " ")}</span>}
                            </div>
                            <span className="hidden text-muted-foreground sm:inline">→</span>
                            <div className="sm:text-right">
                              <span className="text-muted-foreground">EOS selected </span>
                              <span className={`font-semibold uppercase ${entry.selected.creatorWonBattle ? "text-emerald-600" : "text-destructive"}`}>{entry.selected.creatorWonBattle ? "win" : "loss"}</span>
                              <span className="text-muted-foreground"> · {entry.selected.creatorMultiplier?.toFixed(2) ?? "—"}× · {entry.selected.creatorProfitLoss.toFixed(2)}</span>
                            </div>
                          </div>
                        </summary>
                        <div className="mt-3 space-y-2 border-t pt-3 text-xs text-muted-foreground">
                          <p>{wins} winning and {entry.candidates.length - wins} losing candidates were available in the five-block window.</p>
                          <p>Source: {entry.controlKind.replaceAll("_", " ")} · Selected block {entry.selected.blockNumber} · Random baseline {entry.randomBlockNumber}</p>
                          <p className="break-all font-mono text-[10px]">Battle {entry.battleId}</p>
                        </div>
                      </details>
                    );
                  })}
                </TabsContent>
              </Tabs>
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
          <div className="relative pt-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={configFilter}
              onChange={(event) => setConfigFilter(event.target.value)}
              className="h-8 pl-8 text-xs"
              placeholder="Filter configured users"
              aria-label="Filter configured EOS users"
            />
          </div>
        </CardHeader>
        <CardContent className="max-h-[70vh] space-y-3 overflow-y-auto">
          {configs.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No personal outcome controls configured.</p>}
          {configs.length > 0 && visibleConfigs.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No configured users match this filter.</p>}
          {visibleConfigs.map((config) => {
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
                    {config.forceLosses && <Badge variant="destructive">Lose only</Badge>}
                    <Badge variant={config.enabled ? "default" : "secondary"}>{status}</Badge>
                    <Button type="button" size="icon" variant="ghost" aria-label={`Remove ${config.username ?? config.userId}`} onClick={() => setRemoveTarget(config)}><Trash2 className="size-4" /></Button>
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
      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this personal EOS flow?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget?.username ?? removeTarget?.userId} will immediately fall back to
              the global flow. Existing battle decision history remains available until retention removes it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removeTarget) remove(removeTarget.userId);
                setRemoveTarget(null);
              }}
            >
              Remove personal flow
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
