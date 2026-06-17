"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarPlus, ChevronLeft, ChevronRight } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FeatureDialog } from "./feature-dialog";
import { moveRoadmapItem } from "./actions";
import {
  ROADMAP_STATUS_META,
  type RoadmapColor,
  type RoadmapItemSummary,
} from "./types";

// ── Pure date helpers (all in UTC to avoid timezone drift) ──────────

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function toYmd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

// Monday-first weekday index (0 = Mon … 6 = Sun) — matches the shifts planner.
function mondayIndex(d: Date): number {
  const wd = d.getUTCDay();
  return wd === 0 ? 6 : wd - 1;
}

// ── Block color tokens ──────────────────────────────────────────────

const COLOR_BLOCK: Record<RoadmapColor, string> = {
  blue: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40 hover:bg-blue-500/25",
  emerald:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/25",
  rose: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/40 hover:bg-rose-500/25",
  cyan: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border-cyan-500/40 hover:bg-cyan-500/25",
  amber:
    "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40 hover:bg-amber-500/25",
  purple:
    "bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/40 hover:bg-purple-500/25",
  orange:
    "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/40 hover:bg-orange-500/25",
  pink: "bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-500/40 hover:bg-pink-500/25",
};

const DEFAULT_BLOCK =
  "bg-primary/15 text-foreground border-primary/40 hover:bg-primary/25";

function blockClass(color: RoadmapColor | null): string {
  return color ? COLOR_BLOCK[color] : DEFAULT_BLOCK;
}

// ── Layout constants for the week-row overlay ───────────────────────

const HEADER_OFFSET = 28; // px reserved at the top of a cell for the day number
const BAR_H = 22; // px per feature bar
const BAR_GAP = 4; // px between stacked bars
const MIN_ROW_H = 96; // px minimum week-row height

// A pre-parsed item with UTC start/end Dates for cheap range math.
type ParsedItem = RoadmapItemSummary & { start: Date; end: Date };

// One week-clipped slice of an item, positioned within a 7-col week row.
type Segment = {
  item: ParsedItem;
  colStart: number; // 0..6
  colEnd: number; // 0..6
  span: number;
  segStartYmd: string;
  continuesLeft: boolean;
  continuesRight: boolean;
};

// ── Main component ──────────────────────────────────────────────────

