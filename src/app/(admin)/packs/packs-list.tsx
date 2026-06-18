"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Package } from "lucide-react";
import {
  EntityTable,
  EmptyState,
  ValueCell,
  EntityNameCell,
  ActiveBadge,
  type EntityColumn,
  type EntityView,
} from "@/components/entity-surface";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { toPercent } from "@/lib/house-pov";
import type { PackListItem } from "@/lib/queries/packs";
import { PackRowActions } from "./pack-row-actions";
import { PackGallery } from "./pack-gallery";

export function PacksList({
  data,
  view,
  canToggle,
  canDelete,
  canEdit,
}: {
  data: PackListItem[];
  view: EntityView;
  canToggle: boolean;
  canDelete: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();

  const openPack = React.useCallback(
    (pack: PackListItem) => {
      router.push(`/packs/${pack.id}`);
    },
    [router],
  );

  const columns = React.useMemo<EntityColumn<PackListItem>[]>(
    () => [
      {
        id: "pack",
        header: "Pack",
        sortKey: "name",
        width: "30%",
        cell: (p) => (
          <EntityNameCell
            imageUrl={p.imageUrl}
            name={p.name}
            secondary={p.slug}
            badge={<ActiveBadge active={p.active} size="sm" />}
          />
        ),
      },
      {
        id: "price",
        header: "Price",
        sortKey: "price",
        align: "right",
        hideBelow: "sm",
        cell: (p) => <ValueCell>{formatCurrency(p.priceUsd)}</ValueCell>,
      },
      {
        id: "opens",
        header: "Opens",
        sortKey: "total_openings",
        align: "right",
        cell: (p) => <ValueCell>{formatNumber(p.totalOpenings)}</ValueCell>,
      },
      {
        id: "revenue",
        header: "Revenue",
        sortKey: "total_revenue",
        align: "right",
        cell: (p) => (
          <ValueCell houseAmount={1}>
            {formatCurrency(p.totalRevenue)}
          </ValueCell>
        ),
      },
      {
        id: "payout",
        header: "Payout",
        sortKey: "total_payout",
        align: "right",
        hideBelow: "md",
        cell: (p) => (
          <ValueCell houseAmount={-1}>
            {formatCurrency(p.totalPayout)}
          </ValueCell>
        ),
      },
      {
        id: "rtp",
        header: "RTP",
        sortKey: "actual_rtp",
        align: "right",
        hideBelow: "lg",
        cell: (p) =>
          p.totalOpenings === 0 ? (
            <ValueCell muted>—</ValueCell>
          ) : (
            <ValueCell>{`${toPercent(p.actualRtp).toFixed(1)}%`}</ValueCell>
          ),
      },
      {
        id: "edge",
        header: "Edge",
        sortKey: "actual_house_edge",
        align: "right",
        cell: (p) =>
          p.totalOpenings === 0 ? (
            <ValueCell muted>—</ValueCell>
          ) : (
            <ValueCell houseAmount={toPercent(p.actualHouseEdge)}>
              {`${toPercent(p.actualHouseEdge).toFixed(1)}%`}
            </ValueCell>
          ),
      },
      {
        id: "actions",
        header: "",
        align: "right",
        width: "44px",
        noTruncate: true,
        cell: (p) => (
          <div className="flex justify-end">
            <PackRowActions
              pack={p}
              canToggle={canToggle}
              canDelete={canDelete}
              canEdit={canEdit}
              size="sm"
            />
          </div>
        ),
      },
    ],
    [canToggle, canDelete, canEdit],
  );

  return view === "grid" ? (
    <PackGallery
      data={data}
      canToggle={canToggle}
      canDelete={canDelete}
      canEdit={canEdit}
      onOpenPack={openPack}
    />
  ) : (
    <EntityTable
      rows={data}
      columns={columns}
      rowKey={(p) => p.id}
      onRowClick={openPack}
      rowHref={(p) => `/packs/${p.id}`}
      emptyState={
        <EmptyState
          icon={Package}
          title="No packs match your filters"
          description="Try a different search or status filter."
          compact
        />
      }
    />
  );
}
