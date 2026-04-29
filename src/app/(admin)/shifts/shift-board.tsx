"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Plus,
  Calendar,
  Clock,
  Users,
  Trash2,
  Check,
  X,
  CalendarDays,
  ArrowRight,
  ArrowDownLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { cn } from "@/lib/utils";
import { ROLE_COLORS } from "@/lib/constants";
import { useTimezone } from "@/components/timezone-provider";
import { timezoneLabel } from "@/lib/timezones";
import { copyDay, copyWeek, deleteShift, upsertShift } from "./actions";
import {
  DAY_NAMES,
  DAY_SHORT,
  formatWeekRange,
  localHhMmToUtc,
  parseWeekStartParam,
  shiftWeek,
  SHIFTS_PER_DAY,
  SLOT_LABELS,
  toZonedHhMm,
  weekStartToParam,
  type Shift,
  type Worker,
} from "./types";

// ─── Board ───────────────────────────────────────────────────────

export function ShiftBoard({
  weekStartsIso,
  currentWeekStartIso,
  currentWeekParam,
  shifts,
  workers,
}: {
  weekStartsIso: string[];
  currentWeekStartIso: string;
  currentWeekParam: string;
  shifts: Shift[];
  workers: Worker[];
}) {
  const router = useRouter();
  const tz = useTimezone();

  const firstWeekStart = React.useMemo(
    () => new Date(weekStartsIso[0] ?? currentWeekStartIso),
    [weekStartsIso, currentWeekStartIso],
  );

  // Group shifts by week-start ISO for O(1) per-cell lookup below.
  const shiftsByWeek = React.useMemo(() => {
    const byWeek = new Map<string, Map<string, Shift>>();
    for (const iso of weekStartsIso) {
      byWeek.set(iso, new Map());
    }
    for (const s of shifts) {
      const week = byWeek.get(s.weekStart);
      if (!week) continue;
      week.set(`${s.dayOfWeek}|${s.shiftSlot}`, s);
    }
    return byWeek;
  }, [shifts, weekStartsIso]);

  const workersById = React.useMemo(() => {
    const m = new Map<string, Worker>();
    for (const w of workers) m.set(w.id, w);
    return m;
  }, [workers]);

  const [editing, setEditing] = React.useState<{
    weekStart: Date;
    dayOfWeek: number;
    shiftSlot: number;
    shift: Shift | null;
  } | null>(null);

  const [copyTarget, setCopyTarget] = React.useState<Date | null>(null);

  function goWeeks(delta: number) {
    const target = shiftWeek(firstWeekStart, delta);
    router.push(`/shifts?week=${weekStartToParam(target)}`);
  }

  // Shared loading guard so a double-tap on the per-day or per-week
  // shortcuts can't fan out concurrent server actions.
  const [bulkBusy, setBulkBusy] = React.useState(false);

  async function handleCopyDay(args: {
    fromWeekStart: string;
    fromDayOfWeek: number;
    toWeekStart: string;
    toDayOfWeek: number;
    router: ReturnType<typeof useRouter>;
  }) {
    if (bulkBusy) return;
    setBulkBusy(true);
    const result = await copyDay({
      fromWeekStart: args.fromWeekStart,
      fromDayOfWeek: args.fromDayOfWeek,
      toWeekStart: args.toWeekStart,
      toDayOfWeek: args.toDayOfWeek,
    });
    setBulkBusy(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    if (result.copied === 0) {
      toast.info("No shifts on that day — nothing to copy.");
    } else {
      const targetLabel = DAY_NAMES[args.toDayOfWeek];
      toast.success(
        `Copied ${result.copied} shift${result.copied === 1 ? "" : "s"} into ${targetLabel}`,
      );
    }
    args.router.refresh();
  }

  async function handleCopyWeekToNext(args: {
    weekStart: Date;
    router: ReturnType<typeof useRouter>;
  }) {
    if (bulkBusy) return;
    const next = shiftWeek(args.weekStart, 1);
    setBulkBusy(true);
    const result = await copyWeek({
      fromWeekStart: args.weekStart.toISOString(),
      toWeekStart: next.toISOString(),
    });
    setBulkBusy(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    if (result.copied === 0) {
      toast.info("No shifts in this week — nothing to copy.");
    } else {
      toast.success(
        `Copied ${result.copied} shift${result.copied === 1 ? "" : "s"} to ${formatWeekRange(next)}`,
      );
    }
    args.router.refresh();
  }

  return (
    <div className="space-y-6">
      {/* Toolbar — global navigator, applies to the whole stack. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => goWeeks(-1)}
            aria-label="Shift range one week earlier"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div className="flex flex-col px-1 text-left">
            <span className="text-sm font-semibold">
              Showing {weekStartsIso.length} week
              {weekStartsIso.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              onClick={() => router.push(`/shifts?week=${currentWeekParam}`)}
              className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              disabled={weekStartsIso[0] === currentWeekStartIso}
            >
              {weekStartsIso[0] === currentWeekStartIso
                ? "Starts with the current week"
                : "Jump to this week"}
            </button>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => goWeeks(1)}
            aria-label="Shift range one week later"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
          <Clock className="size-3.5" />
          Your timezone:{" "}
          <span className="font-medium text-foreground">
            {timezoneLabel(tz)}
          </span>
        </div>
      </div>

      {/* Stacked week boards. */}
      <div className="space-y-6">
        {weekStartsIso.map((iso) => {
          const ws = new Date(iso);
          const isCurrent = iso === currentWeekStartIso;
          const grid = shiftsByWeek.get(iso) ?? new Map<string, Shift>();
          return (
            <WeekBoard
              key={iso}
              weekStart={ws}
              isCurrent={isCurrent}
              grid={grid}
              workersById={workersById}
              onCellClick={(day, slot, shift) =>
                setEditing({
                  weekStart: ws,
                  dayOfWeek: day,
                  shiftSlot: slot,
                  shift,
                })
              }
              onCopyInto={() => setCopyTarget(ws)}
              onCopyDay={(targetDay) => {
                // Source = the day immediately preceding `targetDay`. If
                // targetDay is Monday (0), source is the previous week's
                // Sunday — keeps "yesterday" intuitive on week boundaries.
                const sourceWeek = targetDay === 0 ? shiftWeek(ws, -1) : ws;
                const sourceDay = targetDay === 0 ? 6 : targetDay - 1;
                handleCopyDay({
                  fromWeekStart: sourceWeek.toISOString(),
                  fromDayOfWeek: sourceDay,
                  toWeekStart: ws.toISOString(),
                  toDayOfWeek: targetDay,
                  router,
                });
              }}
              onCopyToNextWeek={() => {
                handleCopyWeekToNext({ weekStart: ws, router });
              }}
            />
          );
        })}
      </div>

      {/* Edit dialog */}
      {editing && (
        <ShiftEditDialog
          open={editing !== null}
          onClose={() => setEditing(null)}
          weekStart={editing.weekStart}
          dayOfWeek={editing.dayOfWeek}
          shiftSlot={editing.shiftSlot}
          existing={editing.shift}
          workers={workers}
        />
      )}

      {/* Copy-week dialog (per target week) */}
      {copyTarget && (
        <CopyWeekDialog
          open={copyTarget !== null}
          onClose={() => setCopyTarget(null)}
          targetWeekStart={copyTarget}
        />
      )}
    </div>
  );
}

// ─── One week ────────────────────────────────────────────────────

function WeekBoard({
  weekStart,
  isCurrent,
  grid,
  workersById,
  onCellClick,
  onCopyInto,
  onCopyDay,
  onCopyToNextWeek,
}: {
  weekStart: Date;
  isCurrent: boolean;
  grid: Map<string, Shift>;
  workersById: Map<string, Worker>;
  onCellClick: (day: number, slot: number, shift: Shift | null) => void;
  onCopyInto: () => void;
  onCopyDay: (targetDay: number) => void;
  onCopyToNextWeek: () => void;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border bg-card shadow-sm overflow-hidden",
        isCurrent && "ring-1 ring-primary/30",
      )}
    >
      {/* Prominent week header — the "top-left week/date label" the user
          asked to make bigger. Rendered above each grid, not inside it,
          so it reads as a section title. */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 px-5 py-4">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex size-10 items-center justify-center rounded-xl",
              isCurrent
                ? "bg-primary/15 text-primary"
                : "bg-muted text-muted-foreground",
            )}
          >
            <CalendarDays className="size-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold leading-tight">
              {formatWeekRange(weekStart)}
            </h2>
            <p className="text-xs text-muted-foreground">
              {isCurrent ? (
                <span className="font-medium text-primary">Current week</span>
              ) : (
                <>Week of {DAY_NAMES[0]}</>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCopyInto}
          >
            <Copy className="size-4" />
            Copy from…
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCopyToNextWeek}
            title="Copy this entire week's shifts into next week"
          >
            <ArrowRight className="size-4" />
            Copy → next week
          </Button>
        </div>
      </header>

      {/* Day header row */}
      <div className="grid grid-cols-[96px_repeat(7,1fr)] border-b bg-muted/20">
        <div className="p-3" />
        {DAY_SHORT.map((d, i) => (
          <DayHeader
            key={d}
            short={d}
            full={DAY_NAMES[i]}
            weekStart={weekStart}
            day={i}
            onCopyFromYesterday={() => onCopyDay(i)}
          />
        ))}
      </div>

      {/* Body — 3 slot rows */}
      {Array.from({ length: SHIFTS_PER_DAY }).map((_, slot) => (
        <div
          key={slot}
          className="grid grid-cols-[96px_repeat(7,1fr)] border-b last:border-b-0"
        >
          <div className="flex items-center justify-center border-r bg-muted/10 p-2 text-xs font-semibold text-muted-foreground">
            {SLOT_LABELS[slot]}
          </div>
          {Array.from({ length: 7 }).map((_, day) => {
            const shift = grid.get(`${day}|${slot}`) ?? null;
            return (
              <ShiftCell
                key={day}
                shift={shift}
                workersById={workersById}
                onClick={() => onCellClick(day, slot, shift)}
              />
            );
          })}
        </div>
      ))}
    </section>
  );
}

