import { Suspense } from "react";
import { Gem, Layers, Power, Coins } from "lucide-react";
import { getShardPacks } from "@/lib/queries/packs";
import { formatNumber } from "@/lib/utils/format";
import {
  getUserPermissions,
  requirePageAccess,
} from "@/lib/dal";
import { ensurePackCreatorCapabilities } from "@/lib/pack-creator/ensure-capabilities";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { TableSkeleton } from "@/components/loading-skeletons";
import { parseShardStatsPeriod } from "@/lib/queries/shard-stats";
import { CreateShardPackButton } from "./create-shard-pack-button";
import { ShardsList } from "./shards-list";
import { ShardStatsSection } from "./shard-stats-section";

export const metadata = { title: "Shard Packs" };

async function ShardsContent({
  canEdit,
  canToggle,
  canDelete,
}: {
  canEdit: boolean;
  canToggle: boolean;
  canDelete: boolean;
}) {
  const { data: result } = await safeQuery(
    () => getShardPacks(),
    null,
    "rewards.shards.list",
  );

  if (!result) {
    return (
      <TileErrorFallback
        label="Shard packs"
        hint="The read failed — no shard pack was changed. Try again."
        size="panel"
      />
    );
  }

  return (
    <>
      {/* KPI strip — neutral config metrics (no money P&L on this surface;
          shard_cost is a shard-currency cost, not USD). */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Shard packs"
          value={formatNumber(result.total)}
          icon={Gem}
          accent="purple"
        />
        <KpiTile
          label="Active"
          value={formatNumber(result.activeCount)}
          sub={`${formatNumber(result.total - result.activeCount)} inactive`}
          icon={Power}
          accent="emerald"
        />
        <KpiTile
          label="Cards in pools"
          value={formatNumber(result.totalCards)}
          icon={Layers}
          accent="cyan"
        />
        <KpiTile
          label="Avg shard cost"
          value={formatNumber(result.avgShardCost)}
          sub="shards"
          icon={Coins}
          accent="amber"
        />
      </div>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Gem} title="Shard packs" />
          <ShardsList
            packs={result.packs}
            canEdit={canEdit}
            canToggle={canToggle}
            canDelete={canDelete}
          />
        </div>
      </FadeIn>
    </>
  );
}

export default async function ShardPacksPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const session = await requirePageAccess("/rewards/shards");

  // Active-timeframe-only: parse the single active window from the URL so
  // the stats section fetches ONLY that window (no eager preload of the
  // other timeframes — see CLAUDE.md "Performance & Daten-Laden").
  const { period: periodParam } = await searchParams;
  const period = parseShardStatsPeriod(periodParam);

  // Idempotent runtime back-fill: grants existing pack_creator users
  // /rewards/shards (and pack capabilities) before permission read.
  await ensurePackCreatorCapabilities();

  // Per-capability gating mirrors /packs: real admins always pass; everyone
  // else is gated on the same pack capabilities (the shared pack actions
  // re-enforce these server-side, so this only governs which buttons render).
  const isAdmin = session.role === "admin";
  let canEdit = isAdmin;
  let canToggle = isAdmin;
  let canDelete = isAdmin;
  let canCreate = isAdmin;
  if (!isAdmin) {
    const { data: perms } = await safeQuery(
      () => getUserPermissions(session.userId),
      [] as string[],
      "rewards.shards.perms",
    );
    canCreate = hasCapability(perms, "__can_create_pack");
    canEdit = hasCapability(perms, "__can_update_pack");
    canToggle = hasCapability(perms, "__can_toggle_pack_active");
    canDelete = hasCapability(perms, "__can_delete_pack");
  }

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Gem}
          accent="purple"
          title="Shard Packs"
          subtitle="Packs players buy & open with shards (a wager-earned currency). They free-roll cards into inventory like reward packs."
          action={canCreate ? <CreateShardPackButton /> : undefined}
        />
      </PageHero>

      <div className="space-y-6">
        <Suspense
          fallback={
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-[72px] animate-pulse rounded-xl border bg-muted/30"
                  />
                ))}
              </div>
              <TableSkeleton rows={6} columns={5} />
            </>
          }
        >
          <ShardsContent
            canEdit={canEdit}
            canToggle={canToggle}
            canDelete={canDelete}
          />
        </Suspense>

        {/* Coin/shard economy usage stats. Its own period-keyed Suspense
            boundary so switching the window streams just the active
            window's read without blocking (or re-fetching) the pack list
            above. */}
        <Suspense
          key={period}
          fallback={
            <div className="space-y-3">
              <div className="h-9 w-40 animate-pulse rounded-lg bg-muted/30" />
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-[72px] animate-pulse rounded-xl border bg-muted/30"
                  />
                ))}
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-48 animate-pulse rounded-2xl border bg-muted/30"
                  />
                ))}
              </div>
            </div>
          }
        >
          <ShardStatsSection period={period} />
        </Suspense>
      </div>
    </div>
  );
}
