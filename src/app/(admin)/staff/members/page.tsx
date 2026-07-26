import { Suspense } from "react";
import {
  ArrowDown,
  ArrowUp,
  GraduationCap,
  History,
  ShieldCheck,
  Trophy,
  Users,
} from "lucide-react";

import { requireStaffManagerPage } from "@/lib/staff/access";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ROLE_COLORS } from "@/lib/constants";
import {
  formatDateTime,
  formatNumber,
  formatRelative,
} from "@/lib/utils/format";
import {
  listRecentStaffPointEvents,
  listStaffMembers,
} from "@/lib/staff/profile";
import { levelProgress, STAFF_LEVELS } from "@/lib/staff/levels";
import { StaffLevelBadge } from "../_components/badges";
import { AwardPointsDialog } from "./_components/award-points-dialog";

export const metadata = { title: "Staff Members" };

/**
 * Antifraud → Staff Members.
 *
 * The team board: who is in the workspace, their level, their points, and how
 * much they've actually done (quizzes taken, cases closed). Ranked by points,
 * which is what the whole level system is for.
 *
 * Owners/admins additionally get the manual points adjustment control.
 */

const QUERY_TIMEOUT_MS = 10_000;

export default async function StaffMembersPage() {
  const session = await requireStaffManagerPage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Users}
          accent="cyan"
          title="Staff Members"
          subtitle="Levels, points and workload across the team"
        />
      </PageHero>

      <Suspense fallback={<BoardSkeleton />}>
        <Board viewerId={session.userId} />
      </Suspense>
    </div>
  );
}

async function Board({
  viewerId,
}: {
  viewerId: string;
}) {
  const [{ data: members }, { data: pointEvents }] = await Promise.all([
    safeQuery(
      () => listStaffMembers(),
      [],
      "antifraud.staff-members",
      QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => listRecentStaffPointEvents(100),
      [],
      "antifraud.staff-point-ledger",
      QUERY_TIMEOUT_MS,
    ),
  ]);

  const totalPoints = members.reduce(
    (sum, member) => sum + member.profile.pointsTotal,
    0,
  );
  const totalQuizzes = members.reduce(
    (sum, member) => sum + member.profile.quizzesCompleted,
    0,
  );
  const totalReviews = members.reduce(
    (sum, member) => sum + member.profile.reviewsResolved,
    0,
  );

  if (members.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center">
        <Users className="size-5 text-muted-foreground" />
        <span className="text-sm font-semibold">Nobody here yet</span>
        <span className="max-w-sm text-xs text-muted-foreground">
          A staff profile is created the first time someone opens this
          workspace, so the board fills itself as the team arrives.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Staff"
          value={formatNumber(members.length)}
          sub="in the workspace"
          icon={Users}
          accent="cyan"
        />
        <KpiTile
          label="Points earned"
          value={formatNumber(totalPoints)}
          sub="across the team"
          icon={Trophy}
          accent="amber"
        />
        <KpiTile
          label="Quizzes taken"
          value={formatNumber(totalQuizzes)}
          sub="submitted attempts"
          icon={GraduationCap}
          accent="purple"
        />
        <KpiTile
          label="Cases closed"
          value={formatNumber(totalReviews)}
          sub="cleared or flagged"
          icon={ShieldCheck}
          accent="emerald"
        />
      </div>

      <div className="space-y-4">
        <SectionHeading
          icon={Trophy}
          title="Team board"
          action={
            <AwardPointsDialog
              members={members.map((member) => ({
                id: member.profile.adminUserId,
                label:
                  member.profile.displayName ??
                  member.identity?.label ??
                  member.profile.adminUserId.slice(0, 8),
                points: member.profile.pointsTotal,
              }))}
            />
          }
        />

        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
          {members.map((member) => {
            const progress = levelProgress(member.profile.pointsTotal);
            const label =
              member.profile.displayName ??
              member.identity?.label ??
              member.profile.adminUserId.slice(0, 8);
            const isViewer = member.profile.adminUserId === viewerId;

            return (
              <li
                key={member.profile.adminUserId}
                className={cn(
                  "flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-4",
                  isViewer && "bg-cyan-500/[0.04]",
                )}
              >
                <span className="w-6 shrink-0 text-xs font-bold text-muted-foreground">
                  #{member.rank}
                </span>

                <Avatar size="sm" className="shrink-0">
                  {member.identity?.hasAvatar && (
                    <AvatarImage
                      src={`/api/admin/avatar/${member.profile.adminUserId}`}
                      alt={label}
                    />
                  )}
                  <AvatarFallback className="text-[10px] font-semibold">
                    {label.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>

                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-semibold">
                      {label}
                    </span>
                    {isViewer && (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        you
                      </span>
                    )}
                    <StaffLevelBadge level={member.profile.level} />
                    {member.identity?.role && (
                      <Badge
                        variant="outline"
                        className={cn(
                          "h-5 px-1.5 text-[9px] font-bold uppercase tracking-wide",
                          ROLE_COLORS[member.identity.role],
                        )}
                      >
                        {member.identity.role.replace("_", " ")}
                      </Badge>
                    )}
                  </span>
                  {member.profile.title && (
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {member.profile.title}
                    </span>
                  )}
                  {/* Level progress — how far into the current band they are. */}
                  <span className="mt-1.5 flex items-center gap-2">
                    <span
                      className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
                      aria-hidden
                    >
                      <span
                        className="block h-full rounded-full bg-cyan-500 motion-safe:transition-[width] motion-safe:duration-500"
                        style={{ width: `${progress.percent}%` }}
                      />
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {progress.next
                        ? `${progress.remaining} to L${progress.next.level}`
                        : "max level"}
                    </span>
                  </span>
                </span>

                <span className="flex shrink-0 items-center gap-4 text-[11px] text-muted-foreground">
                  <Stat
                    value={formatNumber(member.profile.pointsTotal)}
                    label="points"
                  />
                  <Stat
                    value={formatNumber(member.profile.quizzesCompleted)}
                    label="quizzes"
                  />
                  <Stat
                    value={formatNumber(member.profile.reviewsResolved)}
                    label="cases"
                  />
                  <span className="hidden w-20 text-right sm:block">
                    {member.profile.lastSeenAt
                      ? formatRelative(member.profile.lastSeenAt)
                      : "—"}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <section className="space-y-4">
        <SectionHeading icon={History} title="Recent staff point events" />
        {pointEvents.length === 0 ? (
          <Empty text="No staff point events have been recorded yet." />
        ) : (
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
            {pointEvents.map((event) => (
              <li
                key={event.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center"
              >
                <span
                  className={cn(
                    "flex w-14 shrink-0 items-center gap-1 text-sm font-bold tabular-nums",
                    event.points > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {event.points > 0 ? (
                    <ArrowUp className="size-3" />
                  ) : (
                    <ArrowDown className="size-3" />
                  )}
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
                    {event.actor?.label ??
                      (event.createdBy ? "Unknown" : "System")}
                  </span>
                  <span className="block">
                    {formatDateTime(event.createdAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-4">
        <SectionHeading icon={Trophy} title="Staff level thresholds" />
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

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span className="text-center">
      <span className="block text-xs font-semibold tabular-nums text-foreground">
        {value}
      </span>
      <span className="block text-[10px] uppercase tracking-wide">{label}</span>
    </span>
  );
}

function BoardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border border-border/60">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}
