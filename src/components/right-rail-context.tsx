"use client";

import * as React from "react";

import {
  railCookieWriteString,
  type RailKey,
} from "@/lib/right-rail-cookie";

type RailState = Record<RailKey, boolean>;

type RightRailState = {
  open: RailState;
  mounted: RailState;
  setOpen: (key: RailKey, open: boolean) => void;
};

const STORAGE_KEYS: Record<RailKey, string> = {
  alerts: "docked-alerts:open",
};

const DEFAULT_OPEN: RailState = {
  alerts: false,
};

const RightRailCtx = React.createContext<RightRailState | null>(null);

function writeStoredState(state: RailState): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEYS.alerts, state.alerts ? "1" : "0");
  document.cookie = railCookieWriteString(state.alerts ? ["alerts"] : []);
}

export function RightRailProvider({
  children,
  mounted,
  initialOpenOrder,
}: {
  children: React.ReactNode;
  mounted?: Partial<RailState>;
  initialOpenOrder?: RailKey[] | null;
}) {
  const resolvedMounted = React.useMemo<RailState>(
    () => ({ alerts: mounted?.alerts ?? true }),
    [mounted?.alerts],
  );
  const [open, setOpenState] = React.useState<RailState>(() => ({
    alerts: initialOpenOrder?.includes("alerts") ?? DEFAULT_OPEN.alerts,
  }));

  React.useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEYS.alerts);
    if (stored !== "0" && stored !== "1") return;
    const storedOpen = stored === "1";
    setOpenState((current) =>
      current.alerts === storedOpen ? current : { alerts: storedOpen },
    );
    document.cookie = railCookieWriteString(storedOpen ? ["alerts"] : []);
  }, []);

  const setOpen = React.useCallback((key: RailKey, next: boolean) => {
    setOpenState((current) => {
      if (current[key] === next) return current;
      const updated = { ...current, [key]: next };
      writeStoredState(updated);
      return updated;
    });
  }, []);

  const effectiveOpen = React.useMemo<RailState>(
    () => ({ alerts: resolvedMounted.alerts && open.alerts }),
    [open.alerts, resolvedMounted.alerts],
  );

  const value = React.useMemo<RightRailState>(
    () => ({ open: effectiveOpen, mounted: resolvedMounted, setOpen }),
    [effectiveOpen, resolvedMounted, setOpen],
  );

  return <RightRailCtx.Provider value={value}>{children}</RightRailCtx.Provider>;
}

export function useRailWidget(key: RailKey): {
  open: boolean;
  setOpen: (open: boolean) => void;
  allOpen: RailState;
  mounted: RailState;
} {
  const context = React.useContext(RightRailCtx);
  if (!context) {
    return {
      open: DEFAULT_OPEN[key],
      setOpen: () => {},
      allOpen: DEFAULT_OPEN,
      mounted: { alerts: true },
    };
  }
  return {
    open: context.open[key],
    setOpen: (open) => context.setOpen(key, open),
    allOpen: context.open,
    mounted: context.mounted,
  };
}

export function railSlotStyle(
  key: RailKey,
  allOpen: RailState,
  mounted: RailState = { alerts: true },
): React.CSSProperties {
  if (!mounted[key]) return { display: "none" };
  return allOpen[key]
    ? { top: "5rem", bottom: "1.5rem" }
    : { top: "5rem", height: "8rem" };
}
