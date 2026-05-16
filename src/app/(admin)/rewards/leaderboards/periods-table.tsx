"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Power, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { formatDateTime } from "@/lib/utils/format";
import {
  startRacePeriod,
  toggleRacePeriodAutoRenew,
  endRacePeriodNow,
} from "./actions";

type RacePeriod = {
  id: string;
  raceType: string;
  startsAt: string;
  endsAt: string;
  autoRenew: boolean;
  status: string;
};

type RaceType = "daily" | "weekly" | "monthly";

const RACE_TYPES: RaceType[] = ["monthly", "weekly", "daily"];

// Monthly defaults: start = today (UTC), end = +30 days (UTC). Admin can
// override since monthly is the only type that allows custom dates.
function defaultMonthlyDates(): { start: string; end: string } {
  const now = new Date();
  const startUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const endUtc = new Date(startUtc.getTime() + 30 * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(startUtc), end: iso(endUtc) };
}

function PeriodRow({
  period,
  isPending,
  onToggleAutoRenew,
  onEndNow,
}: {
  period: RacePeriod;
  isPending: boolean;
  onToggleAutoRenew: (id: string) => void;
  onEndNow: (id: string, raceType: string) => void;
}) {
  const isActive = period.status === "active";
  return (
    <TableRow>
      <TableCell>
        <Badge variant="outline" className="capitalize">
          {period.raceType}
        </Badge>
      </TableCell>
      <TableCell>
        <Badge
          variant={isActive ? "default" : "outline"}
          className={isActive ? "" : "text-muted-foreground"}
        >
          {period.status}
        </Badge>
      </TableCell>
      <TableCell className="tabular-nums text-xs">
        {formatDateTime(period.startsAt)}
      </TableCell>
      <TableCell className="tabular-nums text-xs">
        {formatDateTime(period.endsAt)}
      </TableCell>
      <TableCell>
        {isActive ? (
          <div className="flex items-center gap-2">
            <Switch
              checked={period.autoRenew}
              disabled={isPending}
              onCheckedChange={() => onToggleAutoRenew(period.id)}
              aria-label="Toggle auto-renew"
            />
            <span className="text-xs text-muted-foreground">
              {period.autoRenew ? "On" : "Off"}
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {period.autoRenew ? "On" : "Off"}
          </span>
        )}
      </TableCell>
      <TableCell>
        {isActive && (
          <Button
            size="sm"
            variant="ghost"
            disabled={isPending}
            onClick={() => onEndNow(period.id, period.raceType)}
            className="text-muted-foreground hover:text-destructive"
          >
            <Power className="mr-1 size-3" />
            End now
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

export function PeriodsTable({
  active,
  recent,
}: {
  active: RacePeriod[];
  recent: RacePeriod[];
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Monthly is the only type that needs a form (custom date picker). Daily
  // and weekly are start-with-one-click — the server snaps them to UTC
  // midnight, so the admin has no way to introduce drift by typing a
  // datetime. See actions.ts:startRacePeriod for the calendar-snap rules.
  const [monthlyFormOpen, setMonthlyFormOpen] = useState(false);
  const [monthlyStart, setMonthlyStart] = useState("");
  const [monthlyEnd, setMonthlyEnd] = useState("");
  const [monthlyAutoRenew, setMonthlyAutoRenew] = useState(true);

  function openMonthlyForm() {
    const { start, end } = defaultMonthlyDates();
    setMonthlyStart(start);
    setMonthlyEnd(end);
    setMonthlyAutoRenew(true);
    setMonthlyFormOpen(true);
  }

  function cancelMonthlyForm() {
    setMonthlyFormOpen(false);
  }

  function startDailyOrWeekly(raceType: "daily" | "weekly") {
    if (
      !confirm(
        `Start a new ${raceType} race now? It will begin at today's UTC midnight and auto-renew unless you turn that off.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        await startRacePeriod({ raceType, autoRenew: true });
        toast.success(`${raceType} race started`);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to start");
      }
    });
  }

  function submitMonthly() {
    if (!monthlyStart || !monthlyEnd) {
      toast.error("Both start and end dates are required");
      return;
    }
    startTransition(async () => {
      try {
        await startRacePeriod({
          raceType: "monthly",
          autoRenew: monthlyAutoRenew,
          monthlyStartDate: monthlyStart,
          monthlyEndDate: monthlyEnd,
        });
        toast.success("monthly race started");
        setMonthlyFormOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to start");
      }
    });
  }

  function handleToggleAutoRenew(id: string) {
    startTransition(async () => {
      try {
        await toggleRacePeriodAutoRenew(id);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to toggle");
      }
    });
  }

  function handleEndNow(id: string, raceType: string) {
    if (
      !confirm(
        `End the active ${raceType} race now? Snapshots will be generated and prizes become claimable.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        await endRacePeriodNow(id);
        toast.success(`${raceType} race ended`);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to end");
      }
    });
  }

  const activeByType = new Map(active.map((p) => [p.raceType, p]));

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">Active periods</h3>
        </div>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Starts</TableHead>
                <TableHead>Ends</TableHead>
                <TableHead>Auto-renew</TableHead>
                <TableHead className="w-[180px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {RACE_TYPES.map((rt) => {
                const period = activeByType.get(rt);
                if (period) {
                  return (
                    <PeriodRow
                      key={rt}
                      period={period}
                      isPending={isPending}
                      onToggleAutoRenew={handleToggleAutoRenew}
                      onEndNow={handleEndNow}
                    />
                  );
                }
                return (
                  <TableRow key={rt}>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {rt}
                      </Badge>
                    </TableCell>
                    <TableCell
                      colSpan={4}
                      className="text-muted-foreground text-xs"
                    >
                      No active period.
                    </TableCell>
                    <TableCell>
                      {rt === "monthly" ? (
                        !monthlyFormOpen && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={openMonthlyForm}
                            disabled={isPending}
                          >
                            <Plus className="mr-1 size-3" />
                            Start
                          </Button>
                        )
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => startDailyOrWeekly(rt)}
                          disabled={isPending}
                        >
                          <Plus className="mr-1 size-3" />
                          Start (UTC 00:00)
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {monthlyFormOpen && (
          <div className="mt-3 rounded-md border bg-muted/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">Start monthly race</h4>
              <Button
                size="sm"
                variant="ghost"
                onClick={cancelMonthlyForm}
                disabled={isPending}
              >
                Cancel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Dates are interpreted as UTC midnight to keep the race aligned
              to calendar days. Daily and weekly races snap automatically and
              don&apos;t need a form.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-xs space-y-1">
                <span className="text-muted-foreground">
                  Start date (UTC 00:00)
                </span>
                <Input
                  type="date"
                  value={monthlyStart}
                  onChange={(e) => setMonthlyStart(e.target.value)}
                  className="h-8"
                />
              </label>
              <label className="text-xs space-y-1">
                <span className="text-muted-foreground">
                  End date (UTC 00:00)
                </span>
                <Input
                  type="date"
                  value={monthlyEnd}
                  onChange={(e) => setMonthlyEnd(e.target.value)}
                  className="h-8"
                />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={monthlyAutoRenew}
                onCheckedChange={setMonthlyAutoRenew}
                aria-label="Auto-renew"
              />
              <span className="text-xs">
                Auto-renew when this period ends
              </span>
            </div>
            <Button
              size="sm"
              onClick={submitMonthly}
              disabled={isPending}
              className="h-8"
            >
              <RefreshCw
                className={`mr-1 size-3 ${isPending ? "animate-spin" : ""}`}
              />
              Start period
            </Button>
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium">Recently ended</h3>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Ended</TableHead>
                <TableHead>Auto-renew</TableHead>
                <TableHead className="w-[180px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="h-20 text-center text-muted-foreground text-xs"
                  >
                    No ended periods yet.
                  </TableCell>
                </TableRow>
              ) : (
                recent.map((p) => (
                  <PeriodRow
                    key={p.id}
                    period={p}
                    isPending={isPending}
                    onToggleAutoRenew={handleToggleAutoRenew}
                    onEndNow={handleEndNow}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