export function RoadmapCalendar({
  items: initialItems,
}: {
  items: RoadmapItemSummary[];
}) {
  const router = useRouter();

  // Local copy so drag-to-reschedule can update optimistically.
  const [items, setItems] = React.useState(initialItems);
  React.useEffect(() => setItems(initialItems), [initialItems]);

  // Month cursor (UTC). Defaults to the month containing "today".
  const today = React.useMemo(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }, []);
  const [cursor, setCursor] = React.useState(() => ({
    year: today.getUTCFullYear(),
    month: today.getUTCMonth(),
  }));

  const [dialog, setDialog] = React.useState<
    | { mode: "create"; start: string; end: string }
    | { mode: "edit"; item: RoadmapItemSummary }
    | null
  >(null);

  const [activeSegment, setActiveSegment] = React.useState<Segment | null>(null);
  // Set on drag start, cleared shortly after drag end — suppresses the
  // click that would otherwise fire on the dragged bar / dropped cell.
  const justDragged = React.useRef(false);

  // Only scheduled items (both dates set) appear on the calendar; backlog
  // ideas live in the section above it.
  const parsedItems = React.useMemo<ParsedItem[]>(
    () =>
      items
        .filter(
          (it): it is RoadmapItemSummary & { startDate: string; endDate: string } =>
            !!it.startDate && !!it.endDate,
        )
        .map((it) => ({
          ...it,
          start: parseYmd(it.startDate.slice(0, 10)),
          end: parseYmd(it.endDate.slice(0, 10)),
        })),
    [items],
  );

  const weeks = React.useMemo(() => buildWeeks(cursor.year, cursor.month), [
    cursor.year,
    cursor.month,
  ]);

  const monthLabel = React.useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(Date.UTC(cursor.year, cursor.month, 1))),
    [cursor.year, cursor.month],
  );

  const todayYmd = toYmd(today);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  function goMonth(delta: number) {
    setCursor((c) => {
      const d = new Date(Date.UTC(c.year, c.month + delta, 1));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
    });
  }

  function goToday() {
    setCursor({ year: today.getUTCFullYear(), month: today.getUTCMonth() });
  }

  function handleDragStart(event: DragStartEvent) {
    justDragged.current = true;
    const seg = event.active.data.current?.segment as Segment | undefined;
    setActiveSegment(seg ?? null);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const seg = event.active.data.current?.segment as Segment | undefined;
    setActiveSegment(null);
    // Keep the click guard alive briefly past the synthetic click.
    window.setTimeout(() => {
      justDragged.current = false;
    }, 80);

    const overId = event.over?.id;
    if (!seg || overId == null) return;
    const dropYmd = String(overId);
    const delta = diffDays(parseYmd(dropYmd), parseYmd(seg.segStartYmd));
    if (delta === 0) return;

    const target = items.find((i) => i.id === seg.item.id);
    if (!target || !target.startDate || !target.endDate) return;

    const newStart = addDays(parseYmd(target.startDate.slice(0, 10)), delta);
    const newEnd = addDays(parseYmd(target.endDate.slice(0, 10)), delta);
    const newStartIso = newStart.toISOString();
    const newEndIso = newEnd.toISOString();

    const prev = items;
    setItems((curr) =>
      curr.map((i) =>
        i.id === target.id
          ? { ...i, startDate: newStartIso, endDate: newEndIso }
          : i,
      ),
    );

    try {
      const r = await moveRoadmapItem({
        id: target.id,
        startDate: toYmd(newStart),
        endDate: toYmd(newEnd),
      });
      if (!r.success) {
        setItems(prev);
        toast.error(r.error);
        return;
      }
      router.refresh();
    } catch (e) {
      setItems(prev);
      toast.error(e instanceof Error ? e.message : "Failed to reschedule");
    }
  }

  function openCreate(ymd: string) {
    if (justDragged.current) return;
    setDialog({ mode: "create", start: ymd, end: ymd });
  }

  function openItem(id: string) {
    if (justDragged.current) return;
    router.push(`/roadmap/${id}`);
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
            onClick={() => goMonth(-1)}
            aria-label="Previous month"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div className="min-w-[9rem] px-1 text-center text-sm font-semibold tabular-nums">
            {monthLabel}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => goMonth(1)}
            aria-label="Next month"
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={goToday}>
            Today
          </Button>
        </div>

        <Button
          type="button"
          size="sm"
          onClick={() => {
            const ymd = toYmd(today);
            setDialog({ mode: "create", start: ymd, end: ymd });
          }}
        >
          <CalendarPlus className="size-4" />
          New feature
        </Button>
      </div>

      {/* Calendar grid */}
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveSegment(null)}
      >
        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          {/* Weekday header */}
          <div className="grid grid-cols-7 border-b bg-muted/30">
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="p-2 text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Week rows */}
          {weeks.map((days) => (
            <WeekRow
              key={toYmd(days[0])}
              days={days}
              items={parsedItems}
              currentMonth={cursor.month}
              todayYmd={todayYmd}
              onDayClick={openCreate}
              onItemClick={openItem}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeSegment && (
            <div
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2 text-xs font-medium shadow-lg",
                blockClass(activeSegment.item.color),
              )}
              style={{ height: BAR_H }}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  ROADMAP_STATUS_META[activeSegment.item.status].dot,
                )}
              />
              <span className="truncate">{activeSegment.item.title}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {dialog && (
        <FeatureDialog
          open
          onOpenChange={(v) => {
            if (!v) setDialog(null);
          }}
          mode={dialog.mode}
          item={dialog.mode === "edit" ? dialog.item : null}
          defaultStartDate={dialog.mode === "create" ? dialog.start : undefined}
          defaultEndDate={dialog.mode === "create" ? dialog.end : undefined}
        />
      )}
    </div>
  );
}

// ── Week row ────────────────────────────────────────────────────────

