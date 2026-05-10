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

/**
 * Default starts_at = next minute (rounded), ends_at = +30 days from start
 * for monthly, +7 for weekly, +1 for daily. Admin can override anything.
 */
function defaultPeriodInputs(raceType: RaceType): {
  startsAt: string;
  endsAt: string;
} {
  const now = new Date();
  now.setSeconds(0, 0);
  const start = now;
  const end = new Date(now);
  if (raceType === "monthly") {
    end.setUTCMonth(end.getUTCMonth() + 1);
  } else if (raceType === "weekly") {
    end.setUTCDate(end.getUTCDate() + 7);
  } else {
    end.setUTCDate(end.getUTCDate() + 1);
  }
  // datetime-local format: YYYY-MM-DDTHH:mm in local time
  const fmt = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
      d.getDate(),
    )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  return { startsAt: fmt(start), endsAt: fmt(end) };
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

  const [startingFor, setStartingFor] = useState<RaceType | null>(null);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [autoRenew, setAutoRenew] = useState(true);

  function openStart(raceType: RaceType) {
    const { startsAt: s, endsAt: e } = defaultPeriodInputs(raceType);
    setStartingFor(raceType);
    setStartsAt(s);
    setEndsAt(e);
    setAutoRenew(true);
  }

  function cancelStart() {
    setStartingFor(null);
  }

  function submitStart() {
    if (!startingFor) return;
    if (!startsAt || !endsAt) {
      toast.error("Both start and end are required");
      return;
    }
    startTransition(async () => {
      try {
        await startRacePeriod({
          raceType: startingFor,
          // datetime-local strings are local-time; the server parses as Date
          // which respects the user's TZ. For UTC-strict consistency the
          // admin can pick the equivalent UTC value explicitly.
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          autoRenew,
        });
        toast.success(`${startingFor} race started`);
        cancelStart();
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
                <TableHead className="w-[140px]" />
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
                    <TableCell colSpan={4} className="text-muted-foreground text-xs">
                      No active period.
                    </TableCell>
                    <TableCell>
                      {startingFor !== rt && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => openStart(rt)}
                          disabled={isPending}
                        >
                          <Plus className="mr-1 size-3" />
                          Start
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {startingFor && (
          <div className="mt-3 rounded-md border bg-muted/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium capitalize">
                Start {startingFor} race
              </h4>
              <Button
                size="sm"
                variant="ghost"
                onClick={cancelStart}
                disabled={isPending}
              >
                Cancel
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-xs space-y-1">
                <span className="text-muted-foreground">Starts at</span>
                <Input
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  className="h-8"
                />
              </label>
              <label className="text-xs space-y-1">
                <span className="text-muted-foreground">Ends at</span>
                <Input
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  className="h-8"
                />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={autoRenew}
                onCheckedChange={setAutoRenew}
                aria-label="Auto-renew"
              />
              <span className="text-xs">
                Auto-renew when this period ends
              </span>
            </div>
            <Button
              size="sm"
              onClick={submitStart}
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
                <TableHead className="w-[140px]" />
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
