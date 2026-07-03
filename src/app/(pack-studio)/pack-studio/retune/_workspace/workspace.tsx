"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink, Layers, MousePointerClick, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { FadeIn } from "@/components/fade-in";
import { SectionHeading } from "@/components/modern-panels";
import { TableSkeleton } from "@/components/loading-skeletons";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatCurrency } from "@/lib/utils/format";
import { computePackRisk, type PackRisk } from "@/app/(admin)/insights/edge-calc/risk";
import { computePoolFingerprint } from "@/app/(admin)/packs/_lib/pool-fingerprint";
import { hitRateFromTags } from "@/app/(admin)/packs/_lib/auto-targets";
import {
  applyPackRetune,
  authorizePackRetuneForReview,
  type PackRetuneResult,
} from "@/app/(admin)/packs/actions";

import {
  applyStagedPackEditAndRetune,
  getPackEditPool,
  getRetunePickerFilters,
  planPackTune,
  type ApplyStagedRetuneResult,
  type EditPool,
  type PackTunePlan,
  type RetunePickerFilters,
} from "../../doctor/retune-actions";
import type { BuilderCardItem } from "../../builder/actions";
import type { RetuneRailRow } from "../_queries/rail";
import { buildCardDiffRows } from "./card-diff-table";
import { BulkBar } from "./bulk-bar";
import { PackRail, attentionCompare } from "./pack-rail";
import { PlanPanel, type PlanRefusal } from "./plan-panel";
import {
  F1_NO_SNAPSHOT_BODY,
  F1_NO_SNAPSHOT_TITLE,
  F2_RAIL_FAILED_TITLE,
  F3_PACK_GONE,
  F4_OUT_OF_SCOPE,
} from "./plan-copy";
import {
  basisKey,
  deriveStatus,
  isPoolDriftRefusal,
  isPriceSkewRefusal,
  isPushEnabled,
  isTokenExpired,
  reanchorStagedPool,
  seedStagedPool,
  stagedPlanInput,
  stagedWriteInput,
  type PackVerdict,
  type PlanEntry,
  type PushedInfo,
  type StagedCard,
  type StagedPool,
} from "./plan-state";
import { PoolTable, autoColorAndAnimation, describeAutoPick } from "./pool-table";
import { PortfolioStrip } from "./portfolio-strip";
import { PushConfirm, type PendingPush } from "./push-confirm";
import { useStagedPools } from "./use-staged-pools";

/**
 * Retune V2 workspace orchestrator — owns ALL the fact maps (§4), the
 * deep-link/bulk intake, the lazily-minted session token, the plan dispatch
 * (seq-guarded, one in-flight per pack, price debounced 500ms), the push
 * dispatch (frozen artifact + silent token re-mint + failure classification),
 * and the prop-reseed merge after `router.refresh()` (React keeps this
 * client component's state — new rail rows flow in as props while staged
 * pools / markers / selection survive by construction).
 *
 * The client mirror uses ONLY `computePackRisk` (~1 µs/keystroke) — the
 * price-search / weight-shaping solver NEVER ships to the client; the
 * authoritative numbers always come from `planPackTune`.
 */

type RailPatch = {
  price: number;
  edge: number;
  winRate: number;
  tier: string;
};

type WriteResult = PackRetuneResult | ApplyStagedRetuneResult;

const PLAN_CONTEXT = "pack-studio.retune.plan-pack";
const PLAN_TIMEOUT_MS = 20_000;
const PRICE_DEBOUNCE_MS = 500;
const BULK_HANDOFF_KEY = "pack-studio.retune.bulk-handoff";

function setMap<K, V>(map: Map<K, V>, key: K, value: V): Map<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function delMap<K, V>(map: Map<K, V>, key: K): Map<K, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

function addSet<T>(set: Set<T>, value: T): Set<T> {
  if (set.has(value)) return set;
  const next = new Set(set);
  next.add(value);
  return next;
}

function delSet<T>(set: Set<T>, value: T): Set<T> {
  if (!set.has(value)) return set;
  const next = new Set(set);
  next.delete(value);
  return next;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "The write failed.";
}

