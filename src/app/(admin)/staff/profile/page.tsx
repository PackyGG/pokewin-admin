import { Suspense } from "react";
import {
  BellRing,
  GraduationCap,
  ShieldCheck,
  Trophy,
  UserCircle,
} from "lucide-react";
import { eq } from "drizzle-orm";

import { requireStaffProfilePage } from "@/lib/staff/access";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_users, staff_notification_channels, staff_notification_prefs } from "@/lib/db-schema/admin/schema";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/utils/format";
import {
  getStaffProfile,
  listStaffPointEvents,
} from "@/lib/staff/profile";
import { levelProgress } from "@/lib/staff/levels";
import { channelConfigStatus } from "@/lib/staff/channels";
import {
  STAFF_NOTIFICATION_KINDS,
  isMissingRelationError,
  isStaffNotificationKind,
} from "@/lib/staff/notifications";
import { StaffLevelBadge } from "../_components/badges";
import { ProfileEditor } from "./_components/profile-editor";
import {
  ChannelSettings,
  type ChannelState,
} from "./_components/channel-settings";
import {
  NotificationPrefs,
  type PrefRow,
} from "./_components/notification-prefs";

export const metadata = { title: "My Profile" };

/**
 * Antifraud → My Profile.
 *
 * The staff member's own page: their level and points with the ledger that
 * explains them, the profile they control (picture, name, title, bio, accent),
 * and the notification setup — Discord (default) or Telegram, each verified
 * before it is ever delivered to.
 *
 * Shell-first: the hero paints immediately; the identity + notification legs
 * stream behind their own Suspense boundaries.
 */

const QUERY_TIMEOUT_MS = 10_000;

export default async function StaffProfilePage() {
  const session = await requireStaffProfilePage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={UserCircle}
          accent="cyan"
          title="My Profile"
          subtitle="Your level, your points, and how you want to be pinged"
        />
      </PageHero>

      <Suspense fallback={<IdentitySkeleton />}>
        <IdentitySection adminUserId={session.userId} username={session.username} />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <NotificationsSection adminUserId={session.userId} />
      </Suspense>
    </div>
  );
}

// ─── Identity + points ────────────────────────────────────────────────

async function IdentitySection({
  adminUserId,
  username,
}: {
  adminUserId: string;
  username: string;
}) {
  const [{ data: profile }, { data: events }, identity] = await Promise.all([
    safeQuery(
      () => getStaffProfile(adminUserId),
      null,
      "antifraud.profile-self",
      QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => listStaffPointEvents(adminUserId, 20),
      [],
      "antifraud.profile-events",
      QUERY_TIMEOUT_MS,
    ),
    adminDrizzle.select({
      profile_image_mime: admin_users.profile_image_mime,
      display_username: admin_users.display_username,
    }).from(admin_users).where(eq(admin_users.id, adminUserId)).limit(1)
      .then((rows) => rows[0] ?? null)
      .catch(() => null),
  ]);

  const points = profile?.pointsTotal ?? 0;
  const progress = levelProgress(points);

  return (
    <div className="space-y-6">
      {/* ── Level strip ────────────────────────────────────────────── */}
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
          value={formatNumber(profile?.quizzesCompleted ?? 0)}
          sub="submitted attempts"
          icon={GraduationCap}
          accent="purple"
        />
        <KpiTile
          label="Cases closed"
          value={formatNumber(profile?.reviewsResolved ?? 0)}
          sub="cleared or flagged"
          icon={ShieldCheck}
          accent="emerald"
        />
      </div>

      {/* ── Level progress bar ─────────────────────────────────────── */}
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
            className="h-full rounded-full bg-cyan-500 motion-safe:transition-[width] motion-safe:duration-700 motion-safe:ease-out"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* ── Editable profile ─────────────────────────────────────── */}
        <div className="space-y-4">
          <SectionHeading icon={UserCircle} title="Your profile" />
          <ProfileEditor
            adminUserId={adminUserId}
            username={identity?.display_username ?? username}
            hasAvatar={Boolean(identity?.profile_image_mime)}
            initial={{
              displayName: profile?.displayName ?? "",
              title: profile?.title ?? "",
              bio: profile?.bio ?? "",
              accent: profile?.accent ?? "blue",
            }}
          />
        </div>

        {/* ── Points ledger ────────────────────────────────────────── */}
        <div className="space-y-4">
          <SectionHeading icon={Trophy} title="Points history" />
          {events.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-8 text-center text-xs text-muted-foreground">
              No points yet. Take a quiz — one point per correct answer.
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

// ─── Notifications ────────────────────────────────────────────────────

async function NotificationsSection({ adminUserId }: { adminUserId: string }) {
  const configured = channelConfigStatus();

  const [channelRows, prefRows] = await Promise.all([
    adminDrizzle.select().from(staff_notification_channels)
      .where(eq(staff_notification_channels.admin_user_id, adminUserId))
      .catch((err) => {
        if (!isMissingRelationError(err)) {
          console.error("[antifraud] profile channels read failed:", err);
        }
        return [];
      }),
    adminDrizzle.select().from(staff_notification_prefs)
      .where(eq(staff_notification_prefs.admin_user_id, adminUserId))
      .catch((err) => {
        if (!isMissingRelationError(err)) {
          console.error("[antifraud] profile prefs read failed:", err);
        }
        return [];
      }),
  ]);

  const byChannel = new Map(channelRows.map((row) => [row.channel, row]));

  const channels: ChannelState[] = (["discord", "telegram"] as const).map(
    (channel) => {
      const row = byChannel.get(channel);
      return {
        channel,
        target: row?.target ?? null,
        enabled: row?.enabled ?? true,
        verified: Boolean(row?.verified_at),
        lastError: row?.last_error ?? null,
        // Drizzle returns timestamptz as an ISO string already (the old client handed
        // back a Date), so this is a pass-through rather than a conversion.
        lastSentAt: row?.last_sent_at ?? null,
        configured: configured[channel],
      };
    },
  );

  const prefByKind = new Map(prefRows.map((row) => [row.kind, row]));

  const rows: PrefRow[] = Object.entries(STAFF_NOTIFICATION_KINDS)
    .filter(([kind]) => isStaffNotificationKind(kind))
    .map(([kind, spec]) => {
      const stored = prefByKind.get(kind);
      return {
        kind,
        label: spec.label,
        description: spec.description,
        inApp: stored?.in_app ?? spec.defaults.inApp,
        discord: stored?.discord ?? spec.defaults.discord,
        telegram: stored?.telegram ?? spec.defaults.telegram,
        isDefault: !stored,
      };
    });

  const discordReady = channels[0].verified && channels[0].configured;
  const telegramReady = channels[1].verified && channels[1].configured;

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <SectionHeading icon={BellRing} title="Where we ping you" />
        <ChannelSettings channels={channels} />
      </div>

      <div className="space-y-4">
        <SectionHeading icon={BellRing} title="What you get pinged about" />
        <NotificationPrefs
          rows={rows}
          discordReady={discordReady}
          telegramReady={telegramReady}
        />
      </div>
    </div>
  );
}

function IdentitySkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-20 w-full rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-96 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    </div>
  );
}