function DayHeader({
  short,
  full,
  weekStart,
  day,
  onCopyFromYesterday,
}: {
  short: string;
  full: string;
  weekStart: Date;
  day: number;
  onCopyFromYesterday: () => void;
}) {
  const dayDate = React.useMemo(() => {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + day);
    return d;
  }, [weekStart, day]);
  const dayNumFormatter = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    timeZone: "UTC",
  });
  // For Monday, "yesterday" is the previous week's Sunday — surface
  // that in the tooltip so the action isn't surprising on week edges.
  const yesterdayLabel =
    day === 0 ? "previous week's Sunday" : DAY_NAMES[day - 1];
  return (
    <div className="group flex items-start justify-between gap-1 border-l p-3">
      <div className="flex flex-col items-start gap-0.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {short}
        </span>
        <span className="text-sm font-bold tabular-nums" title={full}>
          {dayNumFormatter.format(dayDate)}
        </span>
      </div>
      <button
        type="button"
        onClick={onCopyFromYesterday}
        title={`Copy shifts from ${yesterdayLabel} into ${full}`}
        aria-label={`Copy shifts from ${yesterdayLabel} into ${full}`}
        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
      >
        <ArrowDownLeft className="size-3.5" />
      </button>
    </div>
  );
}

// ─── Shift cell ──────────────────────────────────────────────────

