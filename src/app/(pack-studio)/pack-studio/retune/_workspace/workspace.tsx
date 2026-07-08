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
  type StagedTagOverride,
} from "../../doctor/retune-actions";
import type { BuilderCardItem } from "../../builder/actions";
import type { RetuneRailRow } from "../_queries/rail";
import { buildCardDiffRows } from "./card-diff-table";
import { reconcileOddsForDisplay } from "./odds-display";
import { BulkBar } from "./bulk-bar";
import { PackRail, attentionCompare } from "./pack-rail";
import { PlanPanel, type PlanRefusal } from "./plan-panel";
import {
  F1_NO_SNAPSHOT_BODY,
  F1_NO_SNAPSHOT_TITLE,
  F2_RAIL_FAILED_TITLE,
  F3_PACK_GONE,
  F4_OUT_OF_SCOPE,
  AS_IS_SECONDARY_HEADING,
  DEGENERATE_BADGE,
  PUSH_KEPT_PENDING_TOAST,
  applyDroppedEditsToast,
  pendingDroppedDriftToast,
  pinRemedyKindLabel,
  pushBlockedPendingToast,
  suggestionKindLabel,
} from "./plan-copy";
import {
  basisKey,
  deriveStatus,
  isPoolDriftRefusal,
  isPriceSkewRefusal,
  isPushEnabled,
  isTokenExpired,
  mergePendingIntoPins,
  pendingOddsTotal,
  reanchorStagedPool,
  seedStagedPool,
  stagedPlanInput,
  stagedWriteInput,
  type PackVerdict,
  type PendingPreflightView,
  type PlanEntry,
  type PreflightEntry,
  type PushedInfo,
  type RemedyChip,
  type StagedCard,
  type StagedPool,
} from "./plan-state";
import type { RetunePinnedOdds } from "@/app/(admin)/packs/_lib/retune-params";
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
  /**
   * The tag the push actually left (`plan.intendedHitRate` — override-aware:
   * a staged untag → null, a retag → the new rate, else the live tag). The
   * rail's tag chip + offTagLive recompute read THIS post-push, so a pushed
   * untag doesn't keep waving the stale live tag until `router.refresh()`.
   */
  tag: number | null;
};

type WriteResult = PackRetuneResult | ApplyStagedRetuneResult;

const PLAN_CONTEXT = "pack-studio.retune.plan-pack";
const PREFLIGHT_CONTEXT = "pack-studio.retune.preflight";
const PLAN_TIMEOUT_MS = 20_000;
const PRICE_DEBOUNCE_MS = 500;
/** Stable pause after the last typed odd before the dry-run pre-flight fires. */
const PREFLIGHT_DEBOUNCE_MS = 800;
const BULK_HANDOFF_KEY = "pack-studio.retune.bulk-handoff";