function priceInputText(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function RetuneWorkspace({
  rows,
  railError,
  initialPackId,
  initialBulk,
}: {
  rows: RetuneRailRow[];
  railError: string | null;
  /** `?pack=<id>` deep link (selected + scrolled into view on mount). */
  initialPackId: string | null;
  /** `?bulk=<id,id,…>` or `?bulk=session` (sessionStorage handoff). */
  initialBulk: string | null;
}) {
  const router = useRouter();
  const stagedApi = useStagedPools();

  // ── Fact maps (§4) ──────────────────────────────────────────────────────
  const [poolByPack, setPoolByPack] = React.useState<Map<string, EditPool>>(
    () => new Map(),
  );
  const [poolErrorByPack, setPoolErrorByPack] = React.useState<
    Map<string, string>
  >(() => new Map());
  const [planByPack, setPlanByPack] = React.useState<Map<string, PlanEntry>>(
    () => new Map(),
  );
  const [pushedByPack, setPushedByPack] = React.useState<
    Map<string, PushedInfo>
  >(() => new Map());
  const [verdictByPack, setVerdictByPack] = React.useState<
    Map<string, PackVerdict>
  >(() => new Map());
  const [selectedPackId, setSelectedPackId] = React.useState<string | null>(
    null,
  );
  const [checkedIds, setCheckedIds] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [railPatch, setRailPatch] = React.useState<Map<string, RailPatch>>(
    () => new Map(),
  );
  const [refusalByPack, setRefusalByPack] = React.useState<
    Map<string, PlanRefusal>
  >(() => new Map());
  const [rebasedPacks, setRebasedPacks] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [fixLoopPacks, setFixLoopPacks] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [driftPrompts, setDriftPrompts] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [nextSuggestionByPack, setNextSuggestionByPack] = React.useState<
    Map<string, { packId: string; name: string }>
  >(() => new Map());
  const [pendingPush, setPendingPush] = React.useState<PendingPush | null>(
    null,
  );
  const [pushing, setPushing] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerRange, setPickerRange] = React.useState<{
    min?: number;
    max?: number;
  } | null>(null);
  const [pickerFilters, setPickerFilters] =
    React.useState<RetunePickerFilters | null>(null);
  const [priceText, setPriceText] = React.useState("");
  const [visibleIds, setVisibleIds] = React.useState<string[]>([]);

  const tokenRef = React.useRef<string | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const seqRef = React.useRef<Map<string, number>>(new Map());
  const replanTimerRef = React.useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const driftRepairRef = React.useRef<Set<string>>(new Set());
  const refreshTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [, startTransition] = React.useTransition();

  // Latest-value ref mirrors for async callbacks + the keyboard handler.
  const planByPackRef = React.useRef(planByPack);
  planByPackRef.current = planByPack;
  const poolByPackRef = React.useRef(poolByPack);
  poolByPackRef.current = poolByPack;
  const selectedRef = React.useRef(selectedPackId);
  selectedRef.current = selectedPackId;
  const visibleIdsRef = React.useRef(visibleIds);
  visibleIdsRef.current = visibleIds;
  const pushedRef = React.useRef(pushedByPack);
  pushedRef.current = pushedByPack;

  // ── Rail rows: optimistic post-push patch over the streamed props ───────
  const patchedRows = React.useMemo(() => {
    if (railPatch.size === 0) return rows;
    return rows.map((r) => {
      const p = railPatch.get(r.packId);
      if (!p) return r;
      return {
        ...r,
        price: p.price,
        edge: p.edge,
        winRate: p.winRate,
        tier: p.tier,
        offTagLive:
          r.tag !== null && Math.abs(p.winRate - r.tag) > 0.001 + 1e-12,
      };
    });
  }, [rows, railPatch]);
  const patchedRowsRef = React.useRef(patchedRows);
  patchedRowsRef.current = patchedRows;

  const rowsById = React.useMemo(
    () => new Map(patchedRows.map((r) => [r.packId, r])),
    [patchedRows],
  );

  // ── Plan dispatch (ONE in-flight per pack, seq-guarded) ─────────────────
  const requestPlan = React.useCallback(
    async (packId: string, opts?: { fresh?: boolean }) => {
      const timer = replanTimerRef.current.get(packId);
      if (timer) {
        clearTimeout(timer);
        replanTimerRef.current.delete(packId);
      }
      const sp = stagedApi.getStaged(packId);
      const basis = basisKey(packId, sp);
      const seq = (seqRef.current.get(packId) ?? 0) + 1;
      seqRef.current.set(packId, seq);
      const prevPlan = planByPackRef.current.get(packId)?.plan ?? null;
      setPlanByPack((prev) => {
        const old = prev.get(packId);
        return setMap(prev, packId, {
          basisKey: basis,
          seq,
          status: "loading",
          plan: old && old.basisKey === basis ? old.plan : null,
        });
      });
      const { data, error } = await safeQueryOrNull(
        () =>
          planPackTune(
            packId,
            sp ? stagedPlanInput(sp) : null,
            opts?.fresh ? { fresh: true } : null,
          ),
        PLAN_CONTEXT,
        PLAN_TIMEOUT_MS,
      );
      // Stale seq — a newer request superseded this one; drop, never surface.
      if ((seqRef.current.get(packId) ?? 0) !== seq) return;
      setPlanByPack((prev) =>
        setMap(prev, packId, {
          basisKey: basis,
          seq,
          status: error ? "error" : "ready",
          plan: data ?? null,
          ...(error ? { error } : {}),
        }),
      );
      if (error) {
        setVerdictByPack((prev) => setMap(prev, packId, "error"));
        return;
      }
      // A landed plan supersedes any write-refusal banner (the operator
      // re-planned — the refusal's artifact is gone).
      setRefusalByPack((prev) => delMap(prev, packId));
      setVerdictByPack((prev) =>
        setMap(prev, packId, data !== null && data.feasible ? "ok" : "infeasible"),
      );
      // Fix-loop one-shot (§5c): infeasible → feasible flip = emerald pop.
      setFixLoopPacks((prev) => {
        if (data?.feasible && prevPlan !== null && !prevPlan.feasible) {
          return addSet(prev, packId);
        }
        return delSet(prev, packId);
      });
    },
    [stagedApi],
  );

  const schedulePlan = React.useCallback(
    (packId: string, delayMs: number) => {
      const existing = replanTimerRef.current.get(packId);
      if (existing) clearTimeout(existing);
      replanTimerRef.current.set(
        packId,
        setTimeout(() => {
          replanTimerRef.current.delete(packId);
          void requestPlan(packId);
        }, delayMs),
      );
    },
    [requestPlan],
  );

  // ── Pool fetch (session-lifetime cache; F3 degrades to a message) ───────
  const ensurePool = React.useCallback(
    async (
      packId: string,
      opts?: { fresh?: boolean },
    ): Promise<EditPool | null> => {
      if (!opts?.fresh) {
        const cached = poolByPackRef.current.get(packId);
        if (cached) return cached;
      }
      try {
        const pool = await getPackEditPool(packId);
        setPoolByPack((prev) => setMap(prev, packId, pool));
        setPoolErrorByPack((prev) => delMap(prev, packId));
        return pool;
      } catch (err) {
        setPoolErrorByPack((prev) =>
          setMap(prev, packId, err instanceof Error ? err.message : F3_PACK_GONE),
        );
        return null;
      }
    },
    [],
  );

  // F17 — a sessionStorage-rehydrated staged pool is NEVER silently reused:
  // its base fingerprint is checked against the fresh live pool first.
  const runRehydrationCheck = React.useCallback(
    (packId: string, pool: EditPool) => {
      if (!stagedApi.rehydratedIds.has(packId)) return;
      const sp = stagedApi.getStaged(packId);
      if (!sp) {
        stagedApi.resolveRehydrated(packId);
        return;
      }
      const liveFp = computePoolFingerprint(
        pool.price,
        pool.cards.map((c) => ({ cardId: c.cardId, weight: c.weight })),
      );
      if (sp.baseFingerprint !== liveFp) {
        setDriftPrompts((prev) => addSet(prev, packId));
      } else {
        stagedApi.resolveRehydrated(packId);
      }
    },
    [stagedApi],
  );

  // ── Selection (⇄ ?pack= via the native shallow history API) ─────────────
  const select = React.useCallback(
    (packId: string) => {
      setSelectedPackId(packId);
      const url = new URL(window.location.href);
      url.searchParams.set("pack", packId);
      // Shallow, no scroll — Next 15's sanctioned client-side URL sync
      // (router.replace would re-fetch the whole RSC payload per click).
      window.history.replaceState(null, "", url.toString());
      const sp = stagedApi.getStaged(packId);
      const pool = poolByPackRef.current.get(packId);
      setPriceText(
        priceInputText(
          sp?.price ?? pool?.price ?? rowsById.get(packId)?.price ?? 0,
        ),
      );
      // Pool + plan fired in PARALLEL inside a transition (§3).
      startTransition(() => {
        void (async () => {
          const entry = planByPackRef.current.get(packId);
          const basis = basisKey(packId, sp);
          const planFresh =
            entry !== undefined &&
            entry.basisKey === basis &&
            entry.status !== "error";
          const [pool2] = await Promise.all([
            ensurePool(packId),
            planFresh ? Promise.resolve() : requestPlan(packId),
          ]);
          if (pool2) runRehydrationCheck(packId, pool2);
        })();
      });
    },
    [stagedApi, rowsById, ensurePool, requestPlan, runRehydrationCheck],
  );

  // Deep-link + bulk intake — once, on mount.
  const intakeDoneRef = React.useRef(false);
  React.useEffect(() => {
    if (intakeDoneRef.current || rows.length === 0) return;
    intakeDoneRef.current = true;
    if (initialBulk) {
      let ids: string[] = [];
      if (initialBulk === "session") {
        try {
          const raw = window.sessionStorage.getItem(BULK_HANDOFF_KEY);
          const parsed: unknown = raw ? JSON.parse(raw) : [];
          if (Array.isArray(parsed)) {
            ids = parsed.filter((v): v is string => typeof v === "string");
          }
        } catch {
          ids = [];
        }
      } else {
        ids = initialBulk.split(",").filter(Boolean);
      }
      const known = new Set(rows.map((r) => r.packId));
      const valid = ids.filter((id) => known.has(id));
      if (valid.length > 0) setCheckedIds(new Set(valid));
    }
    if (initialPackId && rows.some((r) => r.packId === initialPackId)) {
      select(initialPackId);
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-rail-row="${initialPackId}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  // ── Staged-pool mutations ────────────────────────────────────────────────
  const ensureStaged = React.useCallback(
    (packId: string): StagedPool | null => {
      const existing = stagedApi.getStaged(packId);
      if (existing) return existing;
      const pool = poolByPackRef.current.get(packId);
      if (!pool) return null;
      return seedStagedPool(pool);
    },
    [stagedApi],
  );

  const addCard = React.useCallback(
    (card: BuilderCardItem) => {
      const packId = selectedRef.current;
      if (!packId) return;
      const sp = ensureStaged(packId);
      if (!sp) return;
      if (sp.cards.some((c) => c.cardId === card.id)) return;
      const removedMatch = sp.removed.find((c) => c.cardId === card.id);
      let nextCards: StagedCard[];
      let nextRemoved = sp.removed;
      if (removedMatch) {
        // Re-adding a removed live card = undo (its live anchor survives).
        nextCards = [...sp.cards, removedMatch];
        nextRemoved = sp.removed.filter((c) => c.cardId !== card.id);
      } else {
        const auto = autoColorAndAnimation(card.priceUsd, sp.price);
        nextCards = [
          ...sp.cards,
          {
            cardId: card.id,
            name: card.name,
            value: card.priceUsd,
            imageUrl: card.imageUrl,
            color: auto.color,
            animation: auto.animation,
            liveWeight: null,
            added: true,
          },
        ];
      }
      stagedApi.setStaged(packId, {
        ...sp,
        cards: nextCards,
        removed: nextRemoved,
      });
      void requestPlan(packId); // add/remove → immediate re-plan (§3)
    },
    [ensureStaged, stagedApi, requestPlan],
  );

  const removeCard = React.useCallback(
    (cardId: string) => {
      const packId = selectedRef.current;
      if (!packId) return;
      const sp = ensureStaged(packId);
      if (!sp) return;
      const target = sp.cards.find((c) => c.cardId === cardId);
      if (!target) return;
      stagedApi.setStaged(packId, {
        ...sp,
        cards: sp.cards.filter((c) => c.cardId !== cardId),
        // An added card is just dropped; a live card moves to removed (Undo).
        removed: target.added ? sp.removed : [...sp.removed, target],
        // A removed card's pin has nothing left to bind — drop it (the plan
        // input refuses pins on cards outside the staged pool).
        pinnedOdds: sp.pinnedOdds.filter((p) => p.cardId !== cardId),
      });
      void requestPlan(packId);
    },
    [ensureStaged, stagedApi, requestPlan],
  );

  // ── Owner pins: Enter on the Planned % cell pins, X clears (§ pins) ─────
  // Pin edits re-plan through the SAME staged path as add/remove/price —
  // committed pins are solve-relevant (stagedKey), so the plan re-fires
  // immediately (a pin commit is an explicit Enter, like a price commit).
  const pinCard = React.useCallback(
    (cardId: string, pct: number) => {
      const packId = selectedRef.current;
      if (!packId) return;
      const sp = ensureStaged(packId);
      if (!sp) return;
      if (!sp.cards.some((c) => c.cardId === cardId)) return;
      const existing = sp.pinnedOdds.find((p) => p.cardId === cardId);
      if (existing && existing.pct === pct) return; // no-op re-commit
      stagedApi.setStaged(packId, {
        ...sp,
        pinnedOdds: [
          ...sp.pinnedOdds.filter((p) => p.cardId !== cardId),
          { cardId, pct },
        ],
      });
      void requestPlan(packId);
    },
    [ensureStaged, stagedApi, requestPlan],
  );

  const clearPin = React.useCallback(
    (cardId: string) => {
      const packId = selectedRef.current;
      if (!packId) return;
      const sp = stagedApi.getStaged(packId);
      if (!sp || !sp.pinnedOdds.some((p) => p.cardId === cardId)) return;
      stagedApi.setStaged(packId, {
        ...sp,
        pinnedOdds: sp.pinnedOdds.filter((p) => p.cardId !== cardId),
      });
      void requestPlan(packId);
    },
    [stagedApi, requestPlan],
  );

  const clearAllPins = React.useCallback(() => {
    const packId = selectedRef.current;
    if (!packId) return;
    const sp = stagedApi.getStaged(packId);
    if (!sp || sp.pinnedOdds.length === 0) return;
    stagedApi.setStaged(packId, { ...sp, pinnedOdds: [] });
    void requestPlan(packId);
  }, [stagedApi, requestPlan]);

  const undoRemove = React.useCallback(
    (cardId: string) => {
      const packId = selectedRef.current;
      if (!packId) return;
      const sp = stagedApi.getStaged(packId);
      if (!sp) return;
      const target = sp.removed.find((c) => c.cardId === cardId);
      if (!target) return;
      stagedApi.setStaged(packId, {
        ...sp,
        cards: [...sp.cards, target],
        removed: sp.removed.filter((c) => c.cardId !== cardId),
      });
      void requestPlan(packId);
    },
    [stagedApi, requestPlan],
  );

  const changeCosmetic = React.useCallback(
    (cardId: string, patch: { color?: string | null; animation?: boolean }) => {
      const packId = selectedRef.current;
      if (!packId) return;
      const hadStaged = stagedApi.getStaged(packId) !== null;
      const sp = ensureStaged(packId);
      if (!sp) return;
      stagedApi.setStaged(packId, {
        ...sp,
        cards: sp.cards.map((c) =>
          c.cardId === cardId ? { ...c, ...patch } : c,
        ),
      });
      // Cosmetics never re-plan (stagedKey unchanged) — EXCEPT the very first
      // edit, which flips the arm live→staged (§4: one re-plan, identical
      // numbers by the shared builder; later cosmetic edits are free).
      if (!hadStaged) void requestPlan(packId);
    },
    [ensureStaged, stagedApi, requestPlan],
  );

  const commitPrice = React.useCallback(
    (raw: string, immediate: boolean) => {
      const packId = selectedRef.current;
      if (!packId) return;
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      const existing = stagedApi.getStaged(packId);
      const base = existing ?? ensureStaged(packId);
      if (!base) return;
      if (Math.abs(base.price - parsed) < 0.005) {
        // No solve-relevant change — never mint a staged pool for a no-op.
        if (existing && immediate) void requestPlan(packId);
        return;
      }
      stagedApi.setStaged(packId, { ...base, price: parsed });
      if (immediate) {
        void requestPlan(packId); // Enter/blur — flush the debounce
      } else {
        schedulePlan(packId, PRICE_DEBOUNCE_MS); // 500ms after last keystroke
      }
    },
    [ensureStaged, stagedApi, requestPlan, schedulePlan],
  );

  const togglePin = React.useCallback(() => {
    const packId = selectedRef.current;
    if (!packId) return;
    const sp = ensureStaged(packId);
    if (!sp) return;
    stagedApi.setStaged(packId, { ...sp, pinPrice: !sp.pinPrice });
    void requestPlan(packId); // pin toggle → immediate
  }, [ensureStaged, stagedApi, requestPlan]);

  const resetToLive = React.useCallback(
    (packId: string) => {
      stagedApi.clearStaged(packId);
      setDriftPrompts((prev) => delSet(prev, packId));
      setRebasedPacks((prev) => delSet(prev, packId));
      setFixLoopPacks((prev) => delSet(prev, packId));
      void (async () => {
        const fresh = await ensurePool(packId, { fresh: true });
        if (fresh) setPriceText(priceInputText(fresh.price));
        void requestPlan(packId); // reverts to the cached live-arm plan
      })();
    },
    [stagedApi, ensurePool, requestPlan],
  );

  // F17 resolutions.
  const keepRehydrated = React.useCallback(
    (packId: string) => {
      const sp = stagedApi.getStaged(packId);
      const pool = poolByPackRef.current.get(packId);
      if (sp && pool) {
        stagedApi.setStaged(packId, reanchorStagedPool(sp, pool));
      }
      stagedApi.resolveRehydrated(packId);
      setDriftPrompts((prev) => delSet(prev, packId));
      void requestPlan(packId);
    },
    [stagedApi, requestPlan],
  );

  const discardRehydrated = React.useCallback(
    (packId: string) => {
      stagedApi.clearStaged(packId);
      setDriftPrompts((prev) => delSet(prev, packId));
      void requestPlan(packId);
    },
    [stagedApi, requestPlan],
  );

  // ── Card picker (filters lazy-loaded on first open) ─────────────────────
  const openPicker = React.useCallback(
    (range: { min: number; max: number } | null) => {
      setPickerRange(range);
      if (pickerFilters) {
        setPickerOpen(true);
        return;
      }
      void (async () => {
        try {
          const filters = await getRetunePickerFilters();
          setPickerFilters(filters);
          setPickerOpen(true);
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : "Couldn't load the card picker.",
          );
        }
      })();
    },
    [pickerFilters],
  );

  // ── Token mint (lazy at first confirm-open; silent re-mint on expiry) ───
  const getToken = React.useCallback(async (): Promise<string> => {
    if (tokenRef.current) return tokenRef.current;
    const { token } = await authorizePackRetuneForReview();
    tokenRef.current = token;
    return token;
  }, []);

  const remintToken = React.useCallback(async (): Promise<string> => {
    const { token } = await authorizePackRetuneForReview();
    tokenRef.current = token;
    return token;
  }, []);

  // ── Post-write bookkeeping ───────────────────────────────────────────────
  const debouncedRefresh = React.useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      startTransition(() => router.refresh());
    }, 800);
  }, [router]);

  const applyPushBookkeeping = React.useCallback(
    (packId: string, plan: PackTunePlan, result: WriteResult) => {
      setPushedByPack((prev) =>
        setMap(prev, packId, {
          at: Date.now(),
          priceAfter: result.priceAfter,
          edgeAfter: result.after.edge,
          winRateAfter: result.after.winRate,
        }),
      );
      setPlanByPack((prev) => delMap(prev, packId));
      seqRef.current.set(packId, (seqRef.current.get(packId) ?? 0) + 1);
      setPoolByPack((prev) => delMap(prev, packId));
      setVerdictByPack((prev) => setMap(prev, packId, "ok"));
      setRefusalByPack((prev) => delMap(prev, packId));
      setRebasedPacks((prev) => delSet(prev, packId));
      setFixLoopPacks((prev) => delSet(prev, packId));
      setRailPatch((prev) =>
        setMap(prev, packId, {
          price: result.priceAfter,
          edge: result.after.edge,
          winRate: result.after.winRate,
          tier: plan.after?.tier ?? rowsById.get(packId)?.tier ?? "T1",
        }),
      );
      debouncedRefresh();
    },
    [rowsById, debouncedRefresh],
  );

  const handleWriteSuccess = React.useCallback(
    (pp: PendingPush, result: WriteResult) => {
      stagedApi.clearStaged(pp.packId);
      setDriftPrompts((prev) => delSet(prev, pp.packId));
      applyPushBookkeeping(pp.packId, pp.frozen, result);
      // "Next: {name} →" — the next Attention-ordered row still needing work.
      const next = patchedRowsRef.current
        .filter(
          (r) =>
            r.packId !== pp.packId &&
            !pushedRef.current.has(r.packId) &&
            (r.edge < r.targetEdge - 1e-9 || r.offTagLive),
        )
        .sort(attentionCompare)[0];
      setNextSuggestionByPack((prev) =>
        next
          ? setMap(prev, pp.packId, { packId: next.packId, name: next.name })
          : delMap(prev, pp.packId),
      );
      setPendingPush(null);
      setPriceText(priceInputText(result.priceAfter));
      toast.success(
        result.priceAfter !== result.priceBefore
          ? `Pushed ${result.name}: price ${formatCurrency(result.priceBefore)} → ${formatCurrency(result.priceAfter)} · edge ${(result.after.edge * 100).toFixed(2)}% · win ${(result.after.winRate * 100).toFixed(2)}%.`
          : `Pushed ${result.name}: edge ${(result.after.edge * 100).toFixed(2)}% · win ${(result.after.winRate * 100).toFixed(2)}%.`,
      );
      // Refresh the panel's live truth (pool + live-arm plan) — Push stays
      // disabled until the operator stages again (F14 `pushed` state).
      void (async () => {
        const fresh = await ensurePool(pp.packId, { fresh: true });
        if (fresh) void requestPlan(pp.packId, { fresh: true });
      })();
    },
    [stagedApi, applyPushBookkeeping, ensurePool, requestPlan],
  );

  const handleWriteFailure = React.useCallback(
    (pp: PendingPush, message: string) => {
      // F6 second failure (or mint failure) — surfaced INSIDE step 2, no
      // state lost; the operator can retry from the same frozen artifact.
      if (isTokenExpired(message)) {
        setPendingPush({ ...pp, error: message });
        return;
      }
      if (isPoolDriftRefusal(message)) {
        // F8 — rose toast with the server copy, confirm closes, NO auto-retry
        // of the write; edits are RE-BASED onto the fresh pool + re-planned.
        toast.error(message);
        setPendingPush(null);
        setPlanByPack((prev) => delMap(prev, pp.packId));
        setPoolByPack((prev) => delMap(prev, pp.packId));
        void (async () => {
          const fresh = await ensurePool(pp.packId, { fresh: true });
          if (fresh) {
            const sp = stagedApi.getStaged(pp.packId);
            if (sp) {
              stagedApi.setStaged(pp.packId, reanchorStagedPool(sp, fresh));
              setRebasedPacks((prev) => addSet(prev, pp.packId));
            }
            void requestPlan(pp.packId);
          }
        })();
        return;
      }
      if (isPriceSkewRefusal(message)) {
        // F9 — parameter-skew / nondeterminism surfaced honestly.
        setRefusalByPack((prev) =>
          setMap(prev, pp.packId, {
            kind: "skew",
            message,
            details: JSON.stringify(
              { packId: pp.packId, plan: pp.frozen },
              null,
              2,
            ),
          }),
        );
        setVerdictByPack((prev) => setMap(prev, pp.packId, "refused"));
        setPendingPush(null);
        return;
      }
      // F11 — an engine invariant refused the write (edge/cap/tag assert).
      setRefusalByPack((prev) =>
        setMap(prev, pp.packId, { kind: "invariant", message, details: null }),
      );
      setVerdictByPack((prev) => setMap(prev, pp.packId, "refused"));
      setPendingPush(null);
    },
    [ensurePool, stagedApi, requestPlan],
  );

  const performWrite = React.useCallback(
    async (pp: PendingPush) => {
      setPushing(true);
      const targets = {
        targetEdge: pp.frozen.targets.targetEdge,
        targetWinRate: pp.frozen.targets.targetWinRate,
        maxWinCap: pp.frozen.targets.maxWinCap,
        nearMissMin: pp.frozen.targets.nearMissMin,
      };
      // Pins are ALWAYS sent, both arms (§2d) — plan ≡ write is structural
      // (shared buildRetuneSearchParams), so tolerance-0 refusals are real bugs.
      const pins = {
        approvedPriceAfter: pp.frozen.priceAfter,
        approvedPoolFingerprint: pp.frozen.poolFingerprint,
      };
      const write = (token: string): Promise<WriteResult> =>
        pp.arm === "staged"
          ? applyStagedPackEditAndRetune(pp.packId, token, pp.writeInput!, {
              ...targets,
              allowPriceSearch: !pp.pinPrice,
              ...pins,
            })
          : applyPackRetune(pp.packId, token, {
              ...targets,
              allowPriceSearch: true,
              upwardPriceExtensionPct: 0,
              ...pins,
            });
      try {
        let token = await getToken();
        let result: WriteResult;
        try {
          result = await write(token);
        } catch (err) {
          const message = errMessage(err);
          if (!isTokenExpired(message)) throw err;
          // F6 — silent re-mint + ONE retry with the SAME frozen artifact.
          token = await remintToken();
          result = await write(token);
        }
        handleWriteSuccess(pp, result);
      } catch (err) {
        handleWriteFailure(pp, errMessage(err));
      } finally {
        setPushing(false);
      }
    },
    [getToken, remintToken, handleWriteSuccess, handleWriteFailure],
  );

  // ── Two-step confirm (freeze at open; re-check at the step-2 click) ─────
  const openPushConfirm = React.useCallback(async () => {
    const packId = selectedRef.current;
    if (!packId) return;
    const sp = stagedApi.getStaged(packId);
    const basis = basisKey(packId, sp);
    const entry = planByPackRef.current.get(packId);
    if (
      !entry ||
      entry.basisKey !== basis ||
      entry.status !== "ready" ||
      entry.plan === null
    ) {
      return;
    }
    try {
      await getToken(); // minted lazily at first confirm-open (§2d)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't authorize the session.",
      );
      return;
    }
    const pool = poolByPackRef.current.get(packId) ?? null;
    setPendingPush({
      packId,
      arm: sp ? "staged" : "live",
      frozen: entry.plan,
      frozenBasisKey: basis,
      writeInput: sp ? stagedWriteInput(sp) : null,
      pinPrice: sp?.pinPrice ?? false,
      frozenRows: buildCardDiffRows({ pool, staged: sp, plan: entry.plan }),
      step: 1,
      changed: false,
      error: null,
    });
  }, [stagedApi, getToken]);

  const confirmStep2 = React.useCallback(() => {
    setPendingPush((pp) => (pp ? { ...pp, step: 2 } : pp));
  }, []);

  const confirmPush = React.useCallback(() => {
    const pp = pendingPush;
    if (!pp || pushing) return;
    // §4: re-check the frozen keys at the CLICK — on mismatch the dialog
    // swaps to "Plan changed underneath — nothing was written" (F10).
    const sp = stagedApi.getStaged(pp.packId);
    const basisNow = basisKey(pp.packId, sp);
    const fingerprintOk =
      sp === null || pp.frozen.poolFingerprint === sp.baseFingerprint;
    if (basisNow !== pp.frozenBasisKey || !fingerprintOk) {
      setPendingPush({ ...pp, changed: true });
      return;
    }
    void performWrite(pp);
  }, [pendingPush, pushing, stagedApi, performWrite]);

  // ── Selected-pack derived state ──────────────────────────────────────────
  const selectedRow = selectedPackId ? rowsById.get(selectedPackId) : undefined;
  const selectedStaged = selectedPackId
    ? (stagedApi.stagedByPack.get(selectedPackId) ?? null)
    : null;
  const selectedEntry = selectedPackId
    ? planByPack.get(selectedPackId)
    : undefined;
  const selectedPool = selectedPackId
    ? (poolByPack.get(selectedPackId) ?? null)
    : null;
  const selectedPoolError = selectedPackId
    ? (poolErrorByPack.get(selectedPackId) ?? null)
    : null;
  const selectedBasis = selectedPackId
    ? basisKey(selectedPackId, selectedStaged)
    : "";
  const planForBasis =
    selectedEntry &&
    selectedEntry.basisKey === selectedBasis &&
    selectedEntry.status === "ready"
      ? selectedEntry.plan
      : null;
  const status = selectedPackId
    ? deriveStatus({
        packId: selectedPackId,
        staged: selectedStaged,
        entry: selectedEntry,
        pushInFlight: pushing && pendingPush?.packId === selectedPackId,
        pushed: pushedByPack.has(selectedPackId),
        refused: refusalByPack.has(selectedPackId),
      })
    : "pristine";
  const pushEnabled =
    selectedPackId !== null &&
    !driftPrompts.has(selectedPackId) &&
    isPushEnabled({
      status,
      plan: planForBasis,
      arm: selectedStaged ? "staged" : "live",
      pinPrice: selectedStaged?.pinPrice ?? false,
    });
  const pushEnabledRef = React.useRef(pushEnabled);
  pushEnabledRef.current = pushEnabled;

  // Client mirror (§3): pure computePackRisk over the staged identity at the
  // staged price — instant, always labeled "estimate", never authoritative.
  const estimate = React.useMemo((): PackRisk | null => {
    if (!selectedStaged) return null;
    return computePackRisk({
      cards: selectedStaged.cards.map((c) => ({
        value: c.value,
        weight: c.liveWeight ?? 0,
      })),
      price: selectedStaged.price,
    });
  }, [selectedStaged]);

  const diffRows = React.useMemo(
    () =>
      buildCardDiffRows({
        pool: selectedPool,
        staged: selectedStaged,
        plan: planForBasis,
      }),
    [selectedPool, selectedStaged, planForBasis],
  );

  const oddsTotal = React.useMemo(() => {
    if (!planForBasis || planForBasis.planned.length === 0) return 100;
    return planForBasis.planned.reduce((s, p) => s + p.pct, 0);
  }, [planForBasis]);

  const autoHintByCardId = React.useMemo(() => {
    const out = new Map<string, string>();
    if (selectedStaged) {
      for (const c of selectedStaged.cards) {
        if (!c.added) continue;
        const auto = autoColorAndAnimation(c.value, selectedStaged.price);
        out.set(c.cardId, describeAutoPick(auto.color, auto.animation));
      }
    }
    return out;
  }, [selectedStaged]);

  const tagSource = ((): "db" | "name" | null => {
    if (!selectedRow || selectedRow.tag === null) return null;
    return hitRateFromTags(selectedRow.tags) !== null ? "db" : "name";
  })();

  // Auto re-plan when a plan goes stale under the selection (§4) — mutation
  // sites fire immediately; this catches responses that landed on an
  // outdated basis (they're cached, never surfaced, and re-planned here).
  React.useEffect(() => {
    if (!selectedPackId || status !== "stale") return;
    schedulePlan(selectedPackId, PRICE_DEBOUNCE_MS);
  }, [selectedPackId, status, schedulePlan]);

  // F7 — the plan's live fingerprint drifted under the staged edits:
  // auto re-seed the baseline + re-plan (staged identity kept).
  React.useEffect(() => {
    if (!selectedPackId || status !== "drifted") return;
    if (driftRepairRef.current.has(selectedPackId)) return;
    driftRepairRef.current.add(selectedPackId);
    const packId = selectedPackId;
    void (async () => {
      try {
        const fresh = await ensurePool(packId, { fresh: true });
        if (fresh) {
          const sp = stagedApi.getStaged(packId);
          if (sp) stagedApi.setStaged(packId, reanchorStagedPool(sp, fresh));
          await requestPlan(packId);
        }
      } finally {
        driftRepairRef.current.delete(packId);
      }
    })();
  }, [selectedPackId, status, ensurePool, stagedApi, requestPlan]);

  // ── Keyboard (§6; suppressed while inputs/dialogs are focused) ──────────
  const pendingPushRef = React.useRef(pendingPush);
  pendingPushRef.current = pendingPush;
  const pickerOpenRef = React.useRef(pickerOpen);
  pickerOpenRef.current = pickerOpen;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (pendingPushRef.current || pickerOpenRef.current) return;
      // Any open dialog/popover owns the keyboard (bulk phases included).
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        return;
      }
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable)
      ) {
        return;
      }
      const key = e.key;
      if (key === "ArrowDown" || key === "ArrowUp") {
        e.preventDefault();
        const ids = visibleIdsRef.current;
        if (ids.length === 0) return;
        const current = selectedRef.current;
        const idx = current ? ids.indexOf(current) : -1;
        const nextIdx =
          key === "ArrowDown"
            ? Math.min(ids.length - 1, idx + 1)
            : Math.max(0, idx <= 0 ? 0 : idx - 1);
        const nextId = ids[nextIdx];
        if (nextId && nextId !== current) {
          select(nextId);
          document
            .querySelector(`[data-rail-row="${nextId}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }
        return;
      }
      if (key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (key === "x") {
        const current = selectedRef.current;
        if (current) {
          setCheckedIds((prev) =>
            prev.has(current) ? delSet(prev, current) : addSet(prev, current),
          );
        }
        return;
      }
      if (key === "r") {
        const current = selectedRef.current;
        if (current) void requestPlan(current, { fresh: true });
        return;
      }
      if (key === "l") {
        const current = selectedRef.current;
        if (current) resetToLive(current);
        return;
      }
      if (key === "p") {
        // Opens step 1 ONLY when enabled — no keyboard path reaches step 2's
        // write (its destructive button is pointer-only).
        if (pushEnabledRef.current) void openPushConfirm();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select, requestPlan, resetToLive, openPushConfirm]);

  // ── Bulk wiring ───────────────────────────────────────────────────────────
  const orderedChecked = React.useMemo(
    () =>
      patchedRows
        .filter((r) => checkedIds.has(r.packId))
        .sort(attentionCompare)
        .map((r) => r.packId),
    [patchedRows, checkedIds],
  );

  const handleCheck = React.useCallback((ids: string[], checked: boolean) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const stagedIds = React.useMemo(
    () => new Set(stagedApi.stagedByPack.keys()),
    [stagedApi.stagedByPack],
  );
  const pushedIds = React.useMemo(
    () => new Set(pushedByPack.keys()),
    [pushedByPack],
  );

  const onVisibleIdsChange = React.useCallback((ids: string[]) => {
    setVisibleIds(ids);
  }, []);

  // ── F1 / F2 — rail failure / empty snapshot states ───────────────────────
  if (rows.length === 0) {
    return (
      <div className="rounded-md border">
        {railError ? (
          <EmptyState
            icon={Layers}
            title={F2_RAIL_FAILED_TITLE}
            description="The risk-snapshot read failed. Retry — the rail seed is a cheap cached read now."
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => startTransition(() => router.refresh())}
              >
                <RotateCw className="size-3.5" />
                Retry
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={Layers}
            title={F1_NO_SNAPSHOT_TITLE}
            description={F1_NO_SNAPSHOT_BODY}
            action={
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link href="/pack-studio/doctor" />}
              >
                Open Pack Doctor
              </Button>
            }
          />
        )}
      </div>
    );
  }

  const outOfScope =
    selectedPackId !== null &&
    selectedEntry !== undefined &&
    selectedEntry.status === "ready" &&
    selectedEntry.basisKey === selectedBasis &&
    selectedEntry.plan === null;

  return (
    <div className="space-y-4">
      <PortfolioStrip rows={patchedRows} pushedCount={pushedByPack.size} />

      <BulkBar
        checkedIds={orderedChecked}
        rowsById={rowsById}
        stagedIds={stagedIds}
        getToken={getToken}
        remintToken={remintToken}
        onClearSelection={() => setCheckedIds(new Set())}
        onUncheck={(packId) =>
          setCheckedIds((prev) => delSet(prev, packId))
        }
        onPushed={applyPushBookkeeping}
      />

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <PackRail
          rows={patchedRows}
          selectedPackId={selectedPackId}
          checkedIds={checkedIds}
          stagedIds={stagedIds}
          pushedIds={pushedIds}
          verdictByPack={verdictByPack}
          searchInputRef={searchInputRef}
          onSelect={select}
          onCheck={handleCheck}
          onVisibleIdsChange={onVisibleIdsChange}
        />

        <section className="min-w-0">
          {!selectedRow ? (
            <div className="rounded-md border">
              <EmptyState
                icon={MousePointerClick}
                title="Pick a pack"
                description="Select a pack from the rail — its plan is computed on selection, single-pack. Nothing writes until you confirm twice."
              />
            </div>
          ) : selectedPoolError ? (
            <div className="rounded-md border">
              <EmptyState
                icon={Layers}
                title={F3_PACK_GONE}
                description="Pick another pack — the rail drops it on the next refresh."
              />
            </div>
          ) : outOfScope ? (
            <div className="rounded-md border">
              <EmptyState
                icon={Layers}
                title={F4_OUT_OF_SCOPE}
                description="Retune plans only apply to active, priced packs."
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={<Link href={`/packs/${selectedRow.packId}`} />}
                  >
                    <ExternalLink className="size-3.5" />
                    Open pack
                  </Button>
                }
              />
            </div>
          ) : (
            <FadeIn key={selectedRow.packId}>
              <PlanPanel
                row={selectedRow}
                status={status}
                plan={planForBasis}
                lastPlanBefore={selectedEntry?.plan?.before ?? null}
                planError={selectedEntry?.error ?? null}
                estimate={estimate}
                staged={selectedStaged}
                pushed={pushedByPack.get(selectedRow.packId)}
                refusal={refusalByPack.get(selectedRow.packId) ?? null}
                rebased={rebasedPacks.has(selectedRow.packId)}
                fixLoopSuccess={fixLoopPacks.has(selectedRow.packId)}
                driftPrompt={driftPrompts.has(selectedRow.packId)}
                tagSource={tagSource}
                nextSuggestion={
                  nextSuggestionByPack.get(selectedRow.packId) ?? null
                }
                pushEnabled={pushEnabled}
                pushing={pushing}
                onReplan={() =>
                  void requestPlan(selectedRow.packId, { fresh: true })
                }
                onResetToLive={() => resetToLive(selectedRow.packId)}
                onPush={() => void openPushConfirm()}
                onRetryPlan={() =>
                  void requestPlan(selectedRow.packId, { fresh: true })
                }
                onAddCardRange={(range) => openPicker(range)}
                onKeepRehydrated={() => keepRehydrated(selectedRow.packId)}
                onDiscardRehydrated={() =>
                  discardRehydrated(selectedRow.packId)
                }
                onClearAllPins={clearAllPins}
                onSelectPack={(packId) => {
                  select(packId);
                  document
                    .querySelector(`[data-rail-row="${packId}"]`)
                    ?.scrollIntoView({ block: "nearest" });
                }}
              >
                <div className="space-y-3">
                  <SectionHeading
                    icon={Layers}
                    title="Pool"
                    action={
                      <Link
                        href="/pack-studio/drafts"
                        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        Hand-typed odds → Drafts
                      </Link>
                    }
                  />
                  {selectedPool ? (
                    <PoolTable
                      rows={diffRows}
                      contextPrice={
                        planForBasis?.priceAfter ??
                        selectedStaged?.price ??
                        selectedPool.price
                      }
                      oddsTotal={oddsTotal}
                      autoHintByCardId={autoHintByCardId}
                      priceText={priceText}
                      pinPrice={selectedStaged?.pinPrice ?? false}
                      disabled={pushing}
                      pickerOpen={pickerOpen}
                      pickerRange={pickerRange}
                      pickerFilters={pickerFilters}
                      pickerSelectedIds={
                        selectedStaged
                          ? selectedStaged.cards.map((c) => c.cardId)
                          : selectedPool.cards.map((c) => c.cardId)
                      }
                      onPickerOpenChange={setPickerOpen}
                      onPickCard={addCard}
                      onRemove={removeCard}
                      onUndoRemove={undoRemove}
                      onColorChange={(cardId, color) =>
                        changeCosmetic(cardId, { color })
                      }
                      onAnimationChange={(cardId, animation) =>
                        changeCosmetic(cardId, { animation })
                      }
                      onPinCard={pinCard}
                      onPinClear={clearPin}
                      onPriceTextChange={(text) => {
                        setPriceText(text);
                        commitPrice(text, false);
                      }}
                      onPriceCommit={() => commitPrice(priceText, true)}
                      onPinToggle={togglePin}
                      onOpenPicker={() => openPicker(null)}
                    />
                  ) : (
                    <TableSkeleton rows={6} columns={5} />
                  )}
                </div>
              </PlanPanel>
            </FadeIn>
          )}
        </section>
      </div>

      <PushConfirm
        pending={pendingPush}
        pushing={pushing}
        onContinue={confirmStep2}
        onConfirm={confirmPush}
        onBackToStep1={() =>
          setPendingPush((pp) => (pp ? { ...pp, step: 1 } : pp))
        }
        onClose={() => {
          if (!pushing) setPendingPush(null);
        }}
      />
    </div>
  );
}
