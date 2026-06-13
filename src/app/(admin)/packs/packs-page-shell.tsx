"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { PackInspectProvider, usePackInspect } from "./pack-inspect-context";
import { PackQuickEdit } from "./pack-quick-edit";

const PackDetailModal = dynamic(
  () =>
    import("./pack-detail-modal").then((m) => ({ default: m.PackDetailModal })),
  { ssr: false },
);

function PackOverlaysInner({
  canToggle,
  canDelete,
  canEdit,
  canEditLive,
  isPackCreator,
}: {
  canToggle: boolean;
  canDelete: boolean;
  canEdit: boolean;
  canEditLive: boolean;
  isPackCreator: boolean;
}) {
  const {
    activePackId,
    seed,
    detailOpen,
    closeDetail,
    quickEditPack,
    quickEditOpen,
    setQuickEditOpen,
  } = usePackInspect();

  return (
    <>
      <PackDetailModal
        packId={activePackId}
        seed={seed}
        open={detailOpen}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
        canToggle={canToggle}
        canDelete={canDelete}
        canEdit={canEdit}
        canEditLive={canEditLive}
        isPackCreator={isPackCreator}
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

export function PacksPageShell({
  children,
  canToggle,
  canDelete,
  canEdit,
  canEditLive,
  isPackCreator,
}: {
  children: React.ReactNode;
  canToggle: boolean;
  canDelete: boolean;
  canEdit: boolean;
  canEditLive: boolean;
  isPackCreator: boolean;
}) {
  return (
    <PackInspectProvider
      canToggle={canToggle}
      canDelete={canDelete}
      canEdit={canEdit}
    >
      {children}
      <PackOverlaysInner
        canToggle={canToggle}
        canDelete={canDelete}
        canEdit={canEdit}
        canEditLive={canEditLive}
        isPackCreator={isPackCreator}
      />
    </PackInspectProvider>
  );
}