/** Stable empty pending-buffer reference (avoids per-render array identity churn). */
const EMPTY_PENDING: RetunePinnedOdds[] = [];

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
  tunedCount,
  tunedPackIds,
  initialPackId,
  initialBulk,
}: {
  rows: RetuneRailRow[];
  railError: string | null;
  /**
   * Persistent, server-derived count of DISTINCT packs that have a workspace
   * push recorded (edit/retune snapshots) — survives sessions/browsers. Drives
   * the "Tuned: X / N · M remaining" KPI. Packs pushed THIS session that the
   * server count hasn't picked up yet (pre-`router.refresh`) are unioned in
   * client-side so the tile can never read lower than reality.
   */
  tunedCount: number;
  /**
   * The SAME set the count is derived from, as ids — the persistent list of
   * packs already tuned via the workspace. Unioned with this session's pushes
   * into `doneIds`, which drives the rail's Remaining/Done tab split (a pack
   * pushed this session moves to Done immediately, before the 60s cache/refresh).
   */
  tunedPackIds: string[];
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
  // Pending pre-flight entries (dry-run verdicts) — SEPARATE from `planByPack`
  // by construction: a pre-flight plan can never become the pushable plan.
  const [preflightByPack, setPreflightByPack] = React.useState<
    Map<string, PreflightEntry>
  >(() => new Map());

  const tokenRef = React.useRef<string | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const seqRef = React.useRef<Map<string, number>>(new Map());
  const replanTimerRef = React.useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  // Pre-flight seq/debounce — its OWN counters (sharing `seqRef` would let a
  // dry-run invalidate a real in-flight plan response, or vice versa).
  const preflightSeqRef = React.useRef<Map<string, number>>(new Map());
  const preflightTimerRef = React.useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  // Price-input typing debounce (stage on flush only — never per keystroke).
  const priceDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
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
        // The tag the push WROTE (override-aware) — not the pre-push live tag.
        tag: p.tag,
        offTagLive:
          p.tag !== null && Math.abs(p.winRate - p.tag) > 0.001 + 1e-12,
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
      // Rail mark from the SERVER verdict (wave 2c): a tag-law refusal
      // (`tag-unreachable` / `monotone-unreachable`) gets the amber retag-
      // triage Tag mark — actionable, distinct from the generic rose dot.
      setVerdictByPack((prev) =>
        setMap(
          prev,
          packId,
          data === null
            ? "infeasible"
            : data.feasible
              ? "ok"
              : data.verdict.kind === "tag-unreachable" ||
                  data.verdict.kind === "monotone-unreachable"
                ? "tag"
                : "infeasible",
        ),
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

  // F17-mirror for the PENDING buffer: a rehydrated buffer of typed odds is
  // only trusted against the SAME pool identity it was typed on (its
  // `baseFingerprint`, recorded at first edit). Unlike staged pools —
  // structural edits worth a keep/re-anchor prompt — typed odds against a
  // pool that has since changed are just stale numbers: drop them with an
  // honest toast (legacy fingerprint-less buffers are unverifiable ⇒ dropped
  // too, never silently trusted).
  const runPendingRehydrationCheck = React.useCallback(
    (packId: string, pool: EditPool) => {
      if (!stagedApi.pendingRehydratedIds.has(packId)) return;
      const entry = stagedApi.getPendingEntry(packId);
      if (!entry || entry.edits.length === 0) {
        stagedApi.resolvePendingRehydrated(packId);
        return;
      }
      const liveFp = computePoolFingerprint(
        pool.price,
        pool.cards.map((c) => ({ cardId: c.cardId, weight: c.weight })),
      );
      if (entry.baseFingerprint !== liveFp) {
        const count = entry.edits.length;
        stagedApi.clearPending(packId); // also clears the rehydrated mark
        toast.warning(pendingDroppedDriftToast(count));
        return;
      }
      stagedApi.resolvePendingRehydrated(packId);
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
          if (pool2) {
            runRehydrationCheck(packId, pool2);
            runPendingRehydrationCheck(packId, pool2);
          }
        })();
      });
    },
    [
      stagedApi,
      rowsById,
      ensurePool,
      requestPlan,
      runRehydrationCheck,
      runPendingRehydrationCheck,
    ],
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
      // A pending edit on the removed card has nothing left to bind — drop it.
      const buffer = stagedApi.getPending(packId);
      if (buffer.some((p) => p.cardId === cardId)) {
        stagedApi.setPending(
          packId,
          buffer.filter((p) => p.cardId !== cardId),
        );
      }
      void requestPlan(packId);
    },
    [ensureStaged, stagedApi, requestPlan],
  );

  // ── Owner pins (§ pins) + PENDING edits (batch several before applying) ──
  //
  // The Planned % cells now write to a client-side PENDING buffer instead of
  // pinning immediately: typing + Enter/Tab buffers the value and moves to the
  // next cell (no re-plan). APPLY commits the whole buffer as pins in ONE
  // staged call (one re-plan); DISCARD drops it. A COMMITTED pin (the amber pin
  // chip) is still solve-relevant and its X clears it immediately (below).

  // Buffer a typed Planned % edit — no staged mutation, no re-plan. Only cards
  // currently in the pool (staged pool if one exists, else the live pool —
  // or, on the instant table before the pool read lands, the current plan's
  // planned rows) are valid targets; a value on a card outside is ignored.
  // The FIRST edit records the pool identity (`baseFingerprint`) the values
  // are typed against, so a rehydrated buffer can be drift-checked later.
  const addPendingEdit = React.useCallback(
    (cardId: string, pct: number) => {
      const packId = selectedRef.current;
      if (!packId) return;
      const sp = stagedApi.getStaged(packId);
      const pool = poolByPackRef.current.get(packId) ?? null;
      const entry = planByPackRef.current.get(packId);
      // Plan rows count only for the CURRENT basis (the rows on screen).
      const planForRows =
        entry &&
        entry.basisKey === basisKey(packId, sp) &&
        entry.plan !== null
          ? entry.plan
          : null;
      const inPool = sp
        ? sp.cards.some((c) => c.cardId === cardId)
        : pool
          ? pool.cards.some((c) => c.cardId === cardId)
          : (planForRows?.planned.some((p) => p.cardId === cardId) ?? false);
      if (!inPool) return;
      const buffer = stagedApi.getPending(packId);
      const existing = buffer.find((p) => p.cardId === cardId);
      if (existing && existing.pct === pct) return; // no-op
      // First edit anchors the buffer to the pool identity on screen: the
      // staged pool's base anchor, else the live pool's fingerprint, else the
      // plan's own pool fingerprint (instant table). All three name the same
      // live pool the displayed odds were computed from.
      const baseFingerprint =
        buffer.length === 0
          ? sp
            ? sp.baseFingerprint
            : pool
              ? computePoolFingerprint(
                  pool.price,
                  pool.cards.map((c) => ({
                    cardId: c.cardId,
                    weight: c.weight,
                  })),
                )
              : (planForRows?.poolFingerprint ?? null)
          : undefined;
      stagedApi.setPending(
        packId,
        [...buffer.filter((p) => p.cardId !== cardId), { cardId, pct }],
        baseFingerprint,
      );
    },
    [stagedApi],
  );

  // Drop one card's pending edit (its cell reverts to planned/pinned). No re-plan.
  const clearPendingEdit = React.useCallback(
    (cardId: string) => {
      const packId = selectedRef.current;
      if (!packId) return;
      const buffer = stagedApi.getPending(packId);
      if (!buffer.some((p) => p.cardId === cardId)) return;
      stagedApi.setPending(
        packId,
        buffer.filter((p) => p.cardId !== cardId),
      );
    },
    [stagedApi],
  );

  // APPLY: commit EVERY buffered edit as a pin into the staged pool in ONE
  // setStaged → the plan re-fires ONCE with the full pinnedOdds set. This is the
  // same staged path a single pin used before — just carrying N pins at once.
  const applyPending = React.useCallback(() => {
    const packId = selectedRef.current;
    if (!packId) return;
    const buffer = stagedApi.getPending(packId);
    if (buffer.length === 0) return;
    const sp = ensureStaged(packId);
    if (!sp) return;
    // Only pins on cards still in the staged pool bind (mirrors pinCard's guard);
    // a pending edit on a card that was removed since typing is dropped — and
    // SAID, never silent (the operator typed it; they hear where it went).
    const inPool = new Set(sp.cards.map((c) => c.cardId));
    const validPending = buffer.filter((p) => inPool.has(p.cardId));
    const dropped = buffer.length - validPending.length;
    if (dropped > 0) toast.warning(applyDroppedEditsToast(dropped));
    stagedApi.clearPending(packId);
    if (validPending.length === 0) return;
    const nextPins: RetunePinnedOdds[] = mergePendingIntoPins(
      sp.pinnedOdds,
      validPending,
    );
    stagedApi.setStaged(packId, { ...sp, pinnedOdds: nextPins });
    void requestPlan(packId); // ONE re-plan for the whole batch
  }, [ensureStaged, stagedApi, requestPlan]);

  // DISCARD: drop the whole buffer — cells revert to planned/pinned, no re-plan.
  const discardPending = React.useCallback(() => {
    const packId = selectedRef.current;
    if (!packId) return;
    stagedApi.clearPending(packId);
  }, [stagedApi]);

  // ── Pending pre-flight (auto-balance dry-run) ────────────────────────────
  // While the buffer is non-empty, a debounced READ-ONLY `planPackTune` over
  // the MERGE of the committed staged facts + the pending pins answers "would
  // these odds solve?" BEFORE Apply. Mirrors `requestPlan`'s discipline — one
  // in flight per pack, seq-guarded, stale responses dropped — on its OWN
  // counters (a dry-run must never invalidate, or be invalidated by, the real
  // plan's seq). The result lives in `preflightByPack` ONLY: it can never
  // become the pushable plan, and the render key-gates it to the CURRENT
  // merge so a stale verdict is never surfaced.
  const requestPreflight = React.useCallback(
    async (packId: string) => {
      const pending = stagedApi.getPending(packId);
      if (pending.length === 0) {
        setPreflightByPack((prev) => delMap(prev, packId));
        return;
      }
      const sp =
        stagedApi.getStaged(packId) ??
        (() => {
          const pool = poolByPackRef.current.get(packId);
          return pool ? seedStagedPool(pool) : null;
        })();
      // No structural basis yet (pool read still in flight) — the bar keeps
      // its "checking" line; the debounce re-fires when the pool lands.
      if (!sp) return;
      const inPool = new Set(sp.cards.map((c) => c.cardId));
      const valid = pending.filter((p) => inPool.has(p.cardId));
      if (valid.length === 0) {
        setPreflightByPack((prev) => delMap(prev, packId));
        return;
      }
      const merged: StagedPool = {
        ...sp,
        pinnedOdds: mergePendingIntoPins(sp.pinnedOdds, valid),
      };
      const key = basisKey(packId, merged);
      const seq = (preflightSeqRef.current.get(packId) ?? 0) + 1;
      preflightSeqRef.current.set(packId, seq);
      setPreflightByPack((prev) => {
        const old = prev.get(packId);
        return setMap(prev, packId, {
          key,
          seq,
          status: "loading",
          plan: old && old.key === key ? old.plan : null,
        });
      });
      const { data, error } = await safeQueryOrNull(
        () => planPackTune(packId, stagedPlanInput(merged), null),
        PREFLIGHT_CONTEXT,
        PLAN_TIMEOUT_MS,
      );
      // Stale seq — a newer pre-flight superseded this one; drop it.
      if ((preflightSeqRef.current.get(packId) ?? 0) !== seq) return;
      setPreflightByPack((prev) =>
        setMap(prev, packId, {
          key,
          seq,
          status: error ? "error" : "ready",
          plan: data ?? null,
          ...(error ? { error } : {}),
        }),
      );
    },
    [stagedApi],
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

  // ── Manual row reorder (owner feature, 2026-07-04) ───────────────────────
  // Move ONE card one step up/down in the DISPLAY order — which becomes
  // `pack_cards.order` at push time. Reordering is NOT solve-relevant: it never
  // touches `stagedKey` (the plan cache keys on the SORTED card-id set), never
  // re-plans, and never changes which card gets which planned % (the solver
  // assigns odds by value/target and the display maps them by cardId). It only
  // sets the persisted order. The FIRST move snapshots the current value-DESC
  // display order into the staged `cards` array (so array order == what the
  // operator sees) and flips `manualOrder` on; later moves shuffle that array.
  const moveCard = React.useCallback(
    (cardId: string, direction: "up" | "down") => {
      const packId = selectedRef.current;
      if (!packId) return;
      const sp = ensureStaged(packId);
      if (!sp) return;
      // The array the display shows: already the staged order once manual, else
      // the value-DESC view sort (a stable copy — never mutate state in place).
      const ordered = sp.manualOrder
        ? [...sp.cards]
        : [...sp.cards].sort((a, b) => b.value - a.value);
      const idx = ordered.findIndex((c) => c.cardId === cardId);
      if (idx === -1) return;
      const target = direction === "up" ? idx - 1 : idx + 1;
      if (target < 0 || target >= ordered.length) return; // clamped at the ends
      // Swap the two adjacent rows.
      [ordered[idx], ordered[target]] = [ordered[target]!, ordered[idx]!];
      stagedApi.setStaged(packId, {
        ...sp,
        cards: ordered,
        manualOrder: true,
      });
      // NO requestPlan — `stagedKey` is unchanged, so the landed plan stays
      // valid and every card keeps its planned %.
    },
    [ensureStaged, stagedApi],
  );

  // ── Owner tag override (tag control, 2026-07-04) ─────────────────────────
  // Change or remove the pack's product tag from the workspace header. Setting
  // it flips the pack to the staged arm and re-plans IMMEDIATELY (a tag change
  // is solve-relevant — the owner said "when i remove replan"): removing the
  // tag makes the plan UNTAGGED (fast, live-anchored); a tag pins the plan to
  // its designed win-rate. On push the change is written to `packs.tags`.
  // `override === undefined` clears any override (revert to the live tag).
  const changeTagOverride = React.useCallback(
    (override: StagedTagOverride | undefined) => {
      const packId = selectedRef.current;
      if (!packId) return;
      const sp = ensureStaged(packId);
      if (!sp) return;
      // No-op guard: same override already staged → don't re-plan.
      const sameKind =
        (sp.tagOverride?.kind ?? "live") === (override?.kind ?? "live");
      const sameTag =
        sp.tagOverride?.kind === "tag" && override?.kind === "tag"
          ? sp.tagOverride.tag === override.tag
          : true;
      if (sameKind && sameTag) return;
      const next = { ...sp };
      if (override === undefined) {
        delete next.tagOverride;
      } else {
        next.tagOverride = override;
      }
      stagedApi.setStaged(packId, next);
      void requestPlan(packId); // tag change → immediate re-plan (staged arm)
    },
    [ensureStaged, stagedApi, requestPlan],
  );

  // Commit a typed price into the staged pool. Called ONLY on a debounce
  // flush (500ms after the last keystroke) or an explicit Enter/blur — never
  // per keystroke, so a half-typed "4" of "43" can never mint a staged pool
  // or anchor a plan. Staging + re-plan happen together at the flush, keeping
  // the effective plan debounce at the same 500ms it always was. `packId` is
  // captured at schedule time (the pack the text was typed on), never read
  // from the selection at fire time.
  const commitPrice = React.useCallback(
    (packId: string, raw: string, mode: "debounced" | "flush") => {
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      const existing = stagedApi.getStaged(packId);
      const base = existing ?? ensureStaged(packId);
      if (!base) return;
      if (Math.abs(base.price - parsed) < 0.005) {
        // No solve-relevant change — never mint a staged pool for a no-op.
        // Only an explicit Enter/blur re-plans an unchanged price (legacy
        // recovery affordance); the typing debounce stays silent.
        if (existing && mode === "flush") void requestPlan(packId);
        return;
      }
      stagedApi.setStaged(packId, { ...base, price: parsed });
      void requestPlan(packId);
    },
    [ensureStaged, stagedApi, requestPlan],
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
      stagedApi.clearPending(packId); // drop any un-applied typed edits too
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

  // ── §3 pool-edits-first: one-click stage the plan's poolEditPlan ─────────
  // Applies the pool edit's removals + price + pinPrice in ONE setStaged, then
  // (when it carries an add-card lever) opens the picker pre-filtered to its
  // value band — the owner picks a REAL card, which flows through the existing
  // add-card staging → re-plan. When there's no add-card, re-plan directly.
  // NEVER writes — staging only; push stays behind the two-step confirm.
  const stagePoolEdit = React.useCallback(() => {
    const packId = selectedRef.current;
    if (!packId) return;
    const entry = planByPackRef.current.get(packId);
    const pe = entry?.plan?.poolEditPlan ?? null;
    if (!pe) return;
    const sp = ensureStaged(packId);
    if (!sp) return;
    const removeSet = new Set(pe.removeCardIds);
    // Live cards → removed (Undo); added cards just dropped; their pins dropped
    // (same rules as removeCard). Only cards currently in the staged pool.
    const removedNow = sp.cards.filter(
      (c) => removeSet.has(c.cardId) && !c.added,
    );
    const nextCards = sp.cards.filter((c) => !removeSet.has(c.cardId));
    const nextRemoved = [...sp.removed, ...removedNow];
    const droppedIds = new Set(pe.removeCardIds);
    stagedApi.setStaged(packId, {
      ...sp,
      cards: nextCards,
      removed: nextRemoved,
      pinnedOdds: sp.pinnedOdds.filter((p) => !droppedIds.has(p.cardId)),
      ...(pe.price !== null ? { price: pe.price } : {}),
      // An add-card fix pins the price so the free search can't drift the
      // spread back (the untagged spread-fix contract); a pure-removal / price
      // fix respects whatever the derived plan carried.
      ...(pe.addCard !== null && pe.price !== null ? { pinPrice: true } : {}),
    });
    if (pe.addCard !== null) {
      openPicker({ min: pe.addCard.valueMin, max: pe.addCard.valueMax });
    } else {
      void requestPlan(packId);
    }
  }, [ensureStaged, stagedApi, openPicker, requestPlan]);

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
          // The tag the write left (override-aware): a pushed untag → null,
          // a pushed retag → the new rate, else the plan's live tag.
          tag: plan.intendedHitRate,
        }),
      );
      debouncedRefresh();
    },
    [rowsById, debouncedRefresh],
  );

  const handleWriteSuccess = React.useCallback(
    (pp: PendingPush, result: WriteResult) => {
      stagedApi.clearStaged(pp.packId);
      // LAW P: a push NEVER silently deletes typed odds. The gate keeps a
      // push from starting over a non-empty buffer, so edits here were typed
      // while the write was in flight — keep them and say so (they simply
      // were not part of this push).
      const keptPending = stagedApi.getPending(pp.packId);
      if (keptPending.length > 0) {
        toast.info(PUSH_KEPT_PENDING_TOAST);
      } else {
        stagedApi.clearPending(pp.packId);
      }
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
    // LAW P (preview ≡ write): typed-but-not-applied odds are NOT in the
    // landed plan — the confirm never opens over them. `isPushEnabled`
    // already disables the button; this guards the keyboard "p" and any
    // other programmatic path, with the reason said out loud.
    const pendingEdits = stagedApi.getPending(packId);
    if (pendingEdits.length > 0) {
      toast.error(pushBlockedPendingToast(pendingEdits.length));
      return;
    }
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
      // Re-read at freeze (defensive) — the gate above guarantees 0; any
      // non-zero renders the rose banner in step 1.
      pendingAtFreeze: stagedApi.getPending(packId).length,
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
    // swaps to "Plan changed underneath — nothing was written" (F10). A
    // pending buffer minted while the confirm sat open counts as a change:
    // the frozen plan doesn't contain those typed odds (LAW P).
    const sp = stagedApi.getStaged(pp.packId);
    const basisNow = basisKey(pp.packId, sp);
    const fingerprintOk =
      sp === null || pp.frozen.poolFingerprint === sp.baseFingerprint;
    const pendingNow = stagedApi.getPending(pp.packId);
    if (
      basisNow !== pp.frozenBasisKey ||
      !fingerprintOk ||
      pendingNow.length > 0
    ) {
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
  // Stable identity: the entry's `edits` array is a stable reference between
  // renders (only replaced on a real buffer change), so memoizing on the map +
  // selection keeps `diffRows` / `pendingTotal` from re-computing every render.
  const selectedPending = React.useMemo(
    () =>
      selectedPackId
        ? (stagedApi.pendingByPack.get(selectedPackId)?.edits ?? EMPTY_PENDING)
        : EMPTY_PENDING,
    [selectedPackId, stagedApi.pendingByPack],
  );
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
      pendingCount: selectedPending.length,
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
        pending: selectedPending,
      }),
    [selectedPool, selectedStaged, planForBasis, selectedPending],
  );

  // Live total-% the pending+committed odds would land at (the readout the
  // owner watches before Apply). Base = the plan's planned odds (committed pins
  // already folded in); each pending edit overrides its card's share.
  const pendingTotal = React.useMemo(
    () => pendingOddsTotal(planForBasis?.planned ?? null, selectedPending),
    [planForBasis, selectedPending],
  );

  // Debounced pre-flight while the buffer is non-empty: 800ms of quiet after
  // the last typed odd (or a staged/pool change under a live buffer) fires
  // the dry-run; emptying the buffer (Apply/Discard/drop) clears the timer
  // AND the entry so no verdict outlives its edits.
  React.useEffect(() => {
    const packId = selectedPackId;
    if (!packId) return;
    const timer = preflightTimerRef.current.get(packId);
    if (timer) {
      clearTimeout(timer);
      preflightTimerRef.current.delete(packId);
    }
    if (selectedPending.length === 0) {
      setPreflightByPack((prev) => delMap(prev, packId));
      return;
    }
    preflightTimerRef.current.set(
      packId,
      setTimeout(() => {
        preflightTimerRef.current.delete(packId);
        void requestPreflight(packId);
      }, PREFLIGHT_DEBOUNCE_MS),
    );
  }, [
    selectedPackId,
    selectedPending,
    selectedStaged,
    selectedPool,
    requestPreflight,
  ]);

  // The pending-edits bar's verdict view — derived, display-only, key-gated
  // to the CURRENT merge (an entry for yesterday's buffer renders as
  // "checking…", mirroring `planForBasis`' basis discipline).
  const pendingPreflight = React.useMemo((): PendingPreflightView | null => {
    if (!selectedPackId || selectedPending.length === 0) return null;
    const sp =
      selectedStaged ?? (selectedPool ? seedStagedPool(selectedPool) : null);
    if (!sp) return { status: "loading" };
    const inPool = new Set(sp.cards.map((c) => c.cardId));
    const valid = selectedPending.filter((p) => inPool.has(p.cardId));
    if (valid.length === 0) return null;
    const merged: StagedPool = {
      ...sp,
      pinnedOdds: mergePendingIntoPins(sp.pinnedOdds, valid),
    };
    const key = basisKey(selectedPackId, merged);
    const entry = preflightByPack.get(selectedPackId);
    if (!entry || entry.key !== key || entry.status === "loading") {
      return { status: "loading" };
    }
    if (entry.status === "error" || entry.plan === null) {
      return { status: "error" };
    }
    const p = entry.plan;
    if (p.feasible && p.after !== null) {
      return {
        status: "ready",
        feasible: true,
        priceAfter: p.priceAfter,
        edgePct: p.after.edge * 100,
      };
    }
    // Refusal view from the SERVER verdict (wave 2c): its detail carries the
    // engine WHY (for a pins refusal: the shortfall + smallest verified fix),
    // its VERIFIED pin remedies render as the chips (solver-proven — they
    // outrank the plain guidance chips, which remain the fallback for every
    // other refusal), and its ONE `action` is the no-chips suggestion line.
    const chips: RemedyChip[] =
      p.verdict.pinRemedies !== null && p.verdict.pinRemedies.length > 0
        ? p.verdict.pinRemedies.map((r, i) => ({
            key: `${r.kind}-${i}`,
            label: pinRemedyKindLabel(r.kind),
            detail: r.humanCopy,
          }))
        : (p.guidance?.suggestions ?? []).map((s, i) => ({
            key: `${s.kind}-${i}`,
            label: suggestionKindLabel(s.kind),
            detail: s.humanCopy,
          }));
    return {
      status: "ready",
      feasible: false,
      detail: p.verdict.detail ?? p.verdict.headline,
      suggestion: chips.length === 0 ? p.verdict.action : null,
      chips,
    };
  }, [
    selectedPackId,
    selectedPending,
    selectedStaged,
    selectedPool,
    preflightByPack,
  ]);

  // The total-odds chip sums the DISPLAY-RECONCILED vector — the SAME numbers
  // the Planned-% cells render (buffer carries the rounding residual) — never
  // the raw underlying pcts. So the chip can never stamp "match 100%" while the
  // visible column disagrees: the reconciled vector sums to exactly 100 by
  // construction, and the column shows exactly those values. Cap-dropped cards
  // (drop verdict, not a chance) are excluded, matching `buildCardDiffRows`.
  const oddsTotal = React.useMemo(() => {
    if (!planForBasis || planForBasis.planned.length === 0) return 100;
    const capDropped = planForBasis.feasible
      ? new Set(planForBasis.capDroppedCardIds)
      : new Set<string>();
    const vector = planForBasis.planned
      .filter((p) => !capDropped.has(p.cardId))
      .map((p) => p.pct);
    if (vector.length === 0) return 100;
    return reconcileOddsForDisplay(vector).reduce((s, p) => s + p, 0);
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
  // Staged tag overrides for the rail's effective-tag chips. The override
  // objects are stable references inside their staged pools, so the memoized
  // rail rows only re-render when an override actually changes.
  const tagOverrideByPack = React.useMemo(() => {
    const out = new Map<string, StagedTagOverride>();
    for (const [id, sp] of stagedApi.stagedByPack) {
      if (sp.tagOverride !== undefined) out.set(id, sp.tagOverride);
    }
    return out;
  }, [stagedApi.stagedByPack]);
  const pushedIds = React.useMemo(
    () => new Set(pushedByPack.keys()),
    [pushedByPack],
  );

  // Done = tuned-ever (server, persistent across sessions/browsers) ∪ pushed
  // this session (so a fresh push moves the pack to Done immediately, before
  // the 60s-cached server set catches up on the debounced `router.refresh()`).
  // Drives the rail's Remaining/Done tab split.
  const doneIds = React.useMemo(
    () => new Set([...tunedPackIds, ...pushedIds]),
    [tunedPackIds, pushedIds],
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
      <PortfolioStrip
        rows={patchedRows}
        pushedThisSession={pushedByPack.size}
        serverTunedCount={tunedCount}
        // Packs pushed THIS session may not yet be in the server count (it is
        // 60s-cached + re-read on the debounced refresh) — union their ids in so
        // the counter never under-reports. The rail row set defines the fleet
        // size (183 active/priced packs); a pushed id outside it still counts as
        // tuned but is clamped so "remaining" never goes negative.
        sessionPushedIds={pushedIds}
      />

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
          doneIds={doneIds}
          verdictByPack={verdictByPack}
          tagOverrideByPack={tagOverrideByPack}
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
                tagOverride={selectedStaged?.tagOverride}
                onChangeTag={changeTagOverride}
                nextSuggestion={
                  nextSuggestionByPack.get(selectedRow.packId) ?? null
                }
                pushEnabled={pushEnabled}
                pushing={pushing}
                pendingCount={selectedPending.length}
                onReplan={() =>
                  void requestPlan(selectedRow.packId, { fresh: true })
                }
                onResetToLive={() => resetToLive(selectedRow.packId)}
                onPush={() => void openPushConfirm()}
                onRetryPlan={() =>
                  void requestPlan(selectedRow.packId, { fresh: true })
                }
                onAddCardRange={(range) => openPicker(range)}
                onStagePoolEdit={stagePoolEdit}
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
                    // §3.3: when the fixed-pool plan degenerated, the pool table
                    // IS the demoted secondary — label it so, with the badge.
                    title={
                      planForBasis?.shape?.degenerate === true
                        ? AS_IS_SECONDARY_HEADING
                        : "Pool"
                    }
                    action={
                      <div className="flex items-center gap-2">
                        {planForBasis?.shape?.degenerate === true && (
                          <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                            {DEGENERATE_BADGE}
                          </span>
                        )}
                        <Link
                          href="/pack-studio/drafts"
                          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          Hand-typed odds → Drafts
                        </Link>
                      </div>
                    }
                  />
                  {/* Instant table: the pool read (name/value/art) and the
                      plan (odds) race on selection — whichever lands FIRST
                      renders. Plan-first rows carry real odds with a shimmer
                      on the art cells (`artLoading`); the pool fills them.
                      Only when NEITHER has landed does the skeleton show. */}
                  {selectedPool || diffRows.length > 0 ? (
                    <PoolTable
                      rows={diffRows}
                      contextPrice={
                        planForBasis?.priceAfter ??
                        selectedStaged?.price ??
                        selectedPool?.price ??
                        selectedRow.price
                      }
                      oddsTotal={oddsTotal}
                      autoHintByCardId={autoHintByCardId}
                      priceText={priceText}
                      pinPrice={selectedStaged?.pinPrice ?? false}
                      disabled={pushing}
                      pendingCount={selectedPending.length}
                      pendingTotal={pendingTotal}
                      pendingPreflight={pendingPreflight}
                      pickerOpen={pickerOpen}
                      pickerRange={pickerRange}
                      pickerFilters={pickerFilters}
                      pickerSelectedIds={
                        selectedStaged
                          ? selectedStaged.cards.map((c) => c.cardId)
                          : selectedPool
                            ? selectedPool.cards.map((c) => c.cardId)
                            : diffRows
                                .filter((r) => !r.removed)
                                .map((r) => r.cardId)
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
                      onPendingEdit={addPendingEdit}
                      onPendingClear={clearPendingEdit}
                      onPinClear={clearPin}
                      onApplyPending={applyPending}
                      onDiscardPending={discardPending}
                      onPriceTextChange={(text) => {
                        // Keystrokes only update the text — staging + re-plan
                        // happen at the debounce flush (or Enter/blur), with
                        // the pack captured NOW (never the selection at fire
                        // time).
                        setPriceText(text);
                        const packId = selectedRow.packId;
                        if (priceDebounceRef.current) {
                          clearTimeout(priceDebounceRef.current);
                        }
                        priceDebounceRef.current = setTimeout(() => {
                          priceDebounceRef.current = null;
                          commitPrice(packId, text, "debounced");
                        }, PRICE_DEBOUNCE_MS);
                      }}
                      onPriceCommit={() => {
                        if (priceDebounceRef.current) {
                          clearTimeout(priceDebounceRef.current);
                          priceDebounceRef.current = null;
                        }
                        commitPrice(selectedRow.packId, priceText, "flush");
                      }}
                      onPinToggle={togglePin}
                      onOpenPicker={() => openPicker(null)}
                      onMoveCard={moveCard}
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