function ShiftCell({
  shift,
  workersById,
  onClick,
}: {
  shift: Shift | null;
  workersById: Map<string, Worker>;
  onClick: () => void;
}) {
  const tz = useTimezone();

  if (!shift) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="group flex min-h-[88px] w-full items-center justify-center border-l bg-card text-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="inline-flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Plus className="size-3" />
          Add
        </span>
      </button>
    );
  }

  const startHHmm = toZonedHhMm(shift.startAt, tz);
  const endHHmm = toZonedHhMm(shift.endAt, tz);
  const assignedWorkers = shift.assignedIds
    .map((id) => workersById.get(id))
    .filter((w): w is Worker => w != null);
  const extraCount = shift.assignedIds.length - assignedWorkers.length;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[88px] w-full flex-col items-start gap-2 border-l bg-card p-2 text-left transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-1 text-xs font-semibold tabular-nums">
        <Clock className="size-3 text-muted-foreground" />
        <span>{startHHmm}</span>
        <span className="text-muted-foreground">–</span>
        <span>{endHHmm}</span>
      </div>
      {assignedWorkers.length === 0 ? (
        <span className="text-[11px] text-muted-foreground">Unassigned</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {assignedWorkers.slice(0, 3).map((w) => (
            <Badge
              key={w.id}
              variant="outline"
              className={cn(
                "text-[10px] font-medium leading-none px-1.5 py-0.5",
                ROLE_COLORS[w.role] ?? "",
              )}
            >
              {w.displayUsername ?? w.username}
            </Badge>
          ))}
          {assignedWorkers.length > 3 && (
            <Badge
              variant="outline"
              className="text-[10px] font-medium leading-none px-1.5 py-0.5"
            >
              +{assignedWorkers.length - 3}
            </Badge>
          )}
          {extraCount > 0 && (
            <Badge
              variant="outline"
              className="text-[10px] font-medium leading-none px-1.5 py-0.5 text-muted-foreground"
              title="Assigned users no longer in the active admins list"
            >
              +{extraCount} ex
            </Badge>
          )}
        </div>
      )}
      {shift.notes && (
        <p className="line-clamp-1 text-[10px] text-muted-foreground/80">
          {shift.notes}
        </p>
      )}
    </button>
  );
}

