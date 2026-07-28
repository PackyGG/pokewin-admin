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

import { SectionHeading } from "@/components/modern-panels";
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
      <aside className="self-start overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Flows</h2>
            <p className="text-xs text-muted-foreground">
              {rules.filter((rule) => rule.enabled).length} active · {rules.length} total
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={beginNew}>
            <Plus className="size-3.5" aria-hidden />
            New
          </Button>
        </div>
        <div className="max-h-[720px] space-y-1 overflow-y-auto p-2">
          {selectedId === "new" && (
            <div className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2.5">
              <span className="block truncate text-sm font-medium">
                {draft.name.trim() || "Untitled flow"}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Unsaved new flow
              </span>
            </div>
          )}
          {rules.map((rule) => (
            <button
              key={rule.id}
              type="button"
              onClick={() => selectRule(rule)}
              className={cn(
                "w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
                selectedId === rule.id
                  ? "border-primary/40 bg-primary/5"
                  : "border-transparent hover:border-border hover:bg-muted/40",
              )}
            >
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{rule.name}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {rule.sequence.length} {rule.sequence.length === 1 ? "step" : "steps"} ·{" "}
                    {rule.window_seconds}s window
                  </span>
                </span>
                <span
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    rule.enabled ? "bg-emerald-500" : "bg-muted-foreground/40",
                  )}
                  aria-label={rule.enabled ? "Active" : "Draft"}
                />
              </span>
            </button>
          ))}
          {rules.length === 0 && selectedId !== "new" && (
            <div className="px-3 py-10 text-center">
              <Workflow
                className="mx-auto size-5 text-muted-foreground"
                aria-hidden
              />
              <p className="mt-2 text-xs text-muted-foreground">
                No flows yet. Create the first one.
              </p>
            </div>
          )}
        </div>
      </aside>

      <div className="min-w-0 space-y-6">
        <section className="space-y-3">
          <SectionHeading
            icon={Blocks}
            title={
              <>
                {selectedId === "new" ? "New flow" : "Flow details"}
                <span className="text-xs font-normal text-muted-foreground">
                  name, description, and monitoring state
                </span>
              </>
            }
          />
          <div className="rounded-xl border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Badge
                variant="outline"
                className={cn(
                  draft.enabled &&
                    "border-emerald-500/25 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400",
                )}
              >
                {draft.enabled ? (
                  <CheckCircle2 className="size-3.5" aria-hidden />
                ) : (
                  <Clock3 className="size-3.5" aria-hidden />
                )}
                {draft.enabled ? "Monitoring" : "Draft"}
              </Badge>
              <label className="flex items-center gap-2 text-xs font-medium">
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
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
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
            <p className="mt-3 text-xs text-muted-foreground">
              Every enabled flow is checked against every accepted event in each
              live monitor session.
            </p>
          </div>
        </section>

        <section className="space-y-3">
          <SectionHeading
            icon={Workflow}
            title={
              <>
                Event sequence
                <span className="text-xs font-normal text-muted-foreground">
                  events must happen in this order — other events may occur between steps
                </span>
              </>
            }
            action={
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
            }
          />
          <div className="space-y-2">
            {draft.sequence.map((step, index) => (
              <div
                key={step.id}
                className="grid gap-2 rounded-xl border bg-card p-3 sm:grid-cols-[32px_minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="flex size-8 items-center justify-center rounded-full border border-primary/25 bg-primary/5 text-xs font-semibold text-primary">
                  {index + 1}
                </div>
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
            {draft.sequence.length === 0 && (
              <div className="rounded-xl border border-dashed bg-card/40 px-4 py-10 text-center">
                <Workflow
                  className="mx-auto size-5 text-muted-foreground"
                  aria-hidden
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  No steps yet. Add the first event of the sequence.
                </p>
              </div>
            )}
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <section className="space-y-3">
            <SectionHeading
              icon={CircleSlash2}
              title={
                <>
                  Stop conditions
                  <span className="text-xs font-normal text-muted-foreground">
                    optional
                  </span>
                </>
              }
            />
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs leading-5 text-muted-foreground">
                If one of these events occurs before the sequence completes, the
                flow will not match.
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {draft.excludeBefore.map((key) => (
                  <Badge
                    key={key}
                    variant="outline"
                    className="gap-1 border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-400"
                  >
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
                  <span className="text-xs text-muted-foreground">
                    None — the sequence matches regardless of other events.
                  </span>
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
          </section>

          <section className="space-y-3">
            <SectionHeading
              icon={Zap}
              title={
                <>
                  Match outcome
                  <span className="text-xs font-normal text-muted-foreground">
                    applied once per flow and session
                  </span>
                </>
              }
            />
            <div className="rounded-xl border bg-card p-4">
              <p className="text-xs leading-5 text-muted-foreground">
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
        </div>

        {uniquePlannedKeys.length > 0 && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-xs leading-5 text-amber-700 dark:text-amber-400">
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

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3">
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