function WeekRow({
  days,
  items,
  currentMonth,
  todayYmd,
  onDayClick,
  onItemClick,
}: {
  days: Date[];
  items: ParsedItem[];
  currentMonth: number;
  todayYmd: string;
  onDayClick: (ymd: string) => void;
  onItemClick: (id: string) => void;
}) {
  const weekStart = days[0];
  const weekEnd = days[6];

  const lanes = React.useMemo(() => {
    const segments: Segment[] = [];
    for (const item of items) {
      if (item.end < weekStart || item.start > weekEnd) continue;
      const segStart = item.start < weekStart ? weekStart : item.start;
      const segEnd = item.end > weekEnd ? weekEnd : item.end;
      const colStart = diffDays(segStart, weekStart);
      const colEnd = diffDays(segEnd, weekStart);
      segments.push({
        item,
        colStart,
        colEnd,
        span: colEnd - colStart + 1,
        segStartYmd: toYmd(segStart),
        continuesLeft: item.start < weekStart,
        continuesRight: item.end > weekEnd,
      });
    }
    return assignLanes(segments);
  }, [items, weekStart, weekEnd]);

  const rowHeight = Math.max(
    MIN_ROW_H,
    HEADER_OFFSET + lanes.length * (BAR_H + BAR_GAP) + BAR_GAP,
  );

  return (
    <div
      className="relative border-b last:border-b-0"
      style={{ minHeight: rowHeight }}
    >
      {/* Background day cells */}
      <div className="absolute inset-0 grid grid-cols-7">
        {days.map((day) => (
          <DayCell
            key={toYmd(day)}
            day={day}
            inMonth={day.getUTCMonth() === currentMonth}
            isToday={toYmd(day) === todayYmd}
            onClick={() => onDayClick(toYmd(day))}
          />
        ))}
      </div>

      {/* Feature bars overlay */}
      <div
        className="pointer-events-none absolute inset-x-0"
        style={{ top: HEADER_OFFSET }}
      >
        {lanes.map((lane, laneIdx) => (
          <div
            key={laneIdx}
            className="grid grid-cols-7"
            style={{ height: BAR_H, marginBottom: BAR_GAP }}
          >
            {lane.map((seg) => (
              <FeatureBar
                key={`${seg.item.id}-${seg.segStartYmd}`}
                segment={seg}
                onClick={() => onItemClick(seg.item.id)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Day cell (droppable) ────────────────────────────────────────────

function DayCell({
  day,
  inMonth,
  isToday,
  onClick,
}: {
  day: Date;
  inMonth: boolean;
  isToday: boolean;
  onClick: () => void;
}) {
  const ymd = toYmd(day);
  const { setNodeRef, isOver } = useDroppable({ id: ymd, data: { ymd } });
  const dayNum = day.getUTCDate();

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onClick}
      aria-label={`Add feature on ${ymd}`}
      className={cn(
        "group h-full border-l text-left transition-colors first:border-l-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        inMonth ? "bg-card hover:bg-accent/30" : "bg-muted/20 hover:bg-accent/20",
        isOver && "bg-primary/10",
      )}
    >
      <div className="flex items-start justify-end p-1.5">
        <span
          className={cn(
            "flex size-5 items-center justify-center rounded-full text-xs tabular-nums",
            isToday
              ? "bg-primary font-semibold text-primary-foreground"
              : inMonth
                ? "font-medium text-foreground"
                : "text-muted-foreground/60",
          )}
        >
          {dayNum}
        </span>
      </div>
    </button>
  );
}

// ── Feature bar (draggable) ─────────────────────────────────────────

function FeatureBar({
  segment,
  onClick,
}: {
  segment: Segment;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${segment.item.id}-${segment.segStartYmd}`,
    data: { segment },
  });

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onClick}
      title={segment.item.title}
      className={cn(
        "pointer-events-auto mx-0.5 flex min-w-0 items-center gap-1.5 border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        blockClass(segment.item.color),
        segment.continuesLeft ? "rounded-l-none border-l-0" : "rounded-l-md",
        segment.continuesRight ? "rounded-r-none border-r-0" : "rounded-r-md",
        isDragging && "opacity-40",
      )}
      style={{
        gridColumn: `${segment.colStart + 1} / span ${segment.span}`,
        height: BAR_H,
      }}
      {...listeners}
      {...attributes}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          ROADMAP_STATUS_META[segment.item.status].dot,
        )}
      />
      <span className="truncate">{segment.item.title}</span>
    </button>
  );
}

// ── Pure layout helpers ─────────────────────────────────────────────

// Build the Monday-first month grid: full weeks covering the month.
function buildWeeks(year: number, month: number): Date[][] {
  const first = new Date(Date.UTC(year, month, 1));
  const gridStart = addDays(first, -mondayIndex(first));
  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0));
  const gridEnd = addDays(lastOfMonth, 6 - mondayIndex(lastOfMonth));
  const totalDays = diffDays(gridEnd, gridStart) + 1;
  const weekCount = totalDays / 7;

  const weeks: Date[][] = [];
  for (let w = 0; w < weekCount; w++) {
    const days: Date[] = [];
    for (let i = 0; i < 7; i++) days.push(addDays(gridStart, w * 7 + i));
    weeks.push(days);
  }
  return weeks;
}

// Greedy lane packing — segments are kept non-overlapping within a lane.
// Sorting by colStart (then by longer span) keeps the "last in lane" check
// sufficient, since lanes are filled left-to-right.
function assignLanes(segments: Segment[]): Segment[][] {
  const sorted = [...segments].sort(
    (a, b) => a.colStart - b.colStart || b.span - a.span,
  );
  const lanes: Segment[][] = [];
  for (const seg of sorted) {
    let placed = false;
    for (const lane of lanes) {
      const last = lane[lane.length - 1];
      if (seg.colStart > last.colEnd) {
        lane.push(seg);
        placed = true;
        break;
      }
    }
    if (!placed) lanes.push([seg]);
  }
  return lanes;
}
