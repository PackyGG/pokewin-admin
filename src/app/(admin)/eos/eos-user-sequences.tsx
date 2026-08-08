"use client";

import { useState, useTransition } from "react";
import {
  ListOrdered,
  Loader2,
  Plus,
  Repeat2,
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
  { target: "loss", strategy: "lowest_profit", count: 1 },
];

const targetLabels: Record<EosUserRule["target"], string> = {
  loss: "Creator loses",
  win: "Creator wins",
  any: "Any outcome",
};

const targetHelp: Record<EosUserRule["target"], string> = {
  loss: "Choose a block where the creator loses. If none exists, use the creator's lowest money result.",
  win: "Choose a block where the creator wins. If none exists, use the creator's best available result.",
  any: "Do not force a win or loss. Choose from all five possible blocks.",
};

const strategyLabels: Record<EosUserRule["strategy"], string> = {
  random: "Random matching result",
  lowest_profit: "Lowest money result",
  highest_profit: "Highest money result",
};

function cloneRules(rules: EosUserRule[]): EosUserRule[] {
  return rules.map((rule) => ({ ...rule }));
}

function ruleSummary(rule: EosUserRule): string {
  return `${targetLabels[rule.target]} · ${strategyLabels[rule.strategy]}`;
}

function RuleFields({
  rule,
  index,
  showCount,
  onChange,
}: {
  rule: EosUserRule;
  index: number;
  showCount: boolean;
  onChange: (patch: Partial<EosUserRule>) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1.5 text-xs font-medium">
        Outcome
        <select
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
          value={rule.target}
          onChange={(event) => onChange({
            target: event.target.value as EosUserRule["target"],
          })}
        >
          {Object.entries(targetLabels).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>
      <label className="space-y-1.5 text-xs font-medium">
        Which matching result?
        <select
          className="h-10 w-full rounded-md border bg-background px-3 text-sm font-normal"
          value={rule.strategy}
          onChange={(event) => onChange({
            strategy: event.target.value as EosUserRule["strategy"],
          })}
        >
          {Object.entries(strategyLabels).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>
      {showCount && (
        <label className="space-y-1.5 text-xs font-medium sm:col-span-2">
          Number of battles for this step
          <Input
            className="max-w-32"
            type="number"
            min={1}
            max={100}
            value={rule.count}
            aria-label={`Step ${index + 1} battle count`}
            onChange={(event) => onChange({
              count: Math.min(100, Math.max(1, Number(event.target.value) || 1)),
            })}
          />
        </label>
      )}
      <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
        {targetHelp[rule.target]}
      </p>
    </div>
  );
}

export function EosUserSequences({ initial }: { initial: EosUserConfig[] }) {
  const [configs, setConfigs] = useState(initial);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [selected, setSelected] = useState<UserResult | null>(null);
  const [rules, setRules] = useState<EosUserRule[]>(cloneRules(defaultRules));
  const [persistent, setPersistent] = useState(true);
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

  function loadConfig(user: UserResult, existing?: EosUserConfig) {
    setSelected(user);
    setRules(cloneRules(existing?.rules ?? defaultRules));
    setPersistent(existing?.persistent ?? true);
    setEnabled(existing?.enabled ?? true);
    setResults([]);
  }

  function chooseUser(user: UserResult) {
    loadConfig(user, configs.find((config) => config.userId === user.userId));
  }

  function editConfig(config: EosUserConfig) {
    loadConfig({
      userId: config.userId,
      username: config.username,
      displayUsername: null,
    }, config);
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
          rules: persistent ? [rules[0]!] : rules,
          persistent,
          enabled,
        });
        setConfigs((current) => [
          saved,
          ...current.filter((config) => config.userId !== saved.userId),
        ]);
        setRules(cloneRules(saved.rules));
        toast.success(
          persistent
            ? "Permanent EOS outcome control saved"
            : "EOS outcome sequence saved and reset to step 1",
        );
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

  const permanentRule = rules[0] ?? defaultRules[0]!;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserRoundCog className="size-4 text-primary" />
            Per-user outcome control
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            A personal rule overrides the global “user only loses” setting while it is active.
          </p>
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
            <div className="space-y-5 rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">
                    {selected.displayUsername ?? selected.username ?? "Unnamed user"}
                  </p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {selected.userId}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm font-medium">
                  Control enabled
                  <Switch checked={enabled} onCheckedChange={setEnabled} />
                </label>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  How long should it apply?
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setPersistent(true)}
                    className={`rounded-lg border p-3 text-left transition-colors ${
                      persistent ? "border-primary bg-primary/5" : "hover:bg-muted/40"
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <Repeat2 className="size-4" /> Always apply
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Every future battle until you disable or remove it.
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPersistent(false)}
                    className={`rounded-lg border p-3 text-left transition-colors ${
                      !persistent ? "border-primary bg-primary/5" : "hover:bg-muted/40"
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <ListOrdered className="size-4" /> Run a sequence
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Run the steps once, then automatically stop.
                    </span>
                  </button>
                </div>
              </div>

              {persistent ? (
                <div className="space-y-3 rounded-lg bg-muted/35 p-4">
                  <div>
                    <p className="text-sm font-semibold">Rule for every battle</p>
                    <p className="text-xs text-muted-foreground">
                      This rule never expires and its counter does not decrease.
                    </p>
                  </div>
                  <RuleFields
                    rule={permanentRule}
                    index={0}
                    showCount={false}
                    onChange={(patch) => updateRule(0, patch)}
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  {rules.map((rule, index) => (
                    <div key={index} className="space-y-3 rounded-lg bg-muted/35 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">Step {index + 1}</p>
                          <p className="text-xs text-muted-foreground">
                            This step runs for {rule.count} {rule.count === 1 ? "battle" : "battles"}.
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={`Remove step ${index + 1}`}
                          disabled={rules.length === 1}
                          onClick={() => setRules((current) =>
                            current.filter((_, ruleIndex) => ruleIndex !== index)
                          )}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                      <RuleFields
                        rule={rule}
                        index={index}
                        showCount
                        onChange={(patch) => updateRule(index, patch)}
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={rules.length >= 20}
                    onClick={() => setRules((current) => [
                      ...current,
                      { target: "win", strategy: "lowest_profit", count: 1 },
                    ])}
                  >
                    <Plus className="size-4" /> Add next step
                  </Button>
                </div>
              )}

              <div className="flex justify-end">
                <Button type="button" disabled={isPending} onClick={save}>
                  {isPending && <Loader2 className="size-4 animate-spin" />}
                  {persistent ? "Save permanent rule" : "Save and restart sequence"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              Search for a dev user to create a permanent rule or a finite outcome sequence.
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
              No personal outcome controls configured.
            </p>
          )}
          {configs.map((config) => {
            const activeRule = config.rules[config.currentRuleIndex];
            const status = config.enabled
              ? (config.persistent ? "Permanent" : "Active")
              : (activeRule ? "Paused" : "Complete");
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
                      {status}
                    </Badge>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${config.username ?? config.userId}`}
                      onClick={() => remove(config.userId)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                {config.persistent && activeRule ? (
                  <p className="text-xs text-muted-foreground">
                    Every battle: {ruleSummary(activeRule)}. Stays active until disabled.
                  </p>
                ) : activeRule ? (
                  <p className="text-xs text-muted-foreground">
                    Step {config.currentRuleIndex + 1} of {config.rules.length}: {ruleSummary(activeRule)}
                    {" · "}{config.remainingInRule} remaining
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Sequence finished. Open and save it to restart from step 1.
                  </p>
                )}
                {!config.persistent && (
                  <div className="flex flex-wrap gap-1">
                    {config.rules.map((rule, index) => (
                      <Badge key={`${config.userId}-${index}`} variant="outline" className="text-[10px]">
                        {rule.count}× {ruleSummary(rule)}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
