import { Suspense } from "react";
import { ArrowDown, ArrowUp, History, Trophy, Users } from "lucide-react";

import { requireStaffManagerPage } from "@/lib/staff/access";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDateTime, formatNumber } from "@/lib/utils/format";
import {
  listRecentStaffPointEvents,
  listStaffMembers,
} from "@/lib/staff/profile";
import { STAFF_LEVELS } from "@/lib/staff/levels";
import { StaffLevelBadge } from "../_components/badges";
import { AwardPointsDialog } from "../members/_components/award-points-dialog";

export const metadata = { title: "Staff Points" };

const QUERY_TIMEOUT_MS = 10_000;

export default async function StaffPointsPage() {
  await requireStaffManagerPage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Trophy}
          accent="amber"
          title="Staff Points"
          subtitle="Current balances, level thresholds and the immutable points ledger"
          backHref="/staff"
        />
      </PageHero>

      <Suspense fallback={<PointsSkeleton />}>
        <PointsDashboard />
      </Suspense>
    </div>
  );
}

async function PointsDashboard() {
  const [{ data: members }, { data: events }] = await Promise.all([
    safeQuery(
      () => listStaffMembers(),
      [],
      "antifraud.points-members",
      QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => listRecentStaffPointEvents(100),
      [],
      "antifraud.points-ledger",
      QUERY_TIMEOUT_MS,
    ),
  ]);

  const totalPoints = members.reduce(
    (sum, member) => sum + member.profile.pointsTotal,
    0,
  );
  const awarded = events.reduce(
    (sum, event) => sum + Math.max(0, event.points),
    0,
  );
  const removed = events.reduce(
    (sum, event) => sum + Math.abs(Math.min(0, event.points)),
    0,
  );
  const awardMembers = members.map((member) => ({
    id: member.profile.adminUserId,
    label:
      member.profile.displayName ??
      member.identity?.label ??
      member.profile.adminUserId.slice(0, 8),
    points: member.profile.pointsTotal,
  }));

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Current points"
          value={formatNumber(totalPoints)}
          sub="across all staff"
          icon={Trophy}
          accent="amber"
        />
        <KpiTile
          label="Staff"
          value={formatNumber(members.length)}
          sub="with a profile"
          icon={Users}
          accent="cyan"
        />
        <KpiTile
          label="Recent awarded"
          value={`+${formatNumber(awarded)}`}
          sub="latest 100 events"
          icon={ArrowUp}
          accent="emerald"
        />
        <KpiTile
          label="Recent removed"
          value={`-${formatNumber(removed)}`}
          sub="latest 100 events"
          icon={ArrowDown}
          accent="rose"
        />
      </div>

      <section className="space-y-4">
        <SectionHeading
          icon={Users}
          title="Current balances"
          action={
            awardMembers.length > 0 ? (
              <AwardPointsDialog members={awardMembers} />
            ) : undefined
          }
        />
        {members.length === 0 ? (
          <Empty text="No staff profiles exist yet." />
        ) : (
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
            {members.map((member) => {
              const label =
                member.profile.displayName ??
                member.identity?.label ??
                member.profile.adminUserId.slice(0, 8);
              return (
                <li
                  key={member.profile.adminUserId}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <span className="w-7 shrink-0 text-xs font-bold text-muted-foreground">
                    #{member.rank}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">
                      {label}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {member.profile.quizzesCompleted} quizzes ·{" "}
                      {member.profile.reviewsResolved} cases
                    </span>
                  </span>
                  <StaffLevelBadge level={member.profile.level} />
                  <span className="w-20 shrink-0 text-right text-sm font-bold tabular-nums">
                    {formatNumber(member.profile.pointsTotal)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-4">
        <SectionHeading icon={History} title="Recent point events" />
        {events.length === 0 ? (
          <Empty text="No point events have been recorded yet." />
        ) : (
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center"
              >
                <span
                  className={cn(
                    "w-14 shrink-0 text-sm font-bold tabular-nums",
                    event.points > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {event.points > 0 ? "+" : ""}
                  {event.points}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold">
                      {event.recipient?.label ?? event.adminUserId.slice(0, 8)}
                    </span>
                    <Badge variant="outline" className="h-5 text-[9px] uppercase">
                      {event.sourceKind}
                    </Badge>
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {event.reason}
                  </span>
                </span>
                <span className="shrink-0 text-right text-[11px] text-muted-foreground">
                  <span className="block">
                    {event.actor?.label ?? (event.createdBy ? "Unknown" : "System")}
                  </span>
                  <span className="block">{formatDateTime(event.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4">
        <SectionHeading icon={Trophy} title="Level thresholds" />
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {STAFF_LEVELS.map((level) => (
            <div
              key={level.level}
              className="rounded-xl border border-border/60 bg-card px-3 py-3"
            >
              <StaffLevelBadge level={level.level} />
              <p className="mt-2 text-sm font-semibold">{level.title}</p>
              <p className="text-[11px] text-muted-foreground">
                {formatNumber(level.minPoints)} points
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function PointsSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}
