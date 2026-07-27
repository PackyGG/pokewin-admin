"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  Blocks,
  CheckCircle2,
  CircleSlash2,
  Clock3,
  Plus,
  Save,
  ShieldAlert,
  Trash2,
  Workflow,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type {
  AntifraudBehaviorRule,
  AntifraudMonitorEvent,
} from "@/lib/antifraud/monitor-api";
import { cn } from "@/lib/utils";
import { saveAntifraudFlow } from "./actions";

type Draft = {
  id?: string;
  name: string;
  description: string;
  enabled: boolean;
  sequence: FlowStep[];
  excludeBefore: string[];
  windowSeconds: number;
  scoreDelta: number;
  actionType: "manual_review" | "escalate";
};

type FlowStep = {
  id: string;
  key: string;
};

function fromRule(rule: AntifraudBehaviorRule): Draft {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    enabled: rule.enabled,
    sequence: rule.sequence.map((key, index) => ({
      id: `${rule.id}-${index}`,
      key,
    })),
    excludeBefore: [...rule.exclude_before],
    windowSeconds: rule.window_seconds,
    scoreDelta: rule.score_delta,
    actionType: rule.action_type === "escalate" ? "escalate" : "manual_review",
  };
}

function emptyDraft(defaultEvent: string, monitorWindowSeconds: number): Draft {
  return {
    name: "Untitled flow",
    description: "",
    enabled: false,
    sequence: defaultEvent ? [{ id: "new-0", key: defaultEvent }] : [],
    excludeBefore: [],
    windowSeconds: monitorWindowSeconds,
    scoreDelta: 20,
    actionType: "manual_review",
  };
}

