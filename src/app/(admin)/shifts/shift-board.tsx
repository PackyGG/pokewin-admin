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
import { copyWeek, deleteShift, upsertShift } from "./actions";
import {
  combineUtcInstant,
  DAY_NAMES,
  DAY_SHORT,
  formatWeekRange,
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
  weekStartIso,
  currentWeekStartIso,
  currentWeekParam,
  shifts,
  workers,
}: {
  weekStartIso: string;
  currentWeekStartIso: string;
  currentWeekParam: string;
  shifts: Shift[];
  workers: Worker[];
}) {
  const router = useRouter();
  const weekStart = React.useMemo(() => new Date(weekStartIso), [weekStartIso]);
  const isCurrentWeek = weekStartIso === currentWeekStartIso;

  // Index by (day, slot) for O(1) cell lookup.
  const grid = React.useMemo(() => {
    const map = new Map<string, Shift>();
    for (const s of shifts) {
      map.set(`${s.dayOfWeek}|${s.shiftSlot}`, s);
    }
    return map;
  }, [shifts]);

  const workersById = React.useMemo(() => {
    const m = new Map<string, Worker>();
    for (const w of workers) m.set(w.id, w);
    return m;
  }, [workers]);

  const [editing, setEditing] = React.useState<{
    dayOfWeek: number;
    shiftSlot: number;
    shift: Shift | null;
  } | null>(null);

  const [copyOpen, setCopyOpen] = React.useState(false);

  function go(weeksDelta: number) {
    const target = shiftWeek(weekStart, weeksDelta);
    router.push(`/shifts?week=${weekStartToParam(target)}`);
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => go(-1)}
            aria-label="Previous week"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div className="flex flex-col items-center px-2">
            <span className="text-sm font-semibold">
              {formatWeekRange(weekStart)}
            </span>
            {!isCurrentWeek && (
              <button
                type="button"
                onClick={() =>
                  router.push(`/shifts?week=${currentWeekParam}`)
                }
                className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Jump to this week
              </button>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => go(1)}
            aria-label="Next week"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCopyOpen(true)}
          >
            <Copy className="size-4" />
            Copy from another week
          </Button>
        </div>
      </div>

      {/* Grid */}
      <div className="rounded-2xl border overflow-hidden">
        {/* Header row — day names */}
        <div className="grid grid-cols-[90px_repeat(7,1fr)] border-b bg-muted/40">
          <div className="p-3" />
          {DAY_SHORT.map((d, i) => (
            <DayHeader key={d} short={d} full={DAY_NAMES[i]} weekStart={weekStart} day={i} />
          ))}
        </div>

        {/* Body rows — one per slot */}
        {Array.from({ length: SHIFTS_PER_DAY }).map((_, slot) => (
          <div
            key={slot}
            className="grid grid-cols-[90px_repeat(7,1fr)] border-b last:border-b-0"
          >
            <div className="flex items-center justify-center border-r bg-muted/20 p-2 text-xs font-semibold text-muted-foreground">
              {SLOT_LABELS[slot]}
            </div>
            {Array.from({ length: 7 }).map((_, day) => {
              const shift = grid.get(`${day}|${slot}`) ?? null;
              return (
                <ShiftCell
                  key={day}
                  shift={shift}
                  workersById={workersById}
                  onClick={() =>
                    setEditing({
                      dayOfWeek: day,
                      shiftSlot: slot,
                      shift,
                    })
                  }
                />
              );
            })}
          </div>
        ))}
      </div>

      {/* Legend */}
      <p className="text-xs text-muted-foreground">
        Click any cell to edit or assign workers. Times are displayed in
        your preference timezone — the underlying instant is UTC so every
        viewer sees the same moment translated locally.
      </p>

      {/* Edit dialog */}
      {editing && (
        <ShiftEditDialog
          open={editing !== null}
          onClose={() => setEditing(null)}
          weekStart={weekStart}
          dayOfWeek={editing.dayOfWeek}
          shiftSlot={editing.shiftSlot}
          existing={editing.shift}
          workers={workers}
        />
      )}

      <CopyWeekDialog
        open={copyOpen}
        onClose={() => setCopyOpen(false)}
        currentWeekStart={weekStart}
      />
    </div>
  );
}

function DayHeader({
  short,
  full,
  weekStart,
  day,
}: {
  short: string;
  full: string;
  weekStart: Date;
  day: number;
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
  return (
    <div className="flex flex-col items-start gap-0.5 border-l p-3">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {short}
      </span>
      <span className="text-sm font-bold tabular-nums" title={full}>
        {dayNumFormatter.format(dayDate)}
      </span>
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

// Default time templates for "Add" on an empty slot — just so the
// inputs have a sensible starting value. Admin picks the real times.
const DEFAULT_TIMES: [string, string][] = [
  ["06:00", "14:00"], // slot 0 (morning)
  ["14:00", "22:00"], // slot 1 (afternoon)
  ["22:00", "06:00"], // slot 2 (night — crosses midnight; end is next day)
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

  // Initial form state derived from the existing shift or the default
  // template for this slot.
  const [startHHmm, setStartHHmm] = React.useState("");
  const [endHHmm, setEndHHmm] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [assigned, setAssigned] = React.useState<Set<string>>(new Set());
  const [saving, setSaving] = React.useState(false);
  const [showDelete, setShowDelete] = React.useState(false);

  // Snap form state to the open shift whenever the dialog opens.
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
    // Convert HH:mm (in UTC as our convention) back to instants.
    // We intentionally treat the picker input as UTC-native so the
    // stored instant is stable across admins in different zones. The
    // viewer's preference timezone is only for DISPLAY.
    const start = combineUtcInstant(weekStart, dayOfWeek, startHHmm);
    const end = combineUtcInstant(weekStart, dayOfWeek, endHHmm);
    // If the slot crosses midnight (end <= start), shift end by 24h so
    // night shifts end on the next day.
    if (end <= start) {
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
            {/* Times */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="shift-start" className="text-xs font-medium">
                  Start (UTC)
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
                  End (UTC)
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
              Times are stored in UTC and shown in every admin&apos;s own
              timezone. If end &lt;= start, the shift automatically rolls
              over to the next day (night shifts).
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
  currentWeekStart,
}: {
  open: boolean;
  onClose: () => void;
  currentWeekStart: Date;
}) {
  const router = useRouter();
  const [fromParam, setFromParam] = React.useState(() =>
    weekStartToParam(shiftWeek(currentWeekStart, -1)),
  );
  const [copying, setCopying] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      // Default to "previous week" whenever the dialog opens.
      setFromParam(weekStartToParam(shiftWeek(currentWeekStart, -1)));
    }
  }, [open, currentWeekStart]);

  async function submit() {
    const fromWeek = parseWeekStartParam(fromParam);
    setCopying(true);
    const result = await copyWeek({
      fromWeekStart: fromWeek.toISOString(),
      toWeekStart: currentWeekStart.toISOString(),
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
          <DialogTitle>Copy week</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-xs text-muted-foreground">
            Clone every shift (times + workers) from the source week into
            the currently open week. Existing shifts in overlapping slots
            are overwritten.
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
          <p className="text-xs text-muted-foreground">
            Target:{" "}
            <span className="font-medium text-foreground">
              {formatWeekRange(currentWeekStart)}
            </span>
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={copying}>
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
