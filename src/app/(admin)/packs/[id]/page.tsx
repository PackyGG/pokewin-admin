import { notFound } from "next/navigation";
import {
  Package,
  DollarSign,
  Coins,
  Percent,
  TrendingUp,
  Layers,
  Boxes,
} from "lucide-react";
import { BackButton } from "@/components/back-button";
import { getPackDetail, getPackStats, getPackGames } from "@/lib/queries/packs";
import { getUserPermissions, requirePageAccess } from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { ensurePackCreatorCapabilities } from "@/lib/pack-creator/ensure-capabilities";
import { Badge } from "@/components/ui/badge";
import { CardImage } from "@/components/card-image";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { PackTabs } from "./pack-tabs";
import { PackStatsSection } from "./revenue-chart";
import { TogglePackButton } from "./toggle-pack-button";
import { EditPackButton } from "./edit-pack-button";
import { DeletePackButton } from "./delete-pack-button";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Pack Detail" };

export default async function PackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePageAccess("/packs");
  const { id } = await params;
  const data = await getPackDetail(id);
  if (!data) notFound();

  // Idempotent back-fill (no-op after the first run per process):
  // ensures existing pack_creator users have __can_update_pack so
  // they can iterate on demo packs after saving. Mirrors the call
  // from /packs/page.tsx — pack_creators sometimes land directly on
  // a detail page via the post-create redirect.
  await ensurePackCreatorCapabilities();

  // Gate the action buttons by capability so restricted roles (e.g.
  // pack_creator) don't see ghost buttons that error on click. Real
  // admins always pass; non-admins need the explicit __can_* keys.
  const isAdmin = session.role === "admin";
  let canToggle = isAdmin;
  let canEdit = isAdmin;
  let canDelete = isAdmin;
  if (!isAdmin) {
    const perms = await getUserPermissions(session.userId);
    canToggle = hasCapability(perms, "__can_toggle_pack_active");
    canEdit = hasCapability(perms, "__can_update_pack");
    canDelete = hasCapability(perms, "__can_delete_pack");
  }
  // Pack creators only get to edit packs while they're still in the
  // demo (inactive) state. Once a pack is live, only full admins can
  // edit it. Mirrors the server-side gate in updatePack so the UI
  // doesn't dangle a button that 500s on click.
  const showEditButton =
    canEdit && (isAdmin || session.role !== "pack_creator" || !data.active);

  const [packStats, initialGames] = await Promise.all([
    getPackStats(id, data.priceUsd, {
      totalPayout: data.totalPayout,
      actualRtp: data.actualRtp,
    }),
    getPackGames(id, 1, 20),
  ]);

  // RTP computed from actual revenue/payout data, not DB pre-computed field
  const rtp = packStats.rtp;
  const houseEdge = packStats.houseEdge;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-start gap-3 sm:gap-4 flex-wrap">
          <BackButton />
          <div className="shrink-0 hidden md:block">
            <CardImage
              src={data.imageUrl}
              alt={data.name}
              className="h-20 w-auto rounded-lg"
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-bold leading-tight truncate">{data.name}</h1>
              <Badge
                variant="outline"
                className={
                  data.active
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                    : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                }
              >
                {data.active ? "Active" : "Inactive"}
              </Badge>
              <Badge variant="outline">{data.packType}</Badge>
            </div>
            <p className="font-mono text-xs text-muted-foreground mt-0.5 truncate">{data.slug}</p>
          </div>
          {(canToggle || showEditButton || canDelete) && (
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 w-full sm:w-auto">
              {canToggle && (
                <TogglePackButton packId={data.id} active={data.active} />
              )}
              {showEditButton && <EditPackButton pack={data} />}
              {canDelete && (
                <DeletePackButton packId={data.id} packName={data.name} />
              )}
            </div>
          )}
        </div>
      </PageHero>

      {/* KPI strip — 8 stats so we go 2/4/8 across the breakpoints. */}
      <div className="grid gap-2.5 sm:gap-4 grid-cols-2 md:grid-cols-4 lg:grid-cols-8">
        <KpiTile
          label="Price"
          value={formatCurrency(data.priceUsd)}
          icon={DollarSign}
          accent="blue"
        />
        <KpiTile
          label="Openings"
          value={formatNumber(packStats.openings.all)}
          icon={Package}
          accent="cyan"
        />
        {/* Revenue = what users paid to open this pack (house gain,
            emerald). Payout = card value we handed back (house loss,
            rose). Per CLAUDE.md house-POV coloring. */}
        <KpiTile
          label="Revenue"
          value={formatCurrency(packStats.revenue.all)}
          icon={TrendingUp}
          accent="emerald"
        />
        <KpiTile
          label="Payout"
          value={formatCurrency(packStats.payout.all)}
          icon={Coins}
          accent="rose"
        />
        <KpiTile
          label="RTP"
          value={`${(rtp * 100).toFixed(2)}%`}
          icon={Percent}
          accent={rtp > 1 ? "rose" : "purple"}
        />
        <KpiTile
          label="House Edge"
          value={`${(houseEdge * 100).toFixed(2)}%`}
          icon={TrendingUp}
          accent={houseEdge < 0 ? "rose" : "emerald"}
        />
        <KpiTile
          label="Cards/Open"
          value={String(data.cardsPerOpen)}
          icon={Layers}
          accent="pink"
        />
        <KpiTile
          label="Total Cards"
          value={String(data.cards.length)}
          icon={Boxes}
          accent="orange"
        />
      </div>

      <FadeIn>
        <PackStatsSection stats={packStats} />
      </FadeIn>

      <PackTabs data={data} initialGames={initialGames} />
    </div>
  );
}
