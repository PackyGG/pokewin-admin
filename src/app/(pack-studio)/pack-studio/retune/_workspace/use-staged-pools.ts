"use client";

import * as React from "react";

import type { StagedPool } from "./plan-state";
import type { RetunePinnedOdds } from "@/app/(admin)/packs/_lib/retune-params";

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
 *
 * PENDING EDITS: a SECOND, separate per-pack buffer of typed-but-not-yet-pinned
 * Planned % edits (the "edit several % before saving" feature). It is stored
 * ALONGSIDE the staged pools in the SAME sessionStorage payload so a mis-click
 * elsewhere never loses the typed values — but it is DELIBERATELY separate from
 * `StagedPool`: pending edits are NOT solve-relevant, never touch `stagedKey`,
 * never mint a staged pool, and never trigger a re-plan. Applying the buffer is
 * what commits it into `pinnedOdds` (one re-plan). A pack can have pending edits
 * on its LIVE pool with no staged entry at all.
 *
 * Like staged pools, the pending buffer carries a `baseFingerprint` — the pool
 * identity the values were typed against (recorded at first edit). Rehydrated
 * buffers are NOT trusted blindly: `pendingRehydratedIds` reports which packIds
 * came from storage so the workspace can run the F17-mirror drift check against
 * the fresh live pool (mismatch or missing fingerprint ⇒ drop + toast — typed
 * odds against a pool that no longer exists must never silently Apply).
 */

const STORAGE_KEY = "pack-studio.retune.staged.v1";

/**
 * One pack's pending buffer: the typed edits + the `computePoolFingerprint`
 * of the pool identity they were typed against (recorded at FIRST edit;
 * `null` = unknown — a legacy persisted bare array, treated as drifted on
 * rehydrate because it can't be verified).
 */
type PendingEntry = {
  baseFingerprint: string | null;
  edits: RetunePinnedOdds[];
};

type PendingMap = Record<string, PendingEntry>;

type PersistedPayload = {
  staged: Record<string, StagedPool>;
  pending: PendingMap;
};

function normalizePendingList(value: unknown): RetunePinnedOdds[] {
  if (!Array.isArray(value)) return [];
  const out: RetunePinnedOdds[] = [];
  for (const entry of value) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as RetunePinnedOdds).cardId === "string" &&
      typeof (entry as RetunePinnedOdds).pct === "number" &&
      Number.isFinite((entry as RetunePinnedOdds).pct)
    ) {
      out.push({
        cardId: (entry as RetunePinnedOdds).cardId,
        pct: (entry as RetunePinnedOdds).pct,
      });
    }
  }
  return out;
}

/**
 * Two persisted pending shapes coexist:
 *   • the current `{ baseFingerprint, edits }` entry, and
 *   • the LEGACY bare `RetunePinnedOdds[]` (pre-fingerprint) — normalized to a
 *     `baseFingerprint: null` entry (unverifiable ⇒ dropped by the rehydrate
 *     drift check, never silently trusted).
 */
function normalizePendingEntry(value: unknown): PendingEntry | null {
  if (Array.isArray(value)) {
    const edits = normalizePendingList(value);
    return edits.length > 0 ? { baseFingerprint: null, edits } : null;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const edits = normalizePendingList(obj.edits);
    if (edits.length === 0) return null;
    return {
      baseFingerprint:
        typeof obj.baseFingerprint === "string" ? obj.baseFingerprint : null,
      edits,
    };
  }
  return null;
}

function readStorage(): PersistedPayload {
  const empty: PersistedPayload = { staged: {}, pending: {} };
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return empty;
    // Two payload shapes coexist:
    //   • the current { staged, pending } wrapper, and
    //   • the LEGACY bare `Record<packId, StagedPool>` (pre-pending-edits).
    // A bare payload is detected by the absence of a `staged` field; its own
    // pool objects are the map values themselves.
    const obj = parsed as Record<string, unknown>;
    const hasWrapper =
      typeof obj.staged === "object" && obj.staged !== null;
    const stagedRaw = hasWrapper
      ? (obj.staged as Record<string, StagedPool>)
      : (parsed as Record<string, StagedPool>);
    const staged: Record<string, StagedPool> = { ...stagedRaw };
    // Shape normalization for entries persisted BEFORE later features:
    //   • `pinnedOdds` (pins) — normalize to [] so `stagedKey` / the builders
    //     never see undefined.
    //   • `manualOrder` (row reorder) — default false so the display sort and
    //     the write-order logic never read undefined.
    for (const pool of Object.values(staged)) {
      if (pool && !Array.isArray(pool.pinnedOdds)) pool.pinnedOdds = [];
      if (pool && typeof pool.manualOrder !== "boolean") pool.manualOrder = false;
    }
    const pending: PendingMap = {};
    if (hasWrapper && obj.pending && typeof obj.pending === "object") {
      for (const [packId, value] of Object.entries(
        obj.pending as Record<string, unknown>,
      )) {
        const normalized = normalizePendingEntry(value);
        if (normalized) pending[packId] = normalized;
      }
    }
    return { staged, pending };
  } catch {
    return empty;
  }
}

