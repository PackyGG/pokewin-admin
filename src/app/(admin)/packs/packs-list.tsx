"use client";

import * as React from "react";
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
import { useUrlParam } from "@/lib/entity-surface/use-url-state";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { toPercent } from "@/lib/house-pov";
import type { PackListItem } from "@/lib/queries/packs";
import { PackRowActions } from "./pack-row-actions";
import { PackGallery } from "./pack-gallery";
import { PackInspector } from "./pack-inspector";
import { PackQuickEdit } from "./pack-quick-edit";

/**
 * Client orchestrator for the rebuilt /packs list. Renders the dense, sortable
 * triage TABLE (default) or the art-browse GALLERY (one toggle away), and owns
 * the shared INSPECTOR (row preview, deep-linked via `?inspect=`) + the
 * QUICK-EDIT drawer (price + active). The server decides which view to render
 * via the `view` prop (read from `?view=`), so there's no wrong-view flash; the
 * inspector/quick-edit are pure client overlays that never lose list context.
 *
 * Capability gating (canToggle / canDelete / canEdit) is computed server-side
 * and passed down so the action surface matches what the server actions allow.
 */
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
  /** Viewer can open the quick-edit drawer (edit price). */
  canEdit: boolean;
}) {
  // Inspector target lives in the URL so a preview deep-links + survives reload.
  const [inspectId, setInspectId] = useUrlParam("inspect");
  // Quick-edit is transient client state (an edit, not a shareable view).
  const [quickEditPack, setQuickEditPack] =
    React.useState<PackListItem | null>(null);
  const [quickEditOpen, setQuickEditOpen] = React.useState(false);

  // Resolve the inspected pack from the current page's rows. If the id points
  // at a pack not on this page (e.g. a stale deep link after filtering), the
  // inspector simply renders nothing rather than crash.
  const inspectedPack = React.useMemo(
    () => (inspectId ? (data.find((p) => p.id === inspectId) ?? null) : null),
    [data, inspectId],
  );

  const openInspector = React.useCallback(
    (pack: PackListItem) => setInspectId(pack.id),
    [setInspectId],
  );
  const closeInspector = React.useCallback(
    (open: boolean) => {
      if (!open) setInspectId(null);
    },
    [setInspectId],
  );

  const openQuickEdit = React.useCallback((pack: PackListItem) => {
    setQuickEditPack(pack);
    setQuickEditOpen(true);
  }, []);

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
        // Revenue is money INTO the house → always emerald (House-POV), same
        // as the detail KPI tile. Fixed +1 sign so the column reads green even
        // at $0 (it's the house-gain column), matching everywhere.
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
        // Payout is money OUT to players → always rose (House-POV), same as
        // the detail KPI tile. Fixed -1 sign (house-loss column).
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
        // House edge: positive = house up → emerald, negative = rose. A pack
        // with no openings has a meaningless stored 0 — render it muted, not a
        // misleading emerald 0.0% (mirrors the RTP column's no-opens handling).
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
              canQuickEdit={canEdit}
              onQuickEdit={openQuickEdit}
              size="sm"
            />
          </div>
        ),
      },
    ],
    [canToggle, canDelete, canEdit, openQuickEdit],
  );

  return (
    <>
      {view === "grid" ? (
        <PackGallery
          data={data}
          canToggle={canToggle}
          canDelete={canDelete}
          canQuickEdit={canEdit}
          onOpenInspector={openInspector}
          onQuickEdit={openQuickEdit}
          activeId={inspectId || null}
        />
      ) : (
        <EntityTable
          rows={data}
          columns={columns}
          rowKey={(p) => p.id}
          onRowClick={openInspector}
          activeRowKey={inspectId || null}
          emptyState={
            <EmptyState
              icon={Package}
              title="No packs match your filters"
              description="Try a different search or status filter."
              compact
            />
          }
        />
      )}

      <PackInspector
        pack={inspectedPack}
        open={Boolean(inspectId) && inspectedPack != null}
        onOpenChange={closeInspector}
      />

      <PackQuickEdit
        pack={quickEditPack}
        open={quickEditOpen}
        onOpenChange={setQuickEditOpen}
        canTogglePack={canToggle}
      />
    </>
  );
}
