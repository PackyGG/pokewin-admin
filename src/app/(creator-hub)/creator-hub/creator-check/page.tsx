import { Suspense } from "react";
import {
  Radar,
  Tv,
  Twitter,
  Users,
  Search,
  MessageCircle,
  Megaphone,
} from "lucide-react";

import { requireRole } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/ux";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/utils/format";

import { getCheckHistory } from "./_queries/check-history";
import { CheckCreatorDialog } from "./_components/check-creator-dialog";
import { ProfileCheckBox } from "./_components/profile-check-box";

export const metadata = { title: "Creator Check · Creator Hub" };

/**
 * Creator Check — a Kick + Twitter recon/lookup tool (Creator Hub).
 *
 * The "+ Check Creator" dialog asks for a Kick username and/or a Twitter
 * username (≥1 required), then fetches ALL available data from both APIs
 * (server-only keys), saves it to the ADMIN-DB substrate (kick_profiles /
 * kick_streams / twitter_profiles / tweets / twitter_mentions), and shows it.
 * Works for ANY handle — not only signed-up creators.
 *
 * The page itself is a HISTORY view: one display box per previously-checked
 * profile, rebuilt from the saved substrate rows (no separate history table).
 * Each box opens a lazy detail modal (streams / tweets + 7-day mentions) and a
 * manual Refetch — there is no auto-poll / no per-render external fetch (the
 * page is a pure DB read; the only API hits are the explicit Check / Refetch).
 *
 * ACCESS: admin + creator_manager only (the Hub layout enforces it; this page
 * adds the explicit DAL gate per the house convention).
 *
 * LAZY: the data-bearing block is wrapped in a Suspense boundary so the shell
 * (hero + Check button) paints immediately and the history streams in.
 */
export default async function CreatorCheckPage() {
  await requireRole(["admin", "creator_manager"]);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Radar}
          accent="cyan"
          title="Creator Check"
          subtitle="Look up any Kick or Twitter handle — pull, save, and review their public stats"
          action={<CheckCreatorDialog />}
        />
      </PageHero>

      <Suspense fallback={<HistorySkeleton />}>
        <HistorySection />
      </Suspense>
    </div>
  );
}

// ─── History section (data-bearing, streamed) ───────────────────────

async function HistorySection() {
  const history = await getCheckHistory();
  const { kick, twitter, totalProfiles, substrateUnavailable } = history;
  const hasAny = kick.length > 0 || twitter.length > 0;

  // Aggregate KPI figures (all neutral/info — this is a recon tool, no money).
  const totalKickFollowers = sum(kick.map((k) => k.followerCount));
  const totalMentions7d = twitter.reduce((a, t) => a + t.mentionCount7d, 0);

  return (
    <FadeIn className="space-y-6">
      {/* KPI strip — counts only; all blue (neutral info, not money). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label="Profiles Checked"
          value={formatNumber(totalProfiles)}
          sub="distinct handles saved"
          icon={Search}
          accent="blue"
        />
        <KpiTile
          label="Kick Profiles"
          value={formatNumber(kick.length)}
          sub="channels in history"
          icon={Tv}
          accent="blue"
        />
        <KpiTile
          label="Twitter Profiles"
          value={formatNumber(twitter.length)}
          sub="accounts in history"
          icon={Twitter}
          accent="blue"
        />
        <KpiTile
          label="Brand Mentions · 7d"
          value={formatNumber(totalMentions7d)}
          sub="across checked accounts"
          icon={Megaphone}
          accent="blue"
        />
      </div>

      {substrateUnavailable && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          The Creator-Hub data tables aren&apos;t available on this database
          yet. Checks won&apos;t persist until the substrate is applied.
        </div>
      )}

      {!hasAny ? (
        <EmptyHistory />
      ) : (
        <div className="space-y-6">
          {/* Kick section */}
          <div className="space-y-3">
            <SectionHeading
              icon={Tv}
              title={`Kick · ${formatNumber(kick.length)}`}
            />
            {kick.length === 0 ? (
              <PlatformEmpty
                icon={Tv}
                label="No Kick handles checked yet"
                hint="Use “+ Check Creator” and enter a Kick username."
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {kick.map((s) => (
                  <ProfileCheckBox key={`kick:${s.handle}`} summary={s} />
                ))}
              </div>
            )}
            {kick.length > 0 && (
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Users className="size-3" />
                {formatNumber(totalKickFollowers)} followers across checked Kick
                channels
              </p>
            )}
          </div>

          {/* Twitter section */}
          <div className="space-y-3">
            <SectionHeading
              icon={Twitter}
              title={`Twitter / X · ${formatNumber(twitter.length)}`}
            />
            {twitter.length === 0 ? (
              <PlatformEmpty
                icon={Twitter}
                label="No Twitter handles checked yet"
                hint="Use “+ Check Creator” and enter a Twitter username."
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {twitter.map((s) => (
                  <ProfileCheckBox key={`twitter:${s.handle}`} summary={s} />
                ))}
              </div>
            )}
            {twitter.length > 0 && (
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <MessageCircle className="size-3" />
                {formatNumber(totalMentions7d)} brand mentions in the last 7 days
              </p>
            )}
          </div>
        </div>
      )}
    </FadeIn>
  );
}

// ─── Empty states ───────────────────────────────────────────────────

function EmptyHistory() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed bg-card/40 px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-2xl border border-cyan-500/20 bg-cyan-500/10 text-cyan-500">
        <Radar className="size-6" />
      </span>
      <div>
        <p className="text-sm font-semibold">No checks yet</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          Check any Kick or Twitter handle to pull their public profile, latest
          streams, and latest tweets. Every profile you check is saved here.
        </p>
      </div>
      <CheckCreatorDialog />
    </div>
  );
}

function PlatformEmpty({
  icon: Icon,
  label,
  hint,
}: {
  icon: React.ElementType;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-card/40 px-4 py-8 text-center">
      <Icon className="size-5 text-muted-foreground" />
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="max-w-xs text-[11px] text-muted-foreground/80">{hint}</p>
    </div>
  );
}

// ─── Skeleton ───────────────────────────────────────────────────────

function HistorySkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-xl" />
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[150px] rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Local helpers ──────────────────────────────────────────────────

/** Sum a list of nullable numbers, treating null as 0. */
function sum(values: (number | null)[]): number {
  return values.reduce<number>((a, v) => a + (v ?? 0), 0);
}
