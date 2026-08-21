"use client";

import {
  ArrowDown,
  ArrowUp,
  Dices,
  ListOrdered,
  Plus,
  Repeat2,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { EosUserRule } from "@/lib/antifraud/eos-test-config-api";

type FlowMode = "once" | "repeat" | "random";

const targetLabels: Record<EosUserRule["target"], string> = {
  loss: "Creator loses",
  win: "Creator wins",
  any: "Any outcome",
};

const strategyLabels: Record<EosUserRule["strategy"], string> = {
  random: "Random match",
  lowest_profit: "Lowest profit",
  highest_profit: "Highest profit",
  lowest_multiplier: "Lowest multiplier",
  highest_multiplier: "Highest multiplier",
};

const emptyRule: EosUserRule = {
  target: "any",
  strategy: "random",
  count: 1,
  minMultiplier: null,
  maxMultiplier: null,
};

type FlowPreset = {
  name: string;
  description: string;
  mode: FlowMode;
  rules: EosUserRule[];
};

const presets: FlowPreset[] = [
  {
    name: "Win, win, lose",
    description: "Two low wins, then the lowest available losing multiplier.",
    mode: "repeat",
    rules: [
      { ...emptyRule, target: "win", strategy: "lowest_multiplier", count: 2 },
      { ...emptyRule, target: "loss", strategy: "lowest_multiplier", count: 1 },
    ],
  },
  {
    name: "Mostly losses",
    description: "Weighted mix: 80% losses and 20% low wins.",
    mode: "random",
    rules: [
      { ...emptyRule, target: "loss", strategy: "random", count: 4 },
      { ...emptyRule, target: "win", strategy: "lowest_multiplier", count: 1 },
    ],
  },
  {
    name: "Low multiplier mix",
    description: "Random outcomes constrained to multipliers from 0× to 2×.",
    mode: "random",
    rules: [
      { ...emptyRule, target: "loss", strategy: "lowest_multiplier", count: 3, maxMultiplier: 2 },
      { ...emptyRule, target: "win", strategy: "lowest_multiplier", count: 2, maxMultiplier: 2 },
    ],
  },
  {
    name: "Balanced random",
    description: "Equal chance of a random win or loss.",
    mode: "random",
    rules: [
      { ...emptyRule, target: "win", strategy: "random", count: 1 },
      { ...emptyRule, target: "loss", strategy: "random", count: 1 },
    ],
  },
];

export function isEosFlowValid(rules: EosUserRule[]): boolean {
  return rules.length > 0 && rules.every((rule) =>
    rule.minMultiplier === null
    || rule.maxMultiplier === null
    || rule.minMultiplier <= rule.maxMultiplier
  );
}

export function eosRuleSummary(rule: EosUserRule): string {
  const range = rule.minMultiplier !== null || rule.maxMultiplier !== null
    ? ` · ${rule.minMultiplier ?? 0}×–${rule.maxMultiplier ?? "∞"}×`
    : "";
  return `${targetLabels[rule.target]} · ${strategyLabels[rule.strategy]}${range}`;
}

function currentMode(persistent: boolean, randomized: boolean): FlowMode {
  if (!persistent) return "once";
  return randomized ? "random" : "repeat";
}

function multiplierValue(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(10_000, Math.max(0, parsed)) : null;
}

export function EosFlowBuilder({
  id,
  rules,
  persistent,
  randomized,
  onRulesChange,
  onPersistentChange,
  onRandomizedChange,
}: {
  id: string;
  rules: EosUserRule[];
  persistent: boolean;
  randomized: boolean;
  onRulesChange: (rules: EosUserRule[]) => void;
  onPersistentChange: (persistent: boolean) => void;
  onRandomizedChange: (randomized: boolean) => void;
}) {
  const mode = currentMode(persistent, randomized);
  const total = rules.reduce((sum, rule) => sum + rule.count, 0);

  function setMode(next: FlowMode) {
    onPersistentChange(next !== "once");
    onRandomizedChange(next === "random");
  }

  function updateRule(index: number, patch: Partial<EosUserRule>) {
    onRulesChange(rules.map((rule, ruleIndex) =>
      ruleIndex === index ? { ...rule, ...patch } : rule
    ));
  }

  function moveRule(index: number, direction: -1 | 1) {
    const destination = index + direction;
    if (destination < 0 || destination >= rules.length) return;
    const next = [...rules];
    [next[index], next[destination]] = [next[destination], next[index]];
    onRulesChange(next);
  }

  return (
    <div className="space-y-5">
      <section className="space-y-2" aria-labelledby={`${id}-presets`}>
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <h3 id={`${id}-presets`} className="text-sm font-semibold">Quick patterns</h3>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {presets.map((preset) => (
            <button
              key={preset.name}
              type="button"
              className="rounded-lg border p-3 text-left transition-colors hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                onRulesChange(preset.rules.map((rule) => ({ ...rule })));
                setMode(preset.mode);
              }}
            >
              <span className="block text-sm font-semibold">{preset.name}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                {preset.description}
              </span>
            </button>
          ))}
        </div>
      </section>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Flow mode</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {([
            ["once", ListOrdered, "Run once", "Complete each step, then stop."],
            ["repeat", Repeat2, "Repeat in order", "Loop the ordered sequence."],
            ["random", Dices, "Weighted random", "Pick a weighted step each battle."],
          ] as const).map(([value, Icon, title, description]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={`rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                mode === value ? "border-primary bg-primary/5" : "hover:bg-muted/40"
              }`}
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <Icon className="size-4" />{title}
              </span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <section className="space-y-3" aria-labelledby={`${id}-steps`}>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 id={`${id}-steps`} className="text-sm font-semibold">Outcome steps</h3>
            <p className="text-xs text-muted-foreground">
              {randomized
                ? "Weight controls how often each rule is selected."
                : "Steps run from top to bottom; count controls consecutive battles."}
            </p>
          </div>
          <Badge variant="secondary">
            {rules.length} {rules.length === 1 ? "rule" : "rules"} · {total} {randomized ? "total weight" : "battles"}
          </Badge>
        </div>

        {rules.map((rule, index) => {
          const invalidRange = rule.minMultiplier !== null
            && rule.maxMultiplier !== null
            && rule.minMultiplier > rule.maxMultiplier;
          const probability = total > 0 ? Math.round((rule.count / total) * 100) : 0;
          return (
            <div key={`${id}-step-${index}`} className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{randomized ? `Rule ${index + 1}` : `Step ${index + 1}`}</Badge>
                    {randomized && <span className="text-xs font-medium text-primary">~{probability}%</span>}
                  </div>
                  <p className="mt-2 truncate text-xs text-muted-foreground">{eosRuleSummary(rule)}</p>
                </div>
                <div className="flex items-center">
                  {!randomized && (
                    <>
                      <Button type="button" size="icon" variant="ghost" disabled={index === 0} aria-label={`Move step ${index + 1} up`} onClick={() => moveRule(index, -1)}><ArrowUp className="size-4" /></Button>
                      <Button type="button" size="icon" variant="ghost" disabled={index === rules.length - 1} aria-label={`Move step ${index + 1} down`} onClick={() => moveRule(index, 1)}><ArrowDown className="size-4" /></Button>
                    </>
                  )}
                  <Button type="button" size="icon" variant="ghost" disabled={rules.length === 1} aria-label={`Remove step ${index + 1}`} onClick={() => onRulesChange(rules.filter((_, ruleIndex) => ruleIndex !== index))}><Trash2 className="size-4" /></Button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1.5 text-xs font-medium">
                  Outcome
                  <Select value={rule.target} onValueChange={(value) => value && updateRule(index, { target: value as EosUserRule["target"] })}>
                    <SelectTrigger className="h-10 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(targetLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 text-xs font-medium">
                  Selection
                  <Select value={rule.strategy} onValueChange={(value) => value && updateRule(index, { strategy: value as EosUserRule["strategy"] })}>
                    <SelectTrigger className="h-10 w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(strategyLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <label className="space-y-1.5 text-xs font-medium">
                  Minimum multiplier
                  <Input type="number" min={0} max={10_000} step="0.01" placeholder="No minimum" value={rule.minMultiplier ?? ""} aria-invalid={invalidRange} onChange={(event) => updateRule(index, { minMultiplier: multiplierValue(event.target.value) })} />
                </label>
                <label className="space-y-1.5 text-xs font-medium">
                  Maximum multiplier
                  <Input type="number" min={0} max={10_000} step="0.01" placeholder="No maximum" value={rule.maxMultiplier ?? ""} aria-invalid={invalidRange} onChange={(event) => updateRule(index, { maxMultiplier: multiplierValue(event.target.value) })} />
                </label>
                <label className="space-y-1.5 text-xs font-medium sm:col-span-2 xl:col-span-1">
                  {randomized ? "Weight" : "Number of battles"}
                  <Input className="max-w-36" type="number" min={1} max={100} value={rule.count} onChange={(event) => updateRule(index, { count: Math.min(100, Math.max(1, Number(event.target.value) || 1)) })} />
                </label>
              </div>
              {invalidRange && <p role="alert" className="mt-2 text-xs font-medium text-destructive">Minimum multiplier cannot be higher than maximum.</p>}
            </div>
          );
        })}

        <Button type="button" variant="outline" disabled={rules.length >= 20} onClick={() => onRulesChange([...rules, { ...emptyRule }])}>
          <Plus className="size-4" />Add outcome rule
        </Button>
      </section>
    </div>
  );
}
