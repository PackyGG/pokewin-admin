import {
  AlertTriangle,
  CalendarDays,
  List,
  Server,
  ScrollText,
  Sparkles,
  Tag,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
  SectionHeading,
  StatPanel,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { requirePageAccess, getUserPermissions } from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { formatDate, formatNumber, formatRelative } from "@/lib/utils/format";
import { ensureChangelogSchema } from "@/lib/changelog/ensure-schema";
import {
  getChangelogEntries,
  getChangelogStats,
  type ChangelogCategory,
  type ChangelogChangeKind,
  type ChangelogEntry,
} from "@/lib/queries/changelog";
import { cn } from "@/lib/utils";

import {
  EditChangelogEntryButton,
  NewChangelogEntryButton,
} from "./changelog-form-dialog";
import { DeleteChangelogButton } from "./delete-changelog-button";
import { SeedChangelogButton } from "./seed-changelog-button";

export const metadata = { title: "Changelogs" };

// ---------------------------------------------------------------------------
// Cosmetic helpers — category and change-kind badge + icon mapping. Lives
// alongside the page so the card layout has direct access without crossing
// the RSC / client boundary. House-POV color rule does not apply here:
// changelog is informational, not financial.
//
// Categories follow the rule of thumb agreed in the task description:
//   feature      → emerald (positive, additive)
//   improvement  → blue    (positive, refinement)
//   fix          → amber   (warning-adjacent, drawing attention)
//   breaking     → rose    (loud, action-required signal)
//   infra        → neutral (gray — under-the-hood, not user-facing)
// ---------------------------------------------------------------------------

const CATEGORY_BADGE_CLASS: Record<ChangelogCategory, string> = {
  feature:
    "bg-emerald-500/15 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
  improvement:
    "bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400",
  fix: "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400",
  breaking:
    "bg-rose-500/15 text-rose-600 border-rose-500/30 dark:text-rose-400",
  infra:
    "bg-muted text-muted-foreground border-border",
};

const CATEGORY_ICON: Record<ChangelogCategory, LucideIcon> = {
  feature: Sparkles,
  improvement: Zap,
  fix: Wrench,
  breaking: AlertTriangle,
  infra: Server,
};

const CATEGORY_LABEL: Record<ChangelogCategory, string> = {
  feature: "Feature",
  improvement: "Improvement",
  fix: "Fix",
  breaking: "Breaking",
  infra: "Infra",
};

const CHANGE_KIND_ICON: Record<ChangelogChangeKind, LucideIcon> = {
  feature: Sparkles,
  improvement: Zap,
  fix: Wrench,
  breaking: AlertTriangle,
  infra: Server,
};

const CHANGE_KIND_COLOR: Record<ChangelogChangeKind, string> = {
  feature: "text-emerald-500",
  improvement: "text-blue-500",
  fix: "text-amber-500",
  breaking: "text-rose-500",
  infra: "text-muted-foreground",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function ChangelogsPage() {
  const session = await requirePageAccess("/changelogs");

  // Self-heal the table on every render — IF-NOT-EXISTS so this is a
  // no-op after the first hit on a given server process. Same pattern as
  // the employee board / salaries surfaces.
  await ensureChangelogSchema();

  const isAdmin = session.role === "admin";
  let canManage = isAdmin;
  if (!isAdmin) {
    const perms = await getUserPermissions(session.userId);
    canManage = hasCapability(perms, "__can_manage_changelog");
  }

  const [entries, stats] = await Promise.all([
    getChangelogEntries({ limit: 100 }),
    getChangelogStats(),
  ]);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ScrollText}
          accent="purple"
          title="Changelogs"
          subtitle="What's new in the admin panel and the platform."
          action={
            canManage ? (
              <div className="flex flex-wrap items-center gap-2">
                <SeedChangelogButton />
                <NewChangelogEntryButton />
              </div>
            ) : null
          }
        />
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiTile
          label="Total entries"
          value={formatNumber(stats.totalEntries)}
          icon={ScrollText}
          accent="purple"
        />
        <KpiTile
          label="This month"
          value={formatNumber(stats.thisMonthEntries)}
          icon={CalendarDays}
          accent="blue"
        />
        <KpiTile
          label="Last published"
          value={
            stats.lastPublishedAt ? formatRelative(stats.lastPublishedAt) : "—"
          }
          sub={
            stats.lastPublishedAt
              ? formatDate(stats.lastPublishedAt)
              : "No entries yet"
          }
          icon={Sparkles}
          accent="emerald"
        />
      </div>

      <SectionHeading icon={List} title="Releases" />

      {entries.length === 0 ? (
        <StatPanel title="No entries yet" icon={ScrollText} accent="purple">
          <EmptyState
            icon={ScrollText}
            title="No entries yet"
            description={
              canManage
                ? "Click + New entry to publish your first changelog."
                : "An admin will publish release notes here as the platform ships updates."
            }
            accent="purple"
          />
        </StatPanel>
      ) : (
        <FadeIn>
          <div className="space-y-4">
            {entries.map((entry) => (
              <ChangelogCard
                key={entry.id}
                entry={entry}
                canManage={canManage}
              />
            ))}
          </div>
        </FadeIn>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function ChangelogCard({
  entry,
  canManage,
}: {
  entry: ChangelogEntry;
  canManage: boolean;
}) {
  const CategoryIcon = CATEGORY_ICON[entry.category];
  return (
    <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70">
      {/* Hairline top highlight to match the modern-panel family. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"
      />
      <div className="relative p-4 sm:p-5 space-y-4">
        {/* Top row: date + version + category badge */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-muted-foreground">
            {formatDate(entry.publishedAt)}
          </span>
          {entry.version && (
            <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              <Tag className="size-3" />
              {entry.version}
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider",
              CATEGORY_BADGE_CLASS[entry.category],
            )}
          >
            <CategoryIcon className="size-3" />
            {CATEGORY_LABEL[entry.category]}
          </span>
        </div>

        {/* Title + summary */}
        <div className="space-y-1.5">
          <h3 className="text-lg font-semibold tracking-tight">{entry.title}</h3>
          {/* whitespace-pre-line so admin-written paragraphs preserve their
              own line breaks without being interpreted as markdown. */}
          <p className="whitespace-pre-line text-sm text-muted-foreground">
            {entry.summary}
          </p>
        </div>

        {/* Bullets */}
        {entry.changes.length > 0 && (
          <ul className="space-y-1.5">
            {entry.changes.map((change, idx) => {
              const Icon = CHANGE_KIND_ICON[change.kind];
              return (
                <li
                  key={idx}
                  className="flex items-start gap-2 text-sm"
                >
                  <Icon
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      CHANGE_KIND_COLOR[change.kind],
                    )}
                  />
                  <span className="min-w-0 flex-1">{change.text}</span>
                </li>
              );
            })}
          </ul>
        )}

        {/* Footer: author + admin actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3 text-xs text-muted-foreground">
          <span>
            {entry.author.username
              ? <>by <span className="font-medium text-foreground">{entry.author.username}</span></>
              : "by (unknown admin)"}
          </span>
          {canManage && (
            <div className="flex items-center gap-1">
              <EditChangelogEntryButton entry={entry} />
              <DeleteChangelogButton id={entry.id} title={entry.title} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