export function FlowBuilder({
  initialRules,
  events,
  monitorWindowSeconds,
}: {
  initialRules: AntifraudBehaviorRule[];
  events: AntifraudMonitorEvent[];
  monitorWindowSeconds: number;
}) {
  const router = useRouter();
  const firstLiveEvent =
    events.find((definition) => definition.status === "live")?.key ?? "";
  const [rules, setRules] = React.useState(initialRules);
  const [selectedId, setSelectedId] = React.useState<string | "new">(
    initialRules[0]?.id ?? "new",
  );
  const [draft, setDraft] = React.useState<Draft>(() =>
    initialRules[0]
      ? fromRule(initialRules[0])
      : emptyDraft(firstLiveEvent, monitorWindowSeconds),
  );
  const [pending, startTransition] = React.useTransition();
  const eventByKey = React.useMemo(
    () => new Map(events.map((definition) => [definition.key, definition])),
    [events],
  );
  const groupedEvents = React.useMemo(
    () =>
      events.reduce<Record<string, AntifraudMonitorEvent[]>>((groups, item) => {
        (groups[item.category] ??= []).push(item);
        return groups;
      }, {}),
    [events],
  );
  const plannedKeys = [
    ...draft.sequence.map((step) => step.key),
    ...draft.excludeBefore,
  ].filter(
    (key) => eventByKey.get(key)?.status !== "live",
  );
  const uniquePlannedKeys = [...new Set(plannedKeys)];

  function selectRule(rule: AntifraudBehaviorRule) {
    setSelectedId(rule.id);
    setDraft(fromRule(rule));
  }

  function beginNew() {
    setSelectedId("new");
    setDraft(emptyDraft(firstLiveEvent, monitorWindowSeconds));
  }

  function updateSequence(index: number, key: string) {
    setDraft((current) => ({
      ...current,
      sequence: current.sequence.map((step, itemIndex) =>
        itemIndex === index ? { ...step, key } : step,
      ),
    }));
  }

  function moveSequence(index: number, direction: -1 | 1) {
    setDraft((current) => {
      const destination = index + direction;
      if (destination < 0 || destination >= current.sequence.length) {
        return current;
      }
      const sequence = [...current.sequence];
      [sequence[index], sequence[destination]] = [
        sequence[destination]!,
        sequence[index]!,
      ];
      return { ...current, sequence };
    });
  }

  function save() {
    if (!draft.name.trim()) {
      toast.error("Give the flow a name");
      return;
    }
    if (draft.sequence.length === 0) {
      toast.error("Add at least one event");
      return;
    }
    if (draft.enabled && uniquePlannedKeys.length > 0) {
      toast.error("Planned events can only be saved in a disabled draft");
      return;
    }
    startTransition(async () => {
      try {
        const saved = await saveAntifraudFlow({
          ...draft,
          sequence: draft.sequence.map((step) => step.key),
          id: selectedId === "new" ? undefined : selectedId,
          idempotencyKey: crypto.randomUUID(),
        });
        setRules((current) => {
          const exists = current.some((rule) => rule.id === saved.id);
          return exists
            ? current.map((rule) => (rule.id === saved.id ? saved : rule))
            : [...current, saved];
        });
        setSelectedId(saved.id);
        setDraft(fromRule(saved));
        toast.success(saved.enabled ? "Flow saved and monitoring" : "Draft flow saved");
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "The flow could not be saved",
        );
      }
    });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="overflow-hidden rounded-xl border border-border/70 bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-3">
          <div>
            <h2 className="text-sm font-semibold">Flows</h2>
            <p className="text-[11px] text-muted-foreground">
              {rules.filter((rule) => rule.enabled).length} active · {rules.length} total
            </p>
          </div>
          <Button type="button" size="sm" onClick={beginNew}>
            <Plus className="size-3.5" aria-hidden />
            New
          </Button>
        </div>
        <div className="max-h-[720px] space-y-1 overflow-y-auto p-2">
          {rules.map((rule) => (
            <button
              key={rule.id}
              type="button"
              onClick={() => selectRule(rule)}
              className={cn(
                "w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
                selectedId === rule.id
                  ? "border-cyan-500/40 bg-cyan-500/10"
                  : "border-transparent hover:border-border/70 hover:bg-muted/40",
              )}
            >
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{rule.name}</span>
                  <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                    {rule.sequence.length} steps · {rule.window_seconds}s
                  </span>
                </span>
                <span
                  className={cn(
                    "mt-1 size-2 shrink-0 rounded-full",
                    rule.enabled ? "bg-emerald-500" : "bg-muted-foreground/40",
                  )}
                  aria-label={rule.enabled ? "Active" : "Draft"}
                />
              </span>
            </button>
          ))}
          {rules.length === 0 && (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              No flows yet. Create the first one.
            </p>
          )}
        </div>
      </aside>

      <div className="min-w-0 space-y-4">
        <section className="rounded-xl border border-border/70 bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <span className="rounded-lg bg-cyan-500/10 p-2 text-cyan-600 dark:text-cyan-400">
                <Blocks className="size-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold">
                    {selectedId === "new" ? "Build a new flow" : "Edit flow"}
                  </h2>
                  <Badge
                    variant="outline"
                    className={
                      draft.enabled
                        ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                        : ""
                    }
                  >
                    {draft.enabled ? "Monitoring" : "Draft"}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Every enabled flow is checked against every accepted event in each live monitor session.
                </p>
              </div>
            </div>
            <label className="flex items-center gap-2 rounded-lg border border-border/70 px-3 py-2 text-xs font-medium">
              Active
              <Switch
                checked={draft.enabled}
                onCheckedChange={(enabled) =>
                  setDraft((current) => ({ ...current, enabled }))
                }
                disabled={pending}
              />
            </label>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium">
              Flow name
              <Input
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
                maxLength={100}
                disabled={pending}
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium">
              Description
              <Textarea
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                maxLength={500}
                rows={2}
                disabled={pending}
              />
            </label>
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border border-border/70 bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Workflow className="size-4 text-cyan-500" aria-hidden />
                Event sequence
              </h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Events must happen in this order. Other events may happen between steps.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  sequence: [
                    ...current.sequence,
                    { id: crypto.randomUUID(), key: firstLiveEvent },
                  ],
                }))
              }
              disabled={pending || !firstLiveEvent || draft.sequence.length >= 20}
            >
              <Plus className="size-3.5" aria-hidden />
              Add step
            </Button>
          </div>
          <div className="space-y-2 p-3 sm:p-4">
            {draft.sequence.map((step, index) => (
              <div
                key={step.id}
                className="grid gap-2 rounded-lg border border-border/60 bg-muted/20 p-2 sm:grid-cols-[34px_minmax(0,1fr)_auto] sm:items-center"
              >
                <span className="flex size-8 items-center justify-center rounded-md bg-cyan-500/10 text-xs font-bold text-cyan-600 dark:text-cyan-400">
                  {index + 1}
                </span>
                <EventSelect
                  value={step.key}
                  onValueChange={(next) => updateSequence(index, next)}
                  groupedEvents={groupedEvents}
                  disabled={pending}
                />
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => moveSequence(index, -1)}
                    disabled={pending || index === 0}
                    aria-label={`Move step ${index + 1} up`}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => moveSequence(index, 1)}
                    disabled={pending || index === draft.sequence.length - 1}
                    aria-label={`Move step ${index + 1} down`}
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        sequence: current.sequence.filter(
                          (_, itemIndex) => itemIndex !== index,
                        ),
                      }))
                    }
                    disabled={pending || draft.sequence.length === 1}
                    aria-label={`Remove step ${index + 1}`}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border/70 bg-card p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <CircleSlash2 className="size-4 text-amber-500" aria-hidden />
              Stop conditions
            </h3>
            <p className="mt-1 text-[11px] text-muted-foreground">
              If one of these events occurs before the sequence completes, the flow will not match.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {draft.excludeBefore.map((key) => (
                <Badge key={key} variant="outline" className="gap-1">
                  {eventByKey.get(key)?.name ?? key}
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        excludeBefore: current.excludeBefore.filter(
                          (item) => item !== key,
                        ),
                      }))
                    }
                    aria-label={`Remove ${eventByKey.get(key)?.name ?? key}`}
                    disabled={pending}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </Badge>
              ))}
              {draft.excludeBefore.length === 0 && (
                <span className="text-xs text-muted-foreground">None</span>
              )}
            </div>
            <div className="mt-3">
              <EventSelect
                value=""
                placeholder="Add stop event"
                onValueChange={(key) =>
                  setDraft((current) => ({
                    ...current,
                    excludeBefore: current.excludeBefore.includes(key)
                      ? current.excludeBefore
                      : [...current.excludeBefore, key],
                  }))
                }
                groupedEvents={groupedEvents}
                disabled={pending || draft.excludeBefore.length >= 20}
              />
            </div>
          </div>

          <div className="rounded-xl border border-border/70 bg-card p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Zap className="size-4 text-rose-500" aria-hidden />
              Match outcome
            </h3>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Applied once per flow and monitor session when all steps match.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="space-y-1.5 text-xs font-medium">
                Within seconds
                <Input
                  type="number"
                  min={1}
                  max={86_400}
                  value={draft.windowSeconds}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      windowSeconds: Number(event.target.value),
                    }))
                  }
                  disabled={pending}
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium">
                Risk points
                <Input
                  type="number"
                  min={-500}
                  max={500}
                  step={1}
                  value={draft.scoreDelta}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      scoreDelta: Number(event.target.value),
                    }))
                  }
                  disabled={pending}
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium">
                Action
                <Select
                  value={draft.actionType}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      actionType:
                        value === "escalate" ? "escalate" : "manual_review",
                    }))
                  }
                  disabled={pending}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual_review">Manual review</SelectItem>
                    <SelectItem value="escalate">Escalate</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>
          </div>
        </section>

        {uniquePlannedKeys.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {uniquePlannedKeys
                .map((key) => eventByKey.get(key)?.name ?? key)
                .join(", ")}{" "}
              {uniquePlannedKeys.length === 1 ? "is" : "are"} documented but not live yet.
              Keep this flow disabled until those events are connected.
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card px-4 py-3">
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {draft.enabled && uniquePlannedKeys.length === 0 ? (
              <CheckCircle2 className="size-4 text-emerald-500" aria-hidden />
            ) : (
              <Clock3 className="size-4 text-muted-foreground" aria-hidden />
            )}
            {draft.enabled && uniquePlannedKeys.length === 0
              ? "The live monitor will evaluate this flow immediately after save."
              : "Drafts are stored but never evaluated by the monitor."}
          </span>
          <Button type="button" onClick={save} disabled={pending}>
            <Save className="size-4" aria-hidden />
            {pending ? "Saving…" : "Save flow"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function EventSelect({
  value,
  placeholder = "Choose an event",
  onValueChange,
  groupedEvents,
  disabled,
}: {
  value: string;
  placeholder?: string;
  onValueChange: (value: string) => void;
  groupedEvents: Record<string, AntifraudMonitorEvent[]>;
  disabled: boolean;
}) {
  return (
    <Select
      value={value || undefined}
      onValueChange={(next) => {
        if (next) onValueChange(next);
      }}
      disabled={disabled}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {Object.entries(groupedEvents).flatMap(([category, definitions]) => [
          <div
            key={`${category}-label`}
            className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {category}
          </div>,
          ...definitions.map((definition) => (
            <SelectItem key={definition.key} value={definition.key}>
              {definition.name}
              {definition.status === "planned" ? " · planned" : ""}
            </SelectItem>
          )),
        ])}
      </SelectContent>
    </Select>
  );
}
