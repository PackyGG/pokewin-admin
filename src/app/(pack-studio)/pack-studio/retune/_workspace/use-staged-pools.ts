"use client";

import * as React from "react";

import type { StagedPool } from "./plan-state";

/**
 * Staged-pool store: the per-pack staged pools (D2's persistence steal).
 *
 * Facts only — the map holds a `StagedPool` for every pack the operator has
 * EDITED this session (lazily created on first edit; ANY entry ⇒ staged arm).
 * Dirty entries mirror to `sessionStorage` so staged work survives rail
 * navigation, tab reloads and the post-push `router.refresh()` remount — the
 * V1 "i have to redo this over and over" complaint.
 *
 * Rehydrated entries are NOT trusted blindly: the hook reports which packIds
 * came from storage (`rehydratedIds`) so the workspace can run the F17 drift
 * check (`baseFingerprint` vs the fresh live pool) before reusing them.
 *
 * A ref mirror (`getStaged`) gives async callbacks (debounced re-plans,
 * write dispatch) the LATEST staged facts without stale-closure races.
 */

const STORAGE_KEY = "pack-studio.retune.staged.v1";

type PersistedMap = Record<string, StagedPool>;

function readStorage(): PersistedMap {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    return parsed as PersistedMap;
  } catch {
    return {};
  }
}

function writeStorage(map: Map<string, StagedPool>): void {
  try {
    if (map.size === 0) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    const out: PersistedMap = {};
    for (const [packId, pool] of map) out[packId] = pool;
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    /* storage full / unavailable — staged edits stay in-memory only */
  }
}

export type StagedPoolsApi = {
  /** Reactive map — render from this. */
  stagedByPack: Map<string, StagedPool>;
  /** Latest-value accessor for async callbacks (never stale). */
  getStaged: (packId: string) => StagedPool | null;
  /** Create/replace a staged entry (persists). */
  setStaged: (packId: string, pool: StagedPool) => void;
  /** Drop a staged entry (+ its sessionStorage mirror). */
  clearStaged: (packId: string) => void;
  /** PackIds whose entry came from sessionStorage and awaits the F17 check. */
  rehydratedIds: Set<string>;
  /** Mark a rehydrated entry as reconciled (kept or discarded). */
  resolveRehydrated: (packId: string) => void;
};

export function useStagedPools(): StagedPoolsApi {
  const [stagedByPack, setStagedByPack] = React.useState<Map<string, StagedPool>>(
    () => new Map(),
  );
  const [rehydratedIds, setRehydratedIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const mapRef = React.useRef(stagedByPack);
  mapRef.current = stagedByPack;

  // Rehydrate AFTER mount (sessionStorage is browser-only; reading it in the
  // initial render would mismatch the SSR markup).
  React.useEffect(() => {
    const persisted = readStorage();
    const ids = Object.keys(persisted);
    if (ids.length === 0) return;
    setStagedByPack((prev) => {
      const next = new Map(prev);
      for (const id of ids) {
        if (!next.has(id)) next.set(id, persisted[id]!);
      }
      return next;
    });
    setRehydratedIds(new Set(ids));
  }, []);

  const getStaged = React.useCallback(
    (packId: string) => mapRef.current.get(packId) ?? null,
    [],
  );

  const setStaged = React.useCallback((packId: string, pool: StagedPool) => {
    setStagedByPack((prev) => {
      const next = new Map(prev);
      next.set(packId, pool);
      mapRef.current = next;
      writeStorage(next);
      return next;
    });
  }, []);

  const clearStaged = React.useCallback((packId: string) => {
    setStagedByPack((prev) => {
      if (!prev.has(packId)) return prev;
      const next = new Map(prev);
      next.delete(packId);
      mapRef.current = next;
      writeStorage(next);
      return next;
    });
    setRehydratedIds((prev) => {
      if (!prev.has(packId)) return prev;
      const next = new Set(prev);
      next.delete(packId);
      return next;
    });
  }, []);

  const resolveRehydrated = React.useCallback((packId: string) => {
    setRehydratedIds((prev) => {
      if (!prev.has(packId)) return prev;
      const next = new Set(prev);
      next.delete(packId);
      return next;
    });
  }, []);

  return {
    stagedByPack,
    getStaged,
    setStaged,
    clearStaged,
    rehydratedIds,
    resolveRehydrated,
  };
}
