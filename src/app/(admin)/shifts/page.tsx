import { CalendarClock } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { ShiftBoard } from "./shift-board";
import { getAssignableWorkers, getShiftsForWeeks } from "./queries";
import {
  getWeekStart,
  parseWeekStartParam,
  shiftWeek,
  weekStartToParam,
  type Shift,
  type Worker,
} from "./types";

export const metadata = { title: "Shifts" };

// Show four weeks stacked at once by default. Feels like a month view,
// lets the admin plan the current + next three weeks without paging.
// Bounded at 12 to keep the query + render cheap.
const DEFAULT_WEEKS = 4;
const MAX_WEEKS = 12;

export default async function ShiftsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/shifts");
  const params = await searchParams;

  const firstWeekStart = parseWeekStartParam(params.week);
  const currentWeekStart = getWeekStart(new Date());
  const weeksCount = Math.min(
    MAX_WEEKS,
    Math.max(1, Number.parseInt(params.weeks ?? "", 10) || DEFAULT_WEEKS),
  );

  // Build the set of week-start dates we want to render.
  const weekStarts: Date[] = [];
  for (let i = 0; i < weeksCount; i++) {
    weekStarts.push(shiftWeek(firstWeekStart, i));
  }

  const [shifts, workers]: [Shift[], Worker[]] = await Promise.all([
    getShiftsForWeeks(weekStarts),
    getAssignableWorkers(),
  ]);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <CalendarClock className="size-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold leading-tight sm:text-2xl">Shifts</h1>
            <p className="text-xs text-muted-foreground sm:text-sm">
              Weekly support rota — three shift slots per day with flexible
              times. Every shift renders in your own timezone.
            </p>
          </div>
        </div>
      </PageHero>

      <FadeIn>
        <ShiftBoard
          weekStartsIso={weekStarts.map((w) => w.toISOString())}
          currentWeekStartIso={currentWeekStart.toISOString()}
          currentWeekParam={weekStartToParam(currentWeekStart)}
          shifts={shifts}
          workers={workers}
        />
      </FadeIn>
    </div>
  );
}
