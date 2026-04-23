import { CalendarClock } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { ShiftBoard } from "./shift-board";
import { getAssignableWorkers, getShiftsForWeek } from "./queries";
import {
  getWeekStart,
  parseWeekStartParam,
  weekStartToParam,
  type Shift,
  type Worker,
} from "./types";

export const metadata = { title: "Shifts" };

export default async function ShiftsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/shifts");
  const params = await searchParams;

  const weekStart = parseWeekStartParam(params.week);
  const currentWeekStart = getWeekStart(new Date());

  const [shifts, workers]: [Shift[], Worker[]] = await Promise.all([
    getShiftsForWeek(weekStart),
    getAssignableWorkers(),
  ]);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <CalendarClock className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Shifts</h1>
            <p className="text-sm text-muted-foreground">
              Weekly support rota — three shift slots per day with flexible
              times. Hours are stored in UTC and rendered in your own
              timezone.
            </p>
          </div>
        </div>
      </PageHero>

      <FadeIn>
        <ShiftBoard
          weekStartIso={weekStart.toISOString()}
          currentWeekStartIso={currentWeekStart.toISOString()}
          currentWeekParam={weekStartToParam(currentWeekStart)}
          shifts={shifts}
          workers={workers}
        />
      </FadeIn>
    </div>
  );
}
