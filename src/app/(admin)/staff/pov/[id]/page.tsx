import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  Eye,
  GraduationCap,
  ShieldCheck,
  Trophy,
  UserCircle,
} from "lucide-react";

import { requireStaffManagerPage } from "@/lib/staff/access";
import { safeQuery } from "@/lib/errors/safe-query";
import { loadAdminIdentities } from "@/lib/staff/identities";
import { getStaffProfile, listStaffPointEvents } from "@/lib/staff/profile";
import { levelProgress } from "@/lib/staff/levels";
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
import { formatDateTime, formatNumber, formatRelative } from "@/lib/utils/format";
import { StaffLevelBadge } from "../../_components/badges";

export const metadata = { title: "Support Profile POV" };

const QUERY_TIMEOUT_MS = 10_000;

export default async function SupportPovDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireStaffManagerPage();
  const { id } = await params;
  const identity = (await loadAdminIdentities([id])).get(id);
  if (!identity?.roles.includes("support")) notFound();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Eye}
          accent="purple"
          title={`${identity.label}'s POV`}
          subtitle="Read-only preview of this support user's staff profile"
          backHref="/staff/pov"
        />
      </PageHero>

      <div className="flex items-center gap-2 rounded-xl border border-purple-500/20 bg-purple-500/[0.06] px-4 py-3 text-sm text-purple-700 dark:text-purple-300">
        <Eye className="size-4 shrink-0" />
        You are previewing this page as {identity.label}. Editing and notification
        destinations are disabled.
      </div>

      <Suspense fallback={<ProfilePovSkeleton />}>
        <ProfilePov adminUserId={id} />
      </Suspense>
    </div>
  );
}

async function ProfilePov({ adminUserId }: { adminUserId: string }) {
  const [{ data: profile }, { data: events }, identities] = await Promise.all([
    safeQuery(
      () => getStaffProfile(adminUserId),
      null,
      "staff.pov-profile",
      QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => listStaffPointEvents(adminUserId, 20),
      [],
      "staff.pov-events",
      QUERY_TIMEOUT_MS,
    ),
    loadAdminIdentities([adminUserId]),
  ]);
  const identity = identities.get(adminUserId);
  if (!identity || !profile) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center text-sm text-muted-foreground">
        This support user has not created a staff profile yet.
      </div>
    );
  }

  const points = profile.pointsTotal;
  const progress = levelProgress(points);
  const label = profile.displayName ?? identity.label;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Points"
          value={formatNumber(points)}
          sub={
            progress.next
              ? `${progress.remaining} to level ${progress.next.level}`
              : "max level reached"
          }
          icon={Trophy}
          accent="amber"
        />
        <KpiTile
          label="Level"
          value={`${progress.current.level} · ${progress.current.title}`}
          sub={`${progress.percent}% through this level`}
          icon={ShieldCheck}
          accent="cyan"
        />
        <KpiTile
          label="Quizzes taken"
          value={formatNumber(profile.quizzesCompleted)}
          sub="submitted attempts"
          icon={GraduationCap}
          accent="purple"
        />
        <KpiTile
          label="Cases closed"
          value={formatNumber(profile.reviewsResolved)}
          sub="cleared or flagged"
          icon={ShieldCheck}
          accent="emerald"
        />
      </div>

      <div className="space-y-2 rounded-xl border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <StaffLevelBadge level={progress.current.level} />
            <span className="text-xs text-muted-foreground">
              {formatNumber(points)} points
            </span>
          </div>
          {progress.next && (
            <span className="text-xs text-muted-foreground">
              next: L{progress.next.level} · {progress.next.title}
            </span>
          )}
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={progress.percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-cyan-500"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <SectionHeading icon={UserCircle} title="Your profile" />
          <div className="rounded-xl border border-border/60 bg-card p-5">
            <div className="flex items-start gap-4">
              <Avatar className="size-14 shrink-0">
                {identity.hasAvatar && (
                  <AvatarImage
                    src={`/api/admin/avatar/${adminUserId}`}
                    alt={label}
                  />
                )}
                <AvatarFallback>
                  {label.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold">{label}</h2>
                <p className="text-sm text-muted-foreground">
                  {profile.title || "Support"}
                </p>
                <Badge variant="outline" className="mt-2 capitalize">
                  {profile.accent} accent
                </Badge>
              </div>
            </div>
            <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">
              {profile.bio || "No bio added yet."}
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <SectionHeading icon={Trophy} title="Points history" />
          {events.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-8 text-center text-xs text-muted-foreground">
              No points yet.
            </p>
          ) : (
            <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
              {events.map((event) => (
                <li
                  key={event.id}
                  className="flex items-center gap-3 px-3 py-2.5 sm:px-4"
                >
                  <span
                    className={cn(
                      "w-10 shrink-0 text-sm font-bold tabular-nums",
                      event.points > 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400",
                    )}
                  >
                    {event.points > 0 ? `+${event.points}` : event.points}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">
                      {event.reason}
                    </span>
                    <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                      {event.sourceKind}
                    </span>
                  </span>
                  <span
                    className="shrink-0 text-[11px] text-muted-foreground"
                    title={formatDateTime(event.createdAt)}
                  >
                    {formatRelative(event.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ProfilePovSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-20 rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
