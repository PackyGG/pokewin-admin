import { Suspense } from "react";
import { Anchor, Activity, Package } from "lucide-react";
import { requirePageAccess, getUserPermissions } from "@/lib/dal";
import type { SessionPayload } from "@/lib/session";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { ensurePackCreatorCapabilities } from "@/lib/pack-creator/ensure-capabilities";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import {
  KpiStripSkeleton,
  TableSkeleton,
  ChartSkeleton,
} from "@/components/loading-skeletons";
import { safeQuery, safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { getPacks } from "@/lib/queries/packs";
import { getOnePiecePackTrend } from "@/lib/queries/one-piece-trend";
import { PacksKpiStrip } from "@/app/(admin)/packs/packs-kpi-strip";
import { PacksList } from "@/app/(admin)/packs/packs-list";
import { OnePieceTrendChart } from "./_components/one-piece-trend-chart";

export const metadata = { title: "One Piece" };

type PackCaps = { canToggle: boolean; canDelete: boolean; canEdit: boolean };

/**
 * Resolve pack-management capabilities for the One Piece pack list — mirrors
 * the /packs Catalog tab so the row actions behave identically. Admins bypass;
 * non-admins read their effective capabilities (Admin-DB blip degrades to "no
 * capabilities" rather than crashing the section).
 */
async function resolvePackCaps(session: SessionPayload): Promise<PackCaps> {
  await ensurePackCreatorCapabilities();
  if (session.role === "admin") {
    return { canToggle: true, canDelete: true, canEdit: true };
  }
  const { data: perms } = await safeQuery(
    () => getUserPermissions(session.userId),
    [] as string[],
    "one-piece.packs.perms",
  );
  return {
    canToggle: hasCapability(perms, "__can_toggle_pack_active"),
    canDelete: hasCapability(perms, "__can_delete_pack"),
    canEdit: hasCapability(perms, "__can_update_pack"),
  };
}

export default async function OnePiecePage() {
  const session = await requirePageAccess("/one-piece");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Anchor}
          accent="amber"
          title="One Piece"
          subtitle="The One Piece pack pool: lifetime economics, per-pack insights and a 30-day opens & revenue trend."
        />
      </PageHero>

      {/* Lifetime pool KPIs (own boundary). */}
      <Suspense fallback={<KpiStripSkeleton count={5} />}>
        <PacksKpiStrip activeSet="onepiece" />
      </Suspense>

      {/* Daily trend (own boundary). */}
      <div>
        <SectionHeading icon={Activity} title="Daily opens & revenue (30d)" />
        <div className="mt-3">
          <Suspense fallback={<ChartSkeleton height={320} />}>
            <TrendBody />
          </Suspense>
        </div>
      </div>

      {/* All One Piece packs (own boundary). */}
      <div>
        <SectionHeading icon={Package} title="All One Piece packs" />
        <div className="mt-3">
          <Suspense fallback={<TableSkeleton rows={6} columns={6} />}>
            <PacksBody session={session} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

async function TrendBody() {
  const { data: trend } = await safeQueryOrNull(
    () => getOnePiecePackTrend(),
    "one-piece.trend",
    15_000,
  );

  if (!trend) {
    return (
      <div className="rounded-xl border bg-muted/20 p-6 text-sm text-muted-foreground">
        Trend data is temporarily unavailable. Refresh in a moment.
      </div>
    );
  }

  if (trend.packCount === 0) {
    return (
      <div className="rounded-xl border bg-muted/20 p-6 text-sm text-muted-foreground">
        No packs are assigned to the One Piece pool yet.
      </div>
    );
  }

  return (
    <FadeIn>
      <div className="rounded-2xl border bg-card p-4">
        <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <span className="tabular-nums">
            {formatNumber(trend.totalOpens)} opens
            <span className="text-muted-foreground/70"> · {trend.windowDays}d</span>
          </span>
          <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
            {formatCurrency(trend.totalRevenue)} revenue
          </span>
          <span className="tabular-nums">
            {formatNumber(trend.packCount)} packs in pool
          </span>
        </div>
        <OnePieceTrendChart data={trend.daily} />
      </div>
    </FadeIn>
  );
}

async function PacksBody({ session }: { session: SessionPayload }) {
  const caps = await resolvePackCaps(session);
  const { data: result } = await safeQueryOrNull(
    () =>
      getPacks({
        set: "onepiece",
        perPage: 100,
        sortBy: "total_revenue",
        sortOrder: "desc",
      }),
    "one-piece.packs",
    15_000,
  );

  if (!result || result.data.length === 0) {
    return (
      <div className="rounded-xl border bg-muted/20 p-6 text-sm text-muted-foreground">
        No One Piece packs found.
      </div>
    );
  }

  return (
    <FadeIn>
      <PacksList
        data={result.data}
        view="table"
        canToggle={caps.canToggle}
        canDelete={caps.canDelete}
        canEdit={caps.canEdit}
      />
    </FadeIn>
  );
}
