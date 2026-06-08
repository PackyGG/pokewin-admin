"use client";

import * as React from "react";

import type { PlannedLeversV2 } from "./_model-v2";
import { sanitizeLeversV2 } from "./_model-v2";

const STORAGE_KEY = "edge-plan-2:presets:v1";

export type SavedConfigV2 = {
  id: string;
  name: string;
  levers: PlannedLeversV2;
  updatedAt: string;
};

export function usePlannerPresetsV2() {
  const [configs, setConfigs] = React.useState<SavedConfigV2[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { configs?: SavedConfigV2[]; activeId?: string };
      setConfigs(Array.isArray(parsed.configs) ? parsed.configs : []);
      setActiveId(parsed.activeId ?? null);
    } catch {
      /* ignore */
    }
  }, []);

  const persist = React.useCallback((next: SavedConfigV2[], active: string | null) => {
    setConfigs(next);
    setActiveId(active);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ configs: next, activeId: active }));
  }, []);

  const save = React.useCallback(
    (name: string, levers: PlannedLeversV2) => {
      const id = crypto.randomUUID();
      const row: SavedConfigV2 = {
        id,
        name,
        levers: sanitizeLeversV2(levers),
        updatedAt: new Date().toISOString(),
      };
      persist([row, ...configs], id);
      return id;
    },
    [configs, persist],
  );

  const load = React.useCallback(
    (id: string) => {
      setActiveId(id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ configs, activeId: id }));
      return configs.find((c) => c.id === id)?.levers ?? null;
    },
    [configs],
  );

  const activeConfig = configs.find((c) => c.id === activeId) ?? null;

  return { configs, activeConfig, save, load, setActiveId: (id: string | null) => persist(configs, id) };
}
