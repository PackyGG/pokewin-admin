"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronDown, ListOrdered, Loader2, Search, Trash2, UserRoundCog } from "lucide-react";
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
} from "@/lib/antifraud/eos-test-config-api";
import {
  getEosUserBattleHistory,
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
  strategy: "lowest_profit",
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
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getEosUserBattleHistory>> | null>(null);
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
        setHistory(await getEosUserBattleHistory(userId));
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
    <div className="mx-auto grid max-w-[1400px] items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="min-w-0 overflow-visible">
        <CardHeader className="border-b">
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
              <div className="divide-y rounded-lg border" aria-label="EOS user search results">
                {results.map((user) => (
                  <button key={user.userId} type="button" aria-pressed={selected?.userId === user.userId} className="flex w-full flex-col gap-1 p-3 text-left hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between" onClick={() => loadConfig(user, configs.find((config) => config.userId === user.userId))}>
                    <span className="text-sm font-medium">{user.displayUsername ?? user.username ?? "Unnamed user"}</span>
                    <span className="break-all font-mono text-[11px] text-muted-foreground">{user.userId}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {selected ? (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
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
                <TabsList variant="line">
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
                  <div className={`flex flex-col gap-4 rounded-xl p-4 ring-1 sm:flex-row sm:items-center sm:justify-between ${
                    forceLosses
                      ? "bg-destructive/10 ring-destructive/40"
                      : "bg-muted/35 ring-foreground/10"
                  }`}>
                    <div className="flex items-start gap-3">
                      <AlertTriangle className={`mt-0.5 size-5 shrink-0 ${forceLosses ? "text-destructive" : "text-muted-foreground"}`} aria-hidden="true" />
                      <div>
                        <p className="text-sm font-semibold">Lose only for this user</p>
                        <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                          Overrides this user&apos;s saved flow without resetting it. Selects a loss;
                          if no loss is possible, it selects the lowest creator outcome.
                        </p>
                      </div>
                    </div>
                    <label className="flex shrink-0 items-center justify-between gap-3 rounded-lg bg-background/80 px-3 py-2 text-sm font-semibold sm:justify-start">
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
                  <div className="sticky bottom-0 z-20 -mx-4 flex justify-end border-t bg-background/90 px-4 py-3 backdrop-blur">
                    <Button type="button" className="w-full sm:w-auto" disabled={isPending || !valid} onClick={save}>{isPending && <Loader2 className="size-4 animate-spin" />}Save &amp; restart personal flow</Button>
                  </div>
                </TabsContent>
                <TabsContent value="history" className="space-y-3 pt-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                      Creator battles from the {environment} database, matched to EOS control
                      records retained for 30 days. Older records show control use even when
                      five-candidate audit details were not recorded yet.
                    </p>
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
                  {history && (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {[
                        ["Creator battles", history.summary.creatorBattles],
                        ["Config active", history.summary.controlledBattles],
                        ["Detailed audits", history.summary.auditedBattles],
                      ].map(([label, value]) => (
                        <div key={label} className="rounded-lg border bg-muted/20 p-3">
                          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
                          <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {history && (history.summary.legacyBattles > 0 || history.summary.missingAudit > 0) && (
                    <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      Data quality: {history.summary.legacyBattles} legacy without candidate details
                      {" · "}{history.summary.missingAudit} missing monitor records
                    </p>
                  )}
                  {history && history.summary.missingAudit > 0 && (
                    <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                      {history.summary.missingAudit} creator {history.summary.missingAudit === 1 ? "battle has" : "battles have"} an EOS block but no monitor decision. This means the backend bypassed or failed the controlled EOS route for those battles.
                    </div>
                  )}
                  {history?.entries.length === 0 && (
                    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                      No EOS-backed battles created by this player in the last 30 days.
                    </div>
                  )}
                  {history?.entries.map((entry) => {
                    const decision = entry.decision;
                    const selectionSummary = entry.selectionSummary;
                    const observed = entry.observed;
                    const wins = decision?.candidates.filter((candidate) => candidate.creatorWonBattle).length ?? 0;
                    const status = decision?.fallbackReason === "target_unavailable"
                      ? `Requested ${decision.requestedTarget} unavailable`
                      : decision?.fallbackReason === "range_unavailable"
                        ? "Multiplier range unavailable"
                        : decision?.requestedTarget ? "Matched request"
                          : decision ? "Random selection"
                            : selectionSummary?.configured ? "Control active · legacy details"
                              : selectionSummary ? "No config · legacy random"
                                : entry.beforeTracking ? "Before audit tracking" : "Decision missing";
                    const creatorWon = decision?.selected.creatorWonBattle
                      ?? observed?.creatorWonBattle
                      ?? null;
                    const profit = decision?.selected.creatorProfitLoss
                      ?? observed?.creatorProfitLoss
                      ?? null;
                    const multiplier = decision?.selected.creatorMultiplier
                      ?? observed?.creatorMultiplier
                      ?? null;
                    const currency = decision?.currency ?? observed?.currency ?? "";
                    return (
                      <details key={entry.battleId} className="group rounded-lg border bg-card p-3">
                        <summary className="-m-1 cursor-pointer list-none space-y-2 rounded-md p-1 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="flex items-center gap-2 text-xs font-medium">
                              <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
                              {new Date(entry.occurredAt).toLocaleString()}
                            </span>
                            <Badge variant={(!decision && !selectionSummary && !entry.beforeTracking)
                              || decision?.fallbackReason ? "destructive" : "secondary"}>{status}</Badge>
                          </div>
                          <div className="grid gap-2 text-xs sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                            <div>
                              {decision ? (
                                <>
                                  <span className="text-muted-foreground">Requested outcome </span>
                                  <span className="font-semibold uppercase">{decision.requestedTarget ?? "random"}</span>
                                  {decision.requestedStrategy && <span className="text-muted-foreground"> · {decision.requestedStrategy.replaceAll("_", " ")}</span>}
                                </>
                              ) : selectionSummary?.configured ? (
                                <>
                                  <span className="text-muted-foreground">Requested outcome </span>
                                  <span className="font-semibold uppercase">
                                    {selectionSummary.requestedTarget ?? "controlled"}
                                  </span>
                                  <span className="text-muted-foreground"> · legacy record</span>
                                </>
                              ) : (
                                <>
                                  <span className="text-muted-foreground">Observed battle </span>
                                  <span className="font-semibold uppercase">{observed?.mode ?? "unknown mode"}</span>
                                  <span className="text-muted-foreground"> · {observed?.status ?? "unknown status"}</span>
                                </>
                              )}
                            </div>
                            <span className="hidden text-muted-foreground sm:inline">→</span>
                            <div className="sm:text-right">
                              <span className="text-muted-foreground">{decision ? "EOS selected outcome " : "Final creator outcome "}</span>
                              <span className={`font-semibold uppercase ${creatorWon === true ? "text-emerald-600" : creatorWon === false ? "text-destructive" : ""}`}>{creatorWon === null ? "pending" : creatorWon ? "win" : "loss"}</span>
                              <span className="text-muted-foreground"> · {multiplier?.toFixed(2) ?? "—"}× · profit {profit?.toFixed(2) ?? "—"} {currency}</span>
                            </div>
                          </div>
                        </summary>
                        <div className="mt-3 space-y-2 border-t pt-3 text-xs text-muted-foreground">
                          {decision ? (
                            <>
                              <p>{wins} winning and {decision.candidates.length - wins} losing creator outcomes were available in the five-block window.</p>
                              <p>Source: {decision.controlKind.replaceAll("_", " ")} · Selected block {decision.selected.blockNumber} · Random baseline {decision.randomBlockNumber}</p>
                            </>
                          ) : (
                            <p>{selectionSummary
                              ? "The EOS selection was recorded before detailed five-candidate auditing began. Control state and requested outcome are known, but the candidate window cannot be reconstructed."
                              : entry.beforeTracking
                                ? "The completed battle is visible from production data, but it happened before EOS selection tracking began, so its candidate outcomes cannot be reconstructed."
                                : "The battle has an EOS block but no corresponding monitor record. This is a real integration warning, not an empty-history state."}</p>
                          )}
                          {observed && <p>Creator cost {observed.creatorCost.toFixed(2)} {observed.currency} · payout {observed.creatorPayout?.toFixed(2) ?? "—"} {observed.currency} · team {observed.creatorTeam}{observed.winnerTeam === null ? "" : ` · winning team ${observed.winnerTeam}`}</p>}
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

      <Card className="xl:sticky xl:top-5">
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
        <CardContent className="max-h-[72vh] space-y-2 overflow-y-auto">
          {configs.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No personal outcome controls configured.</p>}
          {configs.length > 0 && visibleConfigs.length === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No configured users match this filter.</p>}
          {visibleConfigs.map((config) => {
            const activeRule = config.rules[config.currentRuleIndex];
            const totalBattles = config.rules.reduce((sum, rule) => sum + rule.count, 0);
            const completedBattles = config.rules.slice(0, config.currentRuleIndex).reduce((sum, rule) => sum + rule.count, 0) + (activeRule ? activeRule.count - config.remainingInRule : totalBattles);
            const progress = totalBattles > 0 ? Math.min(100, Math.round((completedBattles / totalBattles) * 100)) : 0;
            const status = config.enabled ? (config.persistent ? "Running" : "Active") : (activeRule ? "Paused" : "Complete");
            return (
              <div key={config.userId} className={`space-y-3 rounded-lg p-3 ring-1 ${selected?.userId === config.userId ? "bg-primary/5 ring-primary/35" : "ring-foreground/10"}`}>
                <div className="flex items-start justify-between gap-3">
                  <button type="button" className="min-w-0 text-left" onClick={() => loadConfig({ userId: config.userId, username: config.username, displayUsername: null }, config)}>
                    <p className="truncate text-sm font-semibold">{config.username ?? "Unnamed user"}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{config.userId}</p>
                  </button>
                  <div className="flex flex-wrap items-center justify-end gap-1">
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
