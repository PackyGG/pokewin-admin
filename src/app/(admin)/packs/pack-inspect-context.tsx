"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { PackListItem } from "@/lib/queries/packs";

export type PackInspectSeed = {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  active: boolean;
  priceUsd: number;
  totalOpenings?: number;
  totalRevenue?: number;
  actualHouseEdge?: number;
};

type PackInspectContextValue = {
  activePackId: string | null;
  seed: PackInspectSeed | null;
  detailOpen: boolean;
  openDetail: (pack: PackListItem) => void;
  closeDetail: () => void;
  quickEditPack: PackListItem | null;
  quickEditOpen: boolean;
  openQuickEdit: (pack: PackListItem) => void;
  setQuickEditOpen: (open: boolean) => void;
  canToggle: boolean;
  canDelete: boolean;
  canEdit: boolean;
};

const PackInspectContext = React.createContext<PackInspectContextValue | null>(
  null,
);

const OPEN_DEBOUNCE_MS = 300;

function packToSeed(pack: PackListItem): PackInspectSeed {
  return {
    id: pack.id,
    name: pack.name,
    slug: pack.slug,
    imageUrl: pack.imageUrl,
    active: pack.active,
    priceUsd: pack.priceUsd,
    totalOpenings: pack.totalOpenings,
    totalRevenue: pack.totalRevenue,
    actualHouseEdge: pack.actualHouseEdge,
  };
}

export function PackInspectProvider({
  children,
  canToggle,
  canDelete,
  canEdit,
}: {
  children: React.ReactNode;
  canToggle: boolean;
  canDelete: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [activePackId, setActivePackId] = React.useState<string | null>(null);
  const [seed, setSeed] = React.useState<PackInspectSeed | null>(null);
  const [quickEditPack, setQuickEditPack] =
    React.useState<PackListItem | null>(null);
  const [quickEditOpen, setQuickEditOpen] = React.useState(false);

  const lastOpenRef = React.useRef<{ id: string; at: number } | null>(null);
  const seededFromUrlRef = React.useRef(false);

  const syncInspectUrl = React.useCallback(
    (nextId: string | null) => {
      const current = searchParams.get("inspect");
      if (nextId) {
        if (current === nextId) return;
      } else if (!current) {
        return;
      }
      const params = new URLSearchParams(searchParams.toString());
      if (nextId) params.set("inspect", nextId);
      else params.delete("inspect");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // Deep-link: seed local open state from ?inspect= once on mount / URL change.
  React.useEffect(() => {
    const urlInspect = searchParams.get("inspect");
    if (!urlInspect) {
      if (seededFromUrlRef.current && activePackId) return;
      return;
    }
    if (activePackId === urlInspect) return;
    setActivePackId(urlInspect);
    setSeed((prev) => (prev?.id === urlInspect ? prev : { id: urlInspect, name: "Loading…", slug: "", imageUrl: null, active: false, priceUsd: 0 }));
    seededFromUrlRef.current = true;
  }, [searchParams, activePackId]);

  const openDetail = React.useCallback(
    (pack: PackListItem) => {
      const now = Date.now();
      const last = lastOpenRef.current;
      if (
        last &&
        last.id === pack.id &&
        now - last.at < OPEN_DEBOUNCE_MS &&
        activePackId === pack.id
      ) {
        return;
      }
      lastOpenRef.current = { id: pack.id, at: now };

      if (activePackId === pack.id) return;

      setActivePackId(pack.id);
      setSeed(packToSeed(pack));
      syncInspectUrl(pack.id);
    },
    [activePackId, syncInspectUrl],
  );

  const closeDetail = React.useCallback(() => {
    setActivePackId(null);
    setSeed(null);
    syncInspectUrl(null);
  }, [syncInspectUrl]);

  const openQuickEdit = React.useCallback(
    (pack: PackListItem) => {
      if (quickEditOpen && quickEditPack?.id === pack.id) return;
      setQuickEditPack(pack);
      setQuickEditOpen(true);
    },
    [quickEditOpen, quickEditPack],
  );

  const value = React.useMemo<PackInspectContextValue>(
    () => ({
      activePackId,
      seed,
      detailOpen: activePackId != null,
      openDetail,
      closeDetail,
      quickEditPack,
      quickEditOpen,
      openQuickEdit,
      setQuickEditOpen,
      canToggle,
      canDelete,
      canEdit,
    }),
    [
      activePackId,
      seed,
      openDetail,
      closeDetail,
      quickEditPack,
      quickEditOpen,
      openQuickEdit,
      canToggle,
      canDelete,
      canEdit,
    ],
  );

  return (
    <PackInspectContext.Provider value={value}>
      {children}
    </PackInspectContext.Provider>
  );
}

export function usePackInspect(): PackInspectContextValue {
  const ctx = React.useContext(PackInspectContext);
  if (!ctx) {
    throw new Error("usePackInspect must be used within PackInspectProvider");
  }
  return ctx;
}