// ─── Edit dialog ─────────────────────────────────────────────────

// Default templates for "Add" on an empty slot — in the admin's local
// zone. Admin can edit freely; these just give the picker sensible
// starting values.
const DEFAULT_TIMES: [string, string][] = [
  ["06:00", "14:00"], // slot 0 (morning)
  ["14:00", "22:00"], // slot 1 (afternoon)
  ["22:00", "06:00"], // slot 2 (night — crosses midnight)
];

function ShiftEditDialog({
  open,
  onClose,
  weekStart,
  dayOfWeek,
  shiftSlot,
  existing,
  workers,
}: {
  open: boolean;
  onClose: () => void;
  weekStart: Date;
  dayOfWeek: number;
  shiftSlot: number;
  existing: Shift | null;
  workers: Worker[];
}) {
  const router = useRouter();
  const tz = useTimezone();

  const [startHHmm, setStartHHmm] = React.useState("");
  const [endHHmm, setEndHHmm] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [assigned, setAssigned] = React.useState<Set<string>>(new Set());
  const [saving, setSaving] = React.useState(false);
  const [showDelete, setShowDelete] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    if (existing) {
      setStartHHmm(toZonedHhMm(existing.startAt, tz));
      setEndHHmm(toZonedHhMm(existing.endAt, tz));
      setNotes(existing.notes ?? "");
      setAssigned(new Set(existing.assignedIds));
    } else {
      const [dStart, dEnd] = DEFAULT_TIMES[shiftSlot] ?? ["09:00", "17:00"];
      setStartHHmm(dStart);
      setEndHHmm(dEnd);
      setNotes("");
      setAssigned(new Set());
    }
  }, [open, existing, shiftSlot, tz]);

  function toggle(id: string) {
    setAssigned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!startHHmm || !endHHmm) {
      toast.error("Start and end time required");
      return;
    }
    // Admin enters hh:mm in THEIR local timezone. Convert to UTC for
    // storage. Every other viewer then translates the UTC instant to
    // their own zone on render.
    const start = localHhMmToUtc(weekStart, dayOfWeek, startHHmm, tz);
    const end = localHhMmToUtc(weekStart, dayOfWeek, endHHmm, tz);
    if (end <= start) {
      // Night shift crossing midnight — roll end to the next day.
      end.setUTCDate(end.getUTCDate() + 1);
    }

    setSaving(true);
    const result = await upsertShift({
      weekStart: weekStart.toISOString(),
      dayOfWeek,
      shiftSlot,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      notes: notes.trim() ? notes.trim() : null,
      assignedIds: [...assigned],
    });
    setSaving(false);

    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success(existing ? "Shift updated" : "Shift created");
    onClose();
    router.refresh();
  }

  async function doDelete() {
    if (!existing) return;
    setSaving(true);
    const result = await deleteShift(existing.id);
    setSaving(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("Shift deleted");
    setShowDelete(false);
    onClose();
    router.refresh();
  }

  return (
    <>
      <Dialog
        open={open && !showDelete}
        onOpenChange={(v) => {
          if (!v) onClose();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calendar className="size-4 text-primary" />
              {DAY_NAMES[dayOfWeek]} · {SLOT_LABELS[shiftSlot]}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Times — always in the admin's own timezone. */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="shift-start" className="text-xs font-medium">
                  Start
                </Label>
                <Input
                  id="shift-start"
                  type="time"
                  value={startHHmm}
                  onChange={(e) => setStartHHmm(e.target.value)}
                  step={300}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="shift-end" className="text-xs font-medium">
                  End
                </Label>
                <Input
                  id="shift-end"
                  type="time"
                  value={endHHmm}
                  onChange={(e) => setEndHHmm(e.target.value)}
                  step={300}
                />
              </div>
            </div>
            <p className="-mt-2 text-[11px] text-muted-foreground">
              Times are entered in{" "}
              <span className="font-medium text-foreground">
                {timezoneLabel(tz)}
              </span>{" "}
              and stored as absolute UTC instants, so every viewer sees
              them translated into their own zone. If end is earlier than
              or equal to start, the shift automatically rolls over to
              the next day (night shifts).
            </p>

            {/* Workers */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                <Users className="mr-1 inline size-3.5" />
                Assigned workers
              </Label>
              <WorkerPicker
                workers={workers}
                selected={assigned}
                onToggle={toggle}
              />
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <Label htmlFor="shift-notes" className="text-xs font-medium">
                Notes
                <span className="ml-1 font-normal text-muted-foreground/60">
                  (optional)
                </span>
              </Label>
              <Textarea
                id="shift-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="On-call for card withdrawals, sponsored tourney, etc."
                rows={3}
                maxLength={500}
              />
            </div>
          </div>

          <DialogFooter className="!items-center !justify-between">
            {existing ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowDelete(true)}
                className="text-rose-500 hover:bg-rose-500/10 hover:text-rose-500"
                disabled={saving}
              >
                <Trash2 className="size-4" />
                Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="button" onClick={submit} disabled={saving}>
                {saving
                  ? "Saving…"
                  : existing
                    ? "Save changes"
                    : "Create shift"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this shift?</AlertDialogTitle>
            <AlertDialogDescription>
              {existing
                ? `${DAY_NAMES[existing.dayOfWeek]} · ${SLOT_LABELS[existing.shiftSlot]} will be removed.`
                : "This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={doDelete}
              disabled={saving}
              className="bg-rose-500 text-white hover:bg-rose-500/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Worker multi-select ─────────────────────────────────────────

function WorkerPicker({
  workers,
  selected,
  onToggle,
}: {
  workers: Worker[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workers;
    return workers.filter((w) => {
      const label = (w.displayUsername ?? w.username).toLowerCase();
      return label.includes(q) || w.role.includes(q);
    });
  }, [workers, query]);

  return (
    <div className="space-y-2 rounded-lg border border-border bg-background/50 p-2">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search admins…"
        className="h-7 text-xs"
      />
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {filtered.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            No admins match the search.
          </p>
        )}
        {filtered.map((w) => {
          const isSelected = selected.has(w.id);
          const label = w.displayUsername ?? w.username;
          return (
            <button
              key={w.id}
              type="button"
              onClick={() => onToggle(w.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
                isSelected
                  ? "border-primary/50 bg-primary/10"
                  : "border-transparent hover:border-border hover:bg-accent/40",
              )}
            >
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-sm border",
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background",
                )}
                aria-hidden
              >
                {isSelected && <Check className="size-3" />}
              </span>
              <span className="flex-1 truncate font-medium">{label}</span>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] font-medium leading-none px-1.5 py-0.5",
                  ROLE_COLORS[w.role] ?? "",
                )}
              >
                {w.role}
              </Badge>
            </button>
          );
        })}
      </div>
      {selected.size > 0 && (
        <div className="flex flex-wrap gap-1 border-t border-border/60 pt-2">
          {[...selected]
            .map((id) => workers.find((w) => w.id === id))
            .filter((w): w is Worker => w != null)
            .map((w) => (
              <Badge
                key={w.id}
                variant="outline"
                className={cn(
                  "flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5",
                  ROLE_COLORS[w.role] ?? "",
                )}
              >
                {w.displayUsername ?? w.username}
                <button
                  type="button"
                  onClick={() => onToggle(w.id)}
                  aria-label={`Remove ${w.username}`}
                  className="hover:text-foreground"
                >
                  <X className="size-2.5" />
                </button>
              </Badge>
            ))}
        </div>
      )}
    </div>
  );
}

// ─── Copy week dialog ────────────────────────────────────────────

function CopyWeekDialog({
  open,
  onClose,
  targetWeekStart,
}: {
  open: boolean;
  onClose: () => void;
  targetWeekStart: Date;
}) {
  const router = useRouter();
  const [fromParam, setFromParam] = React.useState(() =>
    weekStartToParam(shiftWeek(targetWeekStart, -1)),
  );
  const [copying, setCopying] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setFromParam(weekStartToParam(shiftWeek(targetWeekStart, -1)));
    }
  }, [open, targetWeekStart]);

  async function submit() {
    const fromWeek = parseWeekStartParam(fromParam);
    setCopying(true);
    const result = await copyWeek({
      fromWeekStart: fromWeek.toISOString(),
      toWeekStart: targetWeekStart.toISOString(),
    });
    setCopying(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    if (result.copied === 0) {
      toast.info("No shifts found in that week — nothing to copy.");
    } else {
      toast.success(
        `Copied ${result.copied} shift${result.copied === 1 ? "" : "s"}`,
      );
    }
    onClose();
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Copy week into {formatWeekRange(targetWeekStart)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-xs text-muted-foreground">
            Clone every shift (times + workers) from the source week into
            this one. Existing shifts in overlapping slots are overwritten.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="copy-from" className="text-xs font-medium">
              Source week (Monday)
            </Label>
            <Input
              id="copy-from"
              type="date"
              value={fromParam}
              onChange={(e) => setFromParam(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={copying}
          >
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={copying}>
            {copying ? "Copying…" : "Copy shifts"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