function writeStorage(
  stagedMap: Map<string, StagedPool>,
  pendingMap: Map<string, PendingEntry>,
): void {
  try {
    if (stagedMap.size === 0 && pendingMap.size === 0) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    const staged: Record<string, StagedPool> = {};
    for (const [packId, pool] of stagedMap) staged[packId] = pool;
    const pending: PendingMap = {};
    for (const [packId, entry] of pendingMap) {
      if (entry.edits.length > 0) pending[packId] = entry;
    }
    const payload: PersistedPayload = { staged, pending };
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
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
  /** Reactive per-pack pending-edits buffer — render from this. */
  pendingByPack: Map<string, PendingEntry>;
  /** Latest-value accessor for async callbacks (never stale). */
  getPending: (packId: string) => RetunePinnedOdds[];
  /** Latest full entry (edits + base fingerprint) for the drift check. */
  getPendingEntry: (packId: string) => PendingEntry | null;
  /**
   * Replace the whole pending buffer for a pack (persists; [] drops it).
   * `baseFingerprint` (when passed) records the pool identity of the FIRST
   * edit; omitted ⇒ the entry's existing fingerprint is preserved.
   */
  setPending: (
    packId: string,
    list: RetunePinnedOdds[],
    baseFingerprint?: string | null,
  ) => void;
  /** Drop a pack's pending buffer (+ its sessionStorage mirror). */
  clearPending: (packId: string) => void;
  /** PackIds whose pending buffer came from storage, awaiting the drift check. */
  pendingRehydratedIds: Set<string>;
  /** Mark a rehydrated pending buffer as reconciled (kept or dropped). */
  resolvePendingRehydrated: (packId: string) => void;
};

export function useStagedPools(): StagedPoolsApi {
  const [stagedByPack, setStagedByPack] = React.useState<Map<string, StagedPool>>(
    () => new Map(),
  );
  const [pendingByPack, setPendingByPack] = React.useState<
    Map<string, PendingEntry>
  >(() => new Map());
  const [rehydratedIds, setRehydratedIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [pendingRehydratedIds, setPendingRehydratedIds] = React.useState<
    Set<string>
  >(() => new Set());
  const mapRef = React.useRef(stagedByPack);
  mapRef.current = stagedByPack;
  const pendingRef = React.useRef(pendingByPack);
  pendingRef.current = pendingByPack;

  // Rehydrate AFTER mount (sessionStorage is browser-only; reading it in the
  // initial render would mismatch the SSR markup).
  React.useEffect(() => {
    const persisted = readStorage();
    const stagedIds = Object.keys(persisted.staged);
    const pendingIds = Object.keys(persisted.pending);
    if (stagedIds.length === 0 && pendingIds.length === 0) return;
    if (stagedIds.length > 0) {
      setStagedByPack((prev) => {
        const next = new Map(prev);
        for (const id of stagedIds) {
          if (!next.has(id)) next.set(id, persisted.staged[id]!);
        }
        mapRef.current = next;
        return next;
      });
      setRehydratedIds(new Set(stagedIds));
    }
    if (pendingIds.length > 0) {
      setPendingByPack((prev) => {
        const next = new Map(prev);
        for (const id of pendingIds) {
          if (!next.has(id)) next.set(id, persisted.pending[id]!);
        }
        pendingRef.current = next;
        return next;
      });
      setPendingRehydratedIds(new Set(pendingIds));
    }
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
      writeStorage(next, pendingRef.current);
      return next;
    });
  }, []);

  const clearStaged = React.useCallback((packId: string) => {
    setStagedByPack((prev) => {
      if (!prev.has(packId)) return prev;
      const next = new Map(prev);
      next.delete(packId);
      mapRef.current = next;
      writeStorage(next, pendingRef.current);
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

  const getPending = React.useCallback(
    (packId: string) => pendingRef.current.get(packId)?.edits ?? [],
    [],
  );

  const getPendingEntry = React.useCallback(
    (packId: string) => pendingRef.current.get(packId) ?? null,
    [],
  );

  const setPending = React.useCallback(
    (
      packId: string,
      list: RetunePinnedOdds[],
      baseFingerprint?: string | null,
    ) => {
      setPendingByPack((prev) => {
        const next = new Map(prev);
        if (list.length === 0) {
          if (!next.has(packId)) return prev;
          next.delete(packId);
        } else {
          next.set(packId, {
            baseFingerprint:
              baseFingerprint !== undefined
                ? baseFingerprint
                : (prev.get(packId)?.baseFingerprint ?? null),
            edits: list,
          });
        }
        pendingRef.current = next;
        writeStorage(mapRef.current, next);
        return next;
      });
    },
    [],
  );

  const clearPending = React.useCallback((packId: string) => {
    setPendingByPack((prev) => {
      if (!prev.has(packId)) return prev;
      const next = new Map(prev);
      next.delete(packId);
      pendingRef.current = next;
      writeStorage(mapRef.current, next);
      return next;
    });
    setPendingRehydratedIds((prev) => {
      if (!prev.has(packId)) return prev;
      const next = new Set(prev);
      next.delete(packId);
      return next;
    });
  }, []);

  const resolvePendingRehydrated = React.useCallback((packId: string) => {
    setPendingRehydratedIds((prev) => {
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
    pendingByPack,
    getPending,
    getPendingEntry,
    setPending,
    clearPending,
    pendingRehydratedIds,
    resolvePendingRehydrated,
  };
}
