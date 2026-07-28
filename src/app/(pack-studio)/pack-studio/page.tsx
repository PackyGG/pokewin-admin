import { Suspense } from "react";
import type * as React from "react";
import {
  ArrowUpRight,
  Layers3,
  LayoutDashboard,
  Package,
  PackageOpen,
  Sparkles,
  Stethoscope,
  Wand2,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { SectionHeadingSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { isOwner } from "@/lib/owners";
import { isPackStudioRetuneOperator } from "@/lib/reprice-access";
import { PackStudioOverviewContent } from "./_components/overview-content";

export const metadata = { title: "Overview" };

/**
 * Pack Studio — Overview. Read-only risk & compliance dashboard.
 *
 * Shell-first: the shell paints immediately, then the heavy snapshot-derived
 * KPIs / alerts / histogram stream in behind a <Suspense> boundary whose
 * fallback is the same skeleton `loading.tsx` renders.
 *
 * PERF: this used to `await readPackSystemConfig()` here to label a ramp-phase
 * badge on the hero — an ADMIN round-trip on the critical path before ANY
 * pixel. It bought nothing: the de-boxed `PageHeroIdentity` no longer renders
 * `icon` / `title` / `subtitle` / `badges` at all (it returns null without a
 * `back` or `action`), so the awaited value was formatted and then dropped.
 * The ramp phase is still shown — in the streamed "Ramp phase" panel, off the
 * cached base read that was already loading it.
 */
export default async function PackStudioOverviewPage() {
  const session = await requirePackStudioPageAccess();
  const viewerIsOwner = isOwner(session);
  const viewerIsRetuneOperator = isPackStudioRetuneOperator(session);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={LayoutDashboard}
          accent="purple"
          title="Pack Studio"
          subtitle="Design, audit, and tune packs and cards in one workspace."
        />
      </PageHero>

      {/* Quick actions — static, role-aware jump-offs into the Studio's core
          flows (build → review → tune). Rendered on the shell so they paint
          immediately, before the snapshot KPIs stream in. */}
      <QuickActions
        showRetune={viewerIsRetuneOperator}
        showQueue={viewerIsOwner}
      />

      <Suspense fallback={<OverviewFallback />}>
        <PackStudioOverviewContent />
      </Suspense>
    </div>
  );
}

type QuickAction = {
  label: string;
  sub: string;
  href: string;
  icon: React.ElementType;
  iconTint: string;
};

/**
 * Flat quick-link tiles (per the app-wide flat standard: neutral card fill,
 * accent only on the icon). Retune / Approval Queue links appear only for
 * viewers who can actually enter those surfaces — same visibility rules the
 * sidebar applies, so a click never bounces.
 */
function QuickActions({
  showRetune,
  showQueue,
}: {
  showRetune: boolean;
  showQueue: boolean;
}) {
  const actions: QuickAction[] = [
    {
      label: "Pack Builder",
      sub: "Design a new pack",
      href: "/pack-studio/builder",
      icon: Wand2,
      iconTint: "text-violet-500",
    },
    {
      label: "Pack Doctor",
      sub: "Audit fleet health",
      href: "/pack-studio/doctor",
      icon: Stethoscope,
      iconTint: "text-cyan-500",
    },
    ...(showRetune
      ? [
          {
            label: "Retune",
            sub: "Plan & push changes",
            href: "/pack-studio/retune",
            icon: Sparkles,
            iconTint: "text-amber-500",
          },
        ]
      : []),
    ...(showQueue
      ? [
          {
            label: "Approval Queue",
            sub: "Review pack requests",
            href: "/pack-studio/new-packs",
            icon: PackageOpen,
            iconTint: "text-emerald-500",
          },
        ]
      : []),
    {
      label: "Packs",
      sub: "Browse the catalog",
      href: "/pack-studio/packs",
      icon: Package,
      iconTint: "text-blue-500",
    },
    {
      label: "Cards",
      sub: "Browse the card pool",
      href: "/pack-studio/cards",
      icon: Layers3,
      iconTint: "text-rose-500",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {actions.map((a) => {
        const Icon = a.icon;
        return (
          <HostLink
            key={a.href}
            href={a.href}
            className="group flex items-start gap-3 rounded-xl border bg-card p-3.5 transition-colors hover:bg-muted/50"
          >
            <Icon className={`mt-0.5 size-4 shrink-0 ${a.iconTint}`} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-1 text-sm font-medium">
                <span className="truncate">{a.label}</span>
                <ArrowUpRight
                  className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                  aria-hidden
                />
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {a.sub}
              </span>
            </span>
          </HostLink>
        );
      })}
    </div>
  );
}

/**
 * Suspense fallback for the overview content (no hero — the page shell already
 * paints it). Mirrors the eventual layout: a 6-tile KPI strip, a two-up
 * ramp/chart row, and a compliance-alert grid.
 */
function OverviewFallback() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={200} action />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-xl" />
          ))}
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-[200px] rounded-2xl" />
        <Skeleton className="h-[200px] rounded-2xl" />
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} action />
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[120px] rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
