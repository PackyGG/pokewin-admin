"use client";

import { useState, useTransition } from "react";
import {
  ListOrdered,
  Loader2,
  Plus,
  Search,
  Trash2,
  UserRoundCog,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type {
  EosUserConfig,
  EosUserRule,
} from "@/lib/antifraud/eos-test-config-api";
import {
  removeEosUserConfig,
  saveEosUserConfig,
  searchEosDevUsers,
} from "./actions";

type UserResult = Awaited<ReturnType<typeof searchEosDevUsers>>[number];

const defaultRules: EosUserRule[] = [
  { target: "loss", strategy: "lowest_profit", count: 2 },
  { target: "win", strategy: "lowest_profit", count: 1 },
];

const targetLabels: Record<EosUserRule["target"], string> = {
  loss: "Lose battle",
  win: "Win battle",
  any: "Any result",
};

const strategyLabels: Record<EosUserRule["strategy"], string> = {
  random: "Random matching block",
  lowest_profit: "Lowest profit",
  highest_profit: "Highest profit",
};

function cloneRules(rules: EosUserRule[]): EosUserRule[] {
  return rules.map((rule) => ({ ...rule }));
}

export function EosUserSequences({ initial }: { initial: EosUserConfig[] }) {
  const [configs, setConfigs] = useState(initial);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [selected, setSelected] = useState<UserResult | null>(null);
  const [rules, setRules] = useState<EosUserRule[]>(cloneRules(defaultRules));
  const [enabled, setEnabled] = useState(true);
  const [isPending, startTransition] = useTransition();

  function search() {
    startTransition(async () => {
      try {
        setResults(await searchEosDevUsers(query));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "User search failed");
      }
    });
  }

  function chooseUser(user: UserResult) {
    const existing = configs.find((config) => config.userId === user.userId);
    setSelected(user);
    setRules(cloneRules(existing?.rules ?? defaultRules));
    setEnabled(existing?.enabled ?? true);
    setResults([]);
  }

  function editConfig(config: EosUserConfig) {
    setSelected({
      userId: config.userId,
      username: config.username,
      displayUsername: null,
    });
    setRules(cloneRules(config.rules));
    setEnabled(config.enabled);
  }

  function updateRule(index: number, patch: Partial<EosUserRule>) {
    setRules((current) => current.map((rule, ruleIndex) =>
      ruleIndex === index ? { ...rule, ...patch } : rule
    ));
  }

  function save() {
    if (!selected) return;
    startTransition(async () => {
      try {
        const saved = await saveEosUserConfig({
          userId: selected.userId,
          username: selected.username ?? selected.displayUsername,
          rules,
          enabled,
        });
        setConfigs((current) => [
          saved,
          ...current.filter((config) => config.userId !== saved.userId),
        ]);
        toast.success("Personal EOS sequence saved and reset to step 1");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Sequence save failed");
      }
    });
  }

  function remove(userId: string) {
    startTransition(async () => {
      try {
        await removeEosUserConfig(userId);
        setConfigs((current) => current.filter((config) => config.userId !== userId));
        if (selected?.userId === userId) setSelected(null);
        toast.success("Personal EOS sequence removed");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Sequence removal failed");
      }
    });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserRoundCog className="size-4 text-primary" />
            Per-user outcome sequence
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && query.trim().length >= 2) search();
                }}
                placeholder="Search dev user ID or username"
              />
              <Button
                type="button"
                variant="outline"
                disabled={isPending || query.trim().length < 2}
                onClick={search}
              >
                {isPending ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                Search
              </Button>
            </div>
            {results.length > 0 && (
              <div className="divide-y rounded-lg border">
                {results.map((user) => (
                  <button
                    key={user.userId}
                    type="button"
                    className="flex w-full items-center justify-between gap-4 p-3 text-left hover:bg-muted/50"
                    onClick={() => chooseUser(user)}
                  >
                    <span className="text-sm font-medium">
                      {user.displayUsername ?? user.username ?? "Unnamed user"}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {user.userId}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {selected ? (
            <div className="space-y-4 rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">
                    {selected.displayUsername ?? selected.username ?? "Unnamed user"}
                  </p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {selected.userId}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  Enabled
                  <Switch checked={enabled} onCheckedChange={setEnabled} />
                </div>
              </div>

              <div className="space-y-2">
                {rules.map((rule, index) => (
                  <div
                    key={`${index}-${rule.target}-${rule.strategy}`}
                    className="grid gap-2 rounded-md bg-muted/40 p-3 sm:grid-cols-[32px_1fr_1fr_90px_36px] sm:items-center"
                  >
                    <span className="text-center text-xs font-semibold text-muted-foreground">
                      {index + 1}
                    </span>
                    <select
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                      value={rule.target}
                      onChange={(event) => updateRule(index, {
                        target: event.target.value as EosUserRule["target"],
                      })}
                    >
                      {Object.entries(targetLabels).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                    <select
                      className="h-9 rounded-md border bg-background px-2 text-sm"
                      value={rule.strategy}
                      onChange={(event) => updateRule(index, {
                        strategy: event.target.value as EosUserRule["strategy"],
                      })}
                    >
                      {Object.entries(strategyLabels).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      value={rule.count}
                      aria-label={`Rule ${index + 1} battle count`}
                      onChange={(event) => updateRule(index, {
                        count: Math.min(100, Math.max(1, Number(event.target.value) || 1)),
                      })}
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={rules.length === 1}
                      onClick={() => setRules((current) =>
                        current.filter((_, ruleIndex) => ruleIndex !== index)
                      )}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap justify-between gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={rules.length >= 20}
                  onClick={() => setRules((current) => [
                    ...current,
                    { target: "win", strategy: "lowest_profit", count: 1 },
                  ])}
                >
                  <Plus className="size-4" />
                  Add step
                </Button>
                <Button type="button" disabled={isPending} onClick={save}>
                  {isPending && <Loader2 className="size-4 animate-spin" />}
                  Save and reset sequence
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              Search for a dev user to create an ordered result sequence.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ListOrdered className="size-4 text-primary" />
            Configured users
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {configs.length === 0 && (
            <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No personal sequences configured.
            </p>
          )}
          {configs.map((config) => {
            const activeRule = config.rules[config.currentRuleIndex];
            return (
              <div key={config.userId} className="space-y-3 rounded-lg border p-3">
                <div className="flex items-start justify-between gap-3">
                  <button type="button" className="min-w-0 text-left" onClick={() => editConfig(config)}>
                    <p className="truncate text-sm font-semibold">
                      {config.username ?? "Unnamed user"}
                    </p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {config.userId}
                    </p>
                  </button>
                  <div className="flex items-center gap-1.5">
                    <Badge variant={config.enabled ? "default" : "secondary"}>
                      {config.enabled ? "Active" : "Complete"}
                    </Badge>
                    <Button type="button" size="icon" variant="ghost" onClick={() => remove(config.userId)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                {activeRule ? (
                  <p className="text-xs text-muted-foreground">
                    Step {config.currentRuleIndex + 1}/{config.rules.length}: {targetLabels[activeRule.target]}
                    {" · "}{strategyLabels[activeRule.strategy]}
                    {" · "}{config.remainingInRule} remaining
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Sequence finished. Open and save it to restart from step 1.
                  </p>
                )}
                <div className="flex flex-wrap gap-1">
                  {config.rules.map((rule, index) => (
                    <Badge key={`${config.userId}-${index}`} variant="outline" className="text-[10px]">
                      {rule.count}× {rule.target} / {rule.strategy.replace("_", " ")}
                    </Badge>
                  ))}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
