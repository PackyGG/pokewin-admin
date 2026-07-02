"use client";

import * as React from "react";
import {
  ArrowRight,
  Check,
  Info,
  Loader2,
  Sparkles,
  TriangleAlert,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AnimatedNumber } from "@/components/animated-number";
import { InfoHint } from "@/app/(admin)/creators/_components/info-hint";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
  computePackRisk,
  searchBestPriceForCleanSnap,
  shapeWeights,
  type PackRisk,
} from "@/app/(admin)/insights/edge-calc/risk";
import {
  SortableCardTable,
  type SortableCard,
} from "@/app/(admin)/packs/sortable-card-table";

import { BuilderCardPicker } from "../builder/builder-card-picker";
import type { BuilderCardItem } from "../builder/actions";
import {
  getPackEditPool,
  getRetunePickerFilters,
  type EditPool,
  type RetunePickerFilters,
} from "../doctor/retune-actions";

/**
 * Inline card-pool editor for the Bulk Re-tune review. Lets the owner edit ONE
 * pack's pool by hand — re-weight, remove, reorder, and ADD cards — right inside
 * the review card, with a LIVE after-preview + feasibility re-check, then Approve
 * the EXACT pool it shows.
 *
 * It seeds from `getPackEditPool` (a read-only MAIN read of the pack's current
 * pool) when first opened, reuses the Builder's `<SortableCardTable>` (re-weight /
 * remove / reorder) and `<BuilderCardPicker>` (add a card — value + inPacks usage
 * shown), and recomputes the AFTER metrics + risk on every edit via the SAME pure
 * client-safe `computePackRisk` the server scores with. A "Re-shape to targets"
 * button runs the pure `shapeWeights` on the edited values to auto-distribute the
 * odds onto the pack's targets (edge curve + tag win-rate + near-miss).
 *
 * The odds field in the table is a PERCENT (0..100), exactly like the Builder.
 * On Approve the percents are converted to positive-integer weights (the unit
 * `applyPackEdit` writes) by scaling to a common denominator. Approve hands the
 * built `EditPoolInput` to the parent, which calls `applyPackEdit(packId, token,
 * …)` under the review's 2FA token.
 *
 * House-POV coloring (CLAUDE.md): an edge ≥ target is emerald (healthy margin);
 * below target is rose (giving away margin). A no-win pack (no card ≥ price) is
 * INFEASIBLE — adding a card ≥ price flips it feasible and the banner clears
 * instantly. The pure preview mirrors the server math, so what the owner sees is
 * what `applyPackEdit` writes.
 */

/** A row in the editor: identity + value + an editable odds % (display unit). */
export type EditRow = SortableCard & {
  /** True for a card pulled in via the picker (not in the live pool). */
  added: boolean;
};

/**
 * A serializable snapshot of the editor's session state. The parent persists
 * it (sessionStorage, keyed per pack) so staged edits survive closing the edit
 * section, rail navigation, and the `router.refresh()` remount — the owner's
 * "i have to redo this over and over" complaint. Restored via the
 * `initialSnapshot` prop; the live pool is STILL fetched on every open so the
 * baseline/dirty math always diffs against fresh production truth.
 */
export type PoolEditorSnapshot = {
  rows: EditRow[];
  priceText: string;
  allowPriceSearch: boolean;
};

/**
 * The staged-pool signature the parent needs while edits are staged: it (a)
 * demotes the plain Approve (which would retune the LIVE pool and ignore the
 * staged edits), and (b) drives the read-only `planStagedRetune` dry-run that
 * replaces the review card's live-pool verdict. `null` = the editor currently
 * matches the live pool (no staged edits). The `cards`/`price` shape mirrors
 * the auto-tune approve payload EXACTLY so the dry-run and the eventual write
 * receive the same pool.
 */
export type StagedPoolSignature = {
  cards: {
    cardId: string;
    color?: string;
    animation?: boolean;
    order: number;
  }[];
  /** Staged price (USD) — present only when it differs from the live price. */
  price?: number;
  allowPriceSearch: boolean;
  hasAddedCards: boolean;
};

/**
 * Auto-pick color + animation for a new pack_card, mirroring the convention
 * used by existing cards (derived from live pack_cards data, 2026-06-22).
 *
 * Rule of thumb: color is a function of card_value / pack_price. The thresholds
 * below match the medians of each color band in production and reproduce ~80–90%
 * of curated cards exactly; the rest are off-by-one tier, matching the same
 * curator-tolerance the existing pool exhibits.
 *
 *   ratio >= 10  -> gold   (animated)   — top-band jackpot, ~98% animated live
 *   ratio >= 3   -> red    (animated)   — high-value, ~94% animated live
 *   ratio >= 1.5 -> purple                — profitable
 *   ratio >= 0.75 -> blue                 — near-price / break-even
 *   ratio >= 0.2 -> green                 — sub-price
 *   else         -> white                 — dust
 *
 * Animation = true iff color is gold or red (rule of thumb from the audit;
 * other colors are animated <2% of the time live, so always-false is the
 * convention-matching default for the lower tiers).
 *
 * Guard: a non-finite or non-positive price -> white/false (safe default that
 * never auto-promotes a card to gold on a degenerate input).
 */
function autoColorAndAnimation(
  cardValue: number,
  packPrice: number,
): { color: string | null; animation: boolean } {
  if (
    !Number.isFinite(cardValue) ||
    !Number.isFinite(packPrice) ||
    packPrice <= 0
  ) {
    return { color: "white", animation: false };
  }
  const ratio = cardValue / packPrice;
  if (ratio >= 10) return { color: "gold", animation: true };
  if (ratio >= 3) return { color: "red", animation: true };
  if (ratio >= 1.5) return { color: "purple", animation: false };
  if (ratio >= 0.75) return { color: "blue", animation: false };
  if (ratio >= 0.2) return { color: "green", animation: false };
  return { color: "white", animation: false };
}

/** Human-readable summary of an auto-pick, used for the inline hint. */
function describeAutoPick(color: string | null, animation: boolean): string {
  const colorLabel = color ?? "none";
  const band =
    color === "gold"
      ? "top-band jackpot"
      : color === "red"
        ? "high-value win"
        : color === "purple"
          ? "profitable"
          : color === "blue"
            ? "near-price"
            : color === "green"
              ? "sub-price"
              : "dust";
  return `Auto: ${colorLabel}${animation ? " + animated" : ""} (${band})`;
}

/** The pack targets the "Re-shape to targets" button shapes onto. */
export type EditorTargets = {
  targetEdge: number;
  targetWinRate: number;
  maxWinCap: number | undefined;
  nearMissMin: number;
};

/** Scale a set of odds-% rows to positive-integer weights for `applyPackEdit`. */
function oddsToWeights(odds: number[]): number[] {
  // Work in ten-thousandths of a percent so 0.0001%–100% all become integers,
  // then gcd-reduce. Any zero/negative is floored to 1 (the server requires a
  // positive integer weight per card; an explicit pool has no zero-weight slot).
  const scaled = odds.map((o) =>
    Math.max(1, Math.round((Number.isFinite(o) ? o : 0) * 10000)),
  );
  const g = scaled.reduce((acc, n) => gcd(acc, n), 0) || 1;
  return scaled.map((n) => Math.max(1, Math.round(n / g)));
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x === 0 ? 1 : x;
}

/** Round an odds-% to 4 decimal places — the OddsInput's display precision. */
function round4(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 10000) / 10000;
}

/** Compute the live risk of the edited rows (odds% → weights → engine). */
function previewRisk(rows: EditRow[], price: number): PackRisk | null {
  if (rows.length === 0) return null;
  const weights = oddsToWeights(rows.map((r) => r.odds));
  return computePackRisk({
    cards: rows.map((r, i) => ({ value: r.priceUsd, weight: weights[i]! })),
    price,
  });
}

/**
 * The before/after view of the staged pool, used by the orchestrator's confirm
 * gate to render the Step 1 KPI grid + per-card diff dropdown WITHOUT having to
 * recompute anything from the proposal. Built from the editor's own state at
 * approve-time, so the table matches exactly what the editor showed.
 *
 * For verbatim the `toWeight` is the integer weight the server will write. For
 * auto-tune it is the locally shaped weight (the server re-shapes against the
 * SAME targets, so the preview matches what the server lands on).
 *
 * `fromWeight === null` means the card was ADDED via the picker (no live
 * baseline). Removed cards aren't in `cards` — they're listed in `removed`
 * (cardId + value + the live weight that goes away).
 */
export type EditPreview = {
  after: PackRisk | null;
  /**
   * The PENDING ticket price the write is expected to land, when it differs
   * from the live pack price — the owner-staged price, or (auto-tune with the
   * price-search opt-in) the clean-snap search's `bestPrice` that `after` is
   * scored at. Null = price unchanged. The confirm gate shows this as the
   * price the push will write.
   */
  newPrice: number | null;
  cards: {
    cardId: string;
    value: number;
    name: string;
    fromWeight: number | null;
    toWeight: number;
    added: boolean;
  }[];
  removed: { cardId: string; value: number; name: string; fromWeight: number }[];
};

/** The verbatim edited-pool payload — owner odds become integer weights. */
export type VerbatimApprovePayload = {
  mode: "verbatim";
  cards: {
    cardId: string;
    weight: number;
    color?: string;
    animation?: boolean;
    order: number;
  }[];
  price?: number;
  hasAddedCards: boolean;
  /** Local before/after for the confirm-gate KPI grid + per-card diff. */
  preview: EditPreview;
};

/** The staged-pool payload — server picks the weights via `shapeWeights`. */
export type AutoTuneApprovePayload = {
  mode: "auto-tune";
  cards: {
    cardId: string;
    color?: string;
    animation?: boolean;
    order: number;
  }[];
  price?: number;
  hasAddedCards: boolean;
  /**
   * Owner opt-in: allow the server to nudge the pack price by up to ±25%
   * around the staged price to land cleaner odds. Defaults to false; only
   * passed to the auto-tune action when the owner explicitly ticks the
   * "Allow price adjustment" checkbox in the editor.
   */
  allowPriceSearch?: boolean;
  /** Local before/after for the confirm-gate KPI grid + per-card diff. */
  preview: EditPreview;
};

export function PoolEditor({
  packId,
  price: packPrice,
  targets,
  applying,
  onCancel,
  onApprove,
  onApproveAutoTune,
  pickerOpen,
  onPickerOpenChange,
  pickerInitialPriceMin,
  pickerInitialPriceMax,
  onCardsAdded,
  initialSnapshot,
  onSessionChange,
}: {
  packId: string;
  /** The pack's current price (USD) — the editable starting price. */
  price: number;
  /** Targets for the "Re-shape to targets" auto-distribute button. */
  targets: EditorTargets;
  applying: boolean;
  /**
   * DISCARD the staged edits and close the editor. The parent clears the
   * persisted per-pack session — use the card's "Hide editor" toggle to close
   * WITHOUT discarding (the session is restored on reopen).
   */
  onCancel: () => void;
  /**
   * Approve the VERBATIM edited pool (advanced — writes the owner's exact
   * weights). `cards` carries every row (cardId + odds% + color + animation +
   * order); the parent converts to weights and calls `applyPackEdit`. `price`
   * is included only when the owner changed it.
   */
  onApprove: (payload: VerbatimApprovePayload) => void;
  /**
   * Approve the STAGED pool with server-side auto-tune (the safe path). The
   * server runs `shapeWeights` on the staged identity/order + price + targets
   * and writes optimized weights in ONE transaction. No client odds are sent.
   */
  onApproveAutoTune: (payload: AutoTuneApprovePayload) => void;
  /**
   * Optional controlled-open for the embedded card picker. When set, the
   * parent (review-card.tsx) can pop the picker open programmatically from a
   * "+ Add a card in this range" button on an infeasibility error — without
   * the owner having to click the "Add cards…" trigger themselves. Both props
   * must be set together to control the picker; pass `undefined` to leave it
   * uncontrolled.
   */
  pickerOpen?: boolean;
  onPickerOpenChange?: (open: boolean) => void;
  /** Optional Min/Max seeds for the picker's price filter (suggested range). */
  pickerInitialPriceMin?: number;
  pickerInitialPriceMax?: number;
  /**
   * Fires once after the picker dialog closes if the operator added at least
   * one card during that picker session. Used by the parent to re-run the
   * STAGED dry-run immediately (`planStagedRetune`) so the feasibility verdict
   * reflects the staged pool without waiting for the debounce. No-ops when the
   * picker is closed without additions.
   */
  onCardsAdded?: () => void;
  /**
   * A previously-persisted editor session to restore INSTEAD of seeding the
   * rows from the live pool. The live pool is still fetched on open — the
   * baseline (diff/dirty math) always comes from fresh production truth.
   */
  initialSnapshot?: PoolEditorSnapshot | null;
  /**
   * Reports the editor session upward on every state change: a serializable
   * snapshot (for persistence) + the staged-pool signature (`null` when the
   * editor matches the live pool). The parent persists the snapshot, demotes
   * the plain Approve while staged edits exist, and feeds the signature to the
   * read-only staged dry-run.
   */
  onSessionChange?: (
    snapshot: PoolEditorSnapshot,
    staged: StagedPoolSignature | null,
  ) => void;
}) {
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<EditRow[]>([]);
  const [priceText, setPriceText] = React.useState(String(packPrice));
  const [reshaping, setReshaping] = React.useState(false);
  // Owner opt-in: when checked, the auto-tune action sends `allowPriceSearch`
  // so the server may nudge the pack price by up to ±25% around the staged
  // price to land cleaner odds. DEFAULT ON (Owner, 2026-06-28): the owner is
  // fine with up to ±25% nudge to get clean odds; the operator can untick to
  // hold the staged price exactly for packs that need a hard-pinned price.
  const [allowPriceSearch, setAllowPriceSearch] = React.useState(true);
  // Short-lived description of the latest auto-pick, shown next to the table so
  // the owner can immediately see what color/animation was chosen for the newly
  // added card (and that they can flip it by hand in the row controls).
  const [lastAutoHint, setLastAutoHint] = React.useState<{
    cardName: string;
    color: string | null;
    animation: boolean;
  } | null>(null);

  // Card-picker filters, loaded lazily on first open (server action).
  const [filters, setFilters] = React.useState<RetunePickerFilters | null>(null);

  // Tracks whether the operator added at least one card during the CURRENT
  // picker-open session. Reset every time the picker opens; consumed (and
  // reset) when the picker closes — if true we fire `onCardsAdded` so the
  // parent can re-run the server proposal dry-run (auto-recheck). Stored in
  // a ref to avoid re-renders on every add (the picker is the consumer, not
  // any rendered child).
  const pickerAddedRef = React.useRef(false);

  // The pack's live pool at editor-open — kept verbatim so the confirm-gate's
  // per-card diff can show `fromWeight` for kept cards (and surface removed
  // cards: present here, absent from `rows`). Read-only after seed.
  const baselineRef = React.useRef<Map<
    string,
    { weight: number; name: string; value: number }
  > | null>(null);

  // The rows exactly as a fresh seed would produce them + the LIVE price —
  // the structural comparison base for "does the editor differ from the live
  // pool?" (drives the staged-signature report below). Undoing every edit by
  // hand returns the editor to a clean state.
  const seedRowsRef = React.useRef<EditRow[] | null>(null);
  const [basePrice, setBasePrice] = React.useState(packPrice);

  // Latest restore-snapshot / session-report callbacks without effect churn —
  // the seed effect must stay keyed on `packId` only, and the report effect
  // must not re-fire because the parent re-created a closure.
  const initialSnapshotRef = React.useRef(initialSnapshot);
  initialSnapshotRef.current = initialSnapshot;
  const onSessionChangeRef = React.useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;

  // Seed the editor from a fresh read of the pack's current pool on first open.
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      try {
        const [pool, picker] = await Promise.all([
          getPackEditPool(packId),
          getRetunePickerFilters(),
        ]);
        if (cancelled) return;
        // Snapshot the live pool BEFORE seeding the editable rows — the
        // confirm-gate diff reads from this to label "removed" cards and to
        // pull `fromWeight` for cards the owner kept.
        const baseline = new Map<
          string,
          { weight: number; name: string; value: number }
        >();
        for (const c of pool.cards) {
          baseline.set(c.cardId, {
            weight: c.weight,
            name: c.name,
            value: c.value,
          });
        }
        baselineRef.current = baseline;
        const seeded = seedRows(pool);
        seedRowsRef.current = seeded;
        setBasePrice(pool.price);
        const snap = initialSnapshotRef.current;
        if (snap && Array.isArray(snap.rows) && snap.rows.length > 0) {
          // Restore a persisted editor session — staged edits survive closing
          // the section, rail navigation and router.refresh(). The BASELINE
          // above still comes from the fresh LIVE pool, so the dirty/diff
          // math is judged against production truth, never the snapshot.
          setRows(snap.rows.map((r) => ({ ...r })));
          setPriceText(snap.priceText);
          setAllowPriceSearch(snap.allowPriceSearch);
        } else {
          setRows(seeded);
          setPriceText(String(pool.price));
        }
        setFilters(picker);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load the pack pool.",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [packId]);

  const price = (() => {
    const n = parseFloat(priceText);
    return Number.isFinite(n) && n > 0 ? n : packPrice;
  })();
  const priceValid = (() => {
    const n = parseFloat(priceText.trim());
    return Number.isFinite(n) && n > 0;
  })();
  // "Changed" is judged against the LIVE pool price fetched at seed (not the
  // possibly-stale proposal prop), so a stale proposal can't mark a pristine
  // editor as price-edited. Falls back to the prop until the seed lands.
  const priceChanged = Math.abs(price - basePrice) > 1e-9;

  // ── Report the session upward (persistence + staged dry-run) ─────────
  // Fires on every editable-state change once the seed landed: hands the
  // parent a serializable snapshot (persisted per pack) + the staged-pool
  // signature. The signature is `null` when the editor structurally matches
  // the live pool — undoing all edits clears the staged state. Odds edits
  // mark the session dirty (the plain Approve must be demoted — it would
  // ignore them) but the signature deliberately carries NO odds: the staged
  // write path (`applyStagedPackEditAndRetune`) shapes weights server-side
  // from identity + price only, so odds typing never re-triggers the
  // server dry-run.
  React.useEffect(() => {
    if (loading || loadError) return;
    const report = onSessionChangeRef.current;
    if (!report) return;
    const seeded = seedRowsRef.current;
    const dirty = (() => {
      if (!seeded) return false;
      if (rows.length !== seeded.length) return true;
      for (let i = 0; i < rows.length; i++) {
        const a = rows[i]!;
        const b = seeded[i]!;
        if (
          a.cardId !== b.cardId ||
          Math.abs((Number.isFinite(a.odds) ? a.odds : 0) - b.odds) > 1e-9 ||
          (a.color ?? null) !== (b.color ?? null) ||
          a.animation !== b.animation
        ) {
          return true;
        }
      }
      if (priceValid && priceChanged) return true;
      return false;
    })();
    const staged: StagedPoolSignature | null = dirty
      ? {
          cards: rows.map((r, i) => ({
            cardId: r.cardId,
            color: r.color ?? undefined,
            animation: r.animation,
            order: i,
          })),
          ...(priceValid && priceChanged ? { price } : {}),
          allowPriceSearch,
          hasAddedCards: rows.some((r) => r.added),
        }
      : null;
    report({ rows, priceText, allowPriceSearch }, staged);
  }, [
    rows,
    priceText,
    allowPriceSearch,
    loading,
    loadError,
    price,
    priceValid,
    priceChanged,
  ]);

  const after = React.useMemo(() => previewRisk(rows, price), [rows, price]);
  const hasWinCard = rows.some((r) => r.priceUsd >= price);
  const feasible = rows.length > 0 && hasWinCard && after != null;
  const hasAddedCards = rows.some((r) => r.added);

  // Live sum of the per-card odds-% inputs. Mirrors `approve`'s pre-scale view
  // (`rows.map((r) => r.odds)`) so what the owner sees matches what
  // `oddsToWeights` then turns into the integer weights for `applyPackEdit`.
  const oddsTotal = React.useMemo(
    () =>
      rows.reduce((s, r) => s + (Number.isFinite(r.odds) ? r.odds : 0), 0),
    [rows],
  );
  // VERBATIM-approve gate: the verbatim write turns each typed odd into a
  // weight SHARE — at a sum of 102% every row is silently rescaled by 100/102
  // (2.5% → 2.45098%), so what lands is NOT what the owner typed. The
  // verbatim button stays blocked until the sum is 100% (same ±0.005
  // print-tolerance as the chip); "Renormalize to 100%" below applies the
  // rescale EXPLICITLY into the inputs so the owner sees the real values
  // before approving. Auto-tune is unaffected (the server re-shapes the odds
  // from scratch; typed odds don't bind it).
  const oddsExact = Math.abs(oddsTotal - 100) <= 0.005;
  const renormalizeOdds = React.useCallback(() => {
    setRows((prev) => {
      const total = prev.reduce(
        (s, r) => s + (Number.isFinite(r.odds) ? r.odds : 0),
        0,
      );
      if (!(total > 0)) return prev;
      return prev.map((r) => ({
        ...r,
        odds: round4(((Number.isFinite(r.odds) ? r.odds : 0) * 100) / total),
      }));
    });
  }, []);

  // ── Table handlers (mirror the Builder) ─────────────────────────────
  const onReorder = React.useCallback((next: SortableCard[]) => {
    setRows((prev) => {
      const byId = new Map(prev.map((r) => [r.cardId, r]));
      return next.map((c) => byId.get(c.cardId)!).filter(Boolean) as EditRow[];
    });
  }, []);

  const updateCard = React.useCallback(
    (index: number, updates: Partial<SortableCard>) => {
      setRows((prev) =>
        prev.map((r, i) => (i === index ? { ...r, ...updates } : r)),
      );
    },
    [],
  );

  const removeCard = React.useCallback((index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addCard = React.useCallback(
    (item: BuilderCardItem) => {
      // Seed color + animation from the convention-matching auto-pick (see
      // `autoColorAndAnimation` above). The owner can still flip either field
      // by hand in the row controls below — auto only applies to brand-new
      // adds; rows seeded from the live pool keep their existing color/anim.
      const auto = autoColorAndAnimation(item.priceUsd, price);
      // Mark the picker session dirty so the auto-recheck fires on close.
      // Set BEFORE the setRows updater so a dup-no-op below still implies the
      // operator intended to add; the close handler then re-runs the server
      // proposal regardless. (A dup is rare — the grid disables already-added
      // tiles — but we'd rather over-refresh than miss a real add.)
      pickerAddedRef.current = true;
      setRows((prev) => {
        if (prev.some((r) => r.cardId === item.id)) return prev;
        // Give the new card a FAIR share of the pool so the KPI preview shifts
        // VISIBLY on add — not just a hair. We allocate the new card 100/N% (its
        // equal share among the now-N rows) and scale existing rows down by the
        // complementary factor (N-1)/N so the total stays at 100%. This is the
        // owner-friendly default: adding a $810 jackpot to a 100% pool now moves
        // the edge/EV/maxWin tiles meaningfully (the new card has presence), and
        // the "Total odds" chip stays exactly 100% so the OddsTotalChip stays
        // green. The owner can still hand-tune any row afterwards, or click
        // "Re-shape to targets" to drop onto the auto curve. Without this, a
        // hard-coded `odds: 1` next to existing rows summing to ~100% gives the
        // new card ~1% of the share — KPIs barely budge and the owner thinks
        // the preview is frozen.
        const nextLen = prev.length + 1;
        const newOdds = nextLen > 0 ? round4(100 / nextLen) : 100;
        const scale = (nextLen - 1) / nextLen;
        const scaled = prev.map((r) => ({
          ...r,
          odds: round4((Number.isFinite(r.odds) ? r.odds : 0) * scale),
        }));
        // Insert the new card and re-sort by price DESC so the pool stays
        // ordered most-expensive-first regardless of pick order. The Builder's
        // table reads top-down, so a $0.72 add lands above a $0.08 dust card
        // and below an $810 jackpot — never appended to the bottom.
        return sortByPriceDesc([
          ...scaled,
          {
            cardId: item.id,
            name: item.name,
            imageUrl: item.imageUrl,
            priceUsd: item.priceUsd,
            odds: newOdds,
            color: auto.color,
            animation: auto.animation,
            added: true,
          },
        ]);
      });
      setLastAutoHint({
        cardName: item.name,
        color: auto.color,
        animation: auto.animation,
      });
    },
    [price],
  );

  // ── Re-shape to targets (pure shapeWeights on the edited values) ─────
  // When `allowPriceSearch` is on (the default) we route through the price-
  // search wrapper so the editor PREVIEW matches what the server's
  // `applyStagedPackEditAndRetune` will produce — the search picks the nearby
  // price (±25%, cent-stepped) whose `shapeWeights` result lands every card
  // on a clean ladder rung (e.g. 0.05% / 0.1% / 25%). Without price search the
  // shaper falls back to raw weights at the staged price (e.g. 0.0075% /
  // 2.3346% / 94.0055%); with it on, the odds the operator sees here are the
  // clean odds the server will write on approve.
  const reshape = React.useCallback(() => {
    if (rows.length === 0) return;
    setReshaping(true);
    try {
      const search = allowPriceSearch
        ? searchBestPriceForCleanSnap({
            cards: rows.map((r) => ({ value: r.priceUsd })),
            basePrice: price,
            targetEdge: targets.targetEdge,
            targetWinRate: targets.targetWinRate,
            maxWinCap: targets.maxWinCap,
            nearMissMin: targets.nearMissMin,
          })
        : null;
      const shaped = search
        ? search.bestResult
        : shapeWeights({
            cards: rows.map((r) => ({ value: r.priceUsd })),
            price,
            targetEdge: targets.targetEdge,
            targetWinRate: targets.targetWinRate,
            maxWinCap: targets.maxWinCap,
            nearMissMin: targets.nearMissMin,
          });
      if ("error" in shaped) {
        toast.error(shaped.limit?.detail ?? shaped.error);
        return;
      }
      // ADOPT the searched price into the editable price field. The search
      // picks (price, weights) as a PAIR — the shaped odds are only clean and
      // on-target at `bestPrice`. Dropping it scored the live KPI strip (and
      // the verbatim write, and the staged-price anchor the server searches
      // around) at the stale field price: KPI edge measured up to 3.56pp off,
      // showing "below target" when the engine actually hit target. Writing
      // it into the field keeps it visible AND editable.
      const priceMoved =
        search !== null && Math.abs(search.bestPrice - price) > 1e-9;
      if (priceMoved) setPriceText(search.bestPrice.toFixed(2));
      // Convert the shaped integer weights to odds % (share of total · 100).
      const total = shaped.weights.reduce((s, w) => s + w, 0) || 1;
      setRows((prev) =>
        prev.map((r, i) => ({
          ...r,
          odds:
            Math.round(((shaped.weights[i]! / total) * 100) * 10000) / 10000,
        })),
      );
      const relaxed = shaped.relaxations.length;
      const priceNote = priceMoved
        ? ` at ${formatCurrency(search.bestPrice)} — the clean-odds search moved the price (adopted into the field above)`
        : "";
      toast.success(
        relaxed > 0
          ? `Re-shaped to targets${priceNote} (${relaxed} soft target${relaxed === 1 ? "" : "s"} relaxed to stay feasible).`
          : `Re-shaped the odds onto the pack's targets${priceNote}.`,
      );
    } finally {
      setReshaping(false);
    }
  }, [rows, price, targets, allowPriceSearch]);

  // Build the EditPreview the confirm gate reads — same data for both modes:
  //  • `cards`     — every staged row with its baseline weight (null for added)
  //                  and the post-approve weight (verbatim → owner's integer
  //                  weights; auto-tune → client-side `shapeWeights` mirror of
  //                  what the server will produce against the SAME targets).
  //  • `removed`   — baseline cards the owner took out (cardId+name+value+
  //                  fromWeight) so the diff dropdown can mark them with "−".
  //  • `after`     — `PackRisk` over the post-approve weights for the KPI row.
  const buildPreview = React.useCallback(
    (mode: "verbatim" | "auto-tune"): EditPreview => {
      const baseline = baselineRef.current ?? new Map();
      let toWeights: number[];
      // The price the preview's `after` is scored at AND the pending price the
      // confirm gate shows. Starts at the staged field price; the auto-tune
      // price search may move it (the search picks (price, weights) as a pair
      // — scoring its weights at the staged price detached the gate KPIs from
      // the write, up to 3.56pp of edge).
      let previewPrice = price;
      if (mode === "auto-tune") {
        // Mirror what the server will write: shape locally against the SAME
        // targets `applyStagedPackEditAndRetune` uses. When the owner has
        // `allowPriceSearch` on (the default) we route through the same
        // price-search wrapper the server uses, so the preview weights AND
        // price match what `applyStagedPackEditAndRetune` will pick — clean
        // ladder odds at the nearby ±25% price. On a (rare) infeasible local
        // shape, fall back to the owner's odds so the gate still renders —
        // the server will error out itself if it's truly infeasible.
        const search = allowPriceSearch
          ? searchBestPriceForCleanSnap({
              cards: rows.map((r) => ({ value: r.priceUsd })),
              basePrice: price,
              targetEdge: targets.targetEdge,
              targetWinRate: targets.targetWinRate,
              maxWinCap: targets.maxWinCap,
              nearMissMin: targets.nearMissMin,
            })
          : null;
        const shaped = search
          ? search.bestResult
          : shapeWeights({
              cards: rows.map((r) => ({ value: r.priceUsd })),
              price,
              targetEdge: targets.targetEdge,
              targetWinRate: targets.targetWinRate,
              maxWinCap: targets.maxWinCap,
              nearMissMin: targets.nearMissMin,
            });
        if ("error" in shaped) {
          toWeights = oddsToWeights(rows.map((r) => r.odds));
        } else {
          toWeights = shaped.weights;
          if (search) previewPrice = search.bestPrice;
        }
      } else {
        toWeights = oddsToWeights(rows.map((r) => r.odds));
      }
      const afterRisk = rows.length > 0
        ? computePackRisk({
            cards: rows.map((r, i) => ({
              value: r.priceUsd,
              weight: toWeights[i]!,
            })),
            price: previewPrice,
          })
        : null;
      const cards = rows.map((r, i) => {
        const base = baseline.get(r.cardId);
        return {
          cardId: r.cardId,
          value: r.priceUsd,
          name: r.name,
          fromWeight: base ? base.weight : null,
          toWeight: toWeights[i]!,
          added: r.added,
        };
      });
      const keptIds = new Set(rows.map((r) => r.cardId));
      const removed: EditPreview["removed"] = [];
      for (const [cardId, base] of baseline.entries()) {
        if (!keptIds.has(cardId)) {
          removed.push({
            cardId,
            value: base.value,
            name: base.name,
            fromWeight: base.weight,
          });
        }
      }
      return {
        after: afterRisk,
        // Pending price measured against the LIVE pack price (not the staged
        // field) — one expression covers both the owner-staged change and the
        // search-adopted price. For verbatim `previewPrice === price`, so this
        // reduces to the old `priceChanged ? price : null`.
        newPrice:
          Math.abs(previewPrice - packPrice) > 1e-9 ? previewPrice : null,
        cards,
        removed,
      };
    },
    [rows, price, packPrice, targets, allowPriceSearch],
  );

  // ── Approve the explicit edited pool (VERBATIM — advanced) ───────────
  // Refuses while the odds sum is off 100% (`oddsExact`) — the write would
  // silently rescale every typed odd; renormalize explicitly first.
  const approve = React.useCallback(() => {
    if (!feasible || !priceValid || applying || !oddsExact) return;
    const weights = oddsToWeights(rows.map((r) => r.odds));
    onApprove({
      mode: "verbatim",
      cards: rows.map((r, i) => ({
        cardId: r.cardId,
        weight: weights[i]!,
        color: r.color ?? undefined,
        animation: r.animation,
        order: i,
      })),
      price: priceChanged ? price : undefined,
      hasAddedCards,
      preview: buildPreview("verbatim"),
    });
  }, [
    feasible,
    priceValid,
    applying,
    oddsExact,
    rows,
    onApprove,
    priceChanged,
    price,
    hasAddedCards,
    buildPreview,
  ]);

  // ── Approve via AUTO-TUNE (SAFE PATH — server shapes weights) ────────
  const approveAutoTune = React.useCallback(() => {
    if (!feasible || !priceValid || applying) return;
    onApproveAutoTune({
      mode: "auto-tune",
      cards: rows.map((r, i) => ({
        cardId: r.cardId,
        color: r.color ?? undefined,
        animation: r.animation,
        order: i,
      })),
      price: priceChanged ? price : undefined,
      hasAddedCards,
      ...(allowPriceSearch ? { allowPriceSearch: true } : {}),
      preview: buildPreview("auto-tune"),
    });
  }, [
    feasible,
    priceValid,
    applying,
    rows,
    onApproveAutoTune,
    priceChanged,
    price,
    hasAddedCards,
    allowPriceSearch,
    buildPreview,
  ]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-muted/10 px-3 py-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading the pack pool…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-3 text-xs text-rose-600 dark:text-rose-400">
        <div className="flex items-start gap-2">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{loadError}</span>
        </div>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Close editor
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/10 p-3">
      {/* Price + add card */}
      <div className="grid gap-3 sm:grid-cols-[160px_1fr] sm:items-end">
        <div className="space-y-1.5">
          <Label
            htmlFor={`edit-price-${packId}`}
            className="flex items-center gap-1.5 text-xs"
          >
            Pack price ($)
            <InfoHint text="The ticket price. Cards worth at least this are win/profit cards; a pack with no card ≥ price can't be retuned (no-win). Changing the price re-evaluates win cards + feasibility live." />
          </Label>
          <Input
            id={`edit-price-${packId}`}
            type="number"
            step="0.01"
            min="0"
            value={priceText}
            onChange={(e) => setPriceText(e.target.value)}
            aria-invalid={!priceValid}
            className="h-8"
          />
        </div>
        {filters && (
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-xs">
              Add a card
              <InfoHint text="Pull a card into the pool — its value + how many packs already use it are shown. To fix a no-win pack, add a card worth at least the pack price." />
            </Label>
            <BuilderCardPicker
              selectedIds={rows.map((r) => r.cardId)}
              onSelect={addCard}
              sets={filters.sets}
              rarities={filters.rarities}
              price={price}
              open={pickerOpen}
              onOpenChange={(open) => {
                // Forward the open-state to the parent's controlled prop AND,
                // on a close-after-additions, fire `onCardsAdded` so the
                // proposal dry-run re-runs. Reset the dirty-ref on open so
                // each picker session is tracked independently; consume it on
                // close so a follow-up reopen-without-adds doesn't re-trigger.
                onPickerOpenChange?.(open);
                if (open) {
                  pickerAddedRef.current = false;
                } else if (pickerAddedRef.current) {
                  pickerAddedRef.current = false;
                  onCardsAdded?.();
                }
              }}
              initialPriceMin={pickerInitialPriceMin}
              initialPriceMax={pickerInitialPriceMax}
            />
          </div>
        )}
      </div>

      {/* Live AFTER preview + feasibility */}
      <EditorPreview after={after} price={price} targetEdge={targets.targetEdge} />

      {!feasible && rows.length > 0 && !hasWinCard && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="font-medium">No win cards.</span> Every card is
            worth less than the {formatCurrency(price)} price, so this pool can
            never pay out a profit. Add a card worth at least {formatCurrency(price)}{" "}
            above to make it feasible.
          </span>
        </div>
      )}

      {/* Inline hint for the most-recent auto-pick — non-intrusive note that
          color + animation were seeded by the heuristic and can still be
          flipped by hand in the row controls. Cleared when the picked card is
          removed from the pool. */}
      {lastAutoHint &&
        rows.some((r) => r.name === lastAutoHint.cardName && r.added) && (
          <div
            className="flex items-start gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-700 dark:text-blue-300"
            role="status"
            aria-live="polite"
          >
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              <span className="font-medium">{lastAutoHint.cardName}</span>
              {" — "}
              {describeAutoPick(lastAutoHint.color, lastAutoHint.animation)}.{" "}
              <span className="opacity-80">
                Change it in the row controls below if you want a different
                look.
              </span>
            </span>
          </div>
        )}

      {/* The editable card table (reused from the Builder) */}
      {rows.length > 0 ? (
        <SortableCardTable
          cards={rows}
          onReorder={onReorder}
          updateCard={updateCard}
          removeCard={removeCard}
        />
      ) : (
        <p className="rounded-lg border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
          The pool is empty — add at least one card (including one worth ≥ the
          price) to make it a valid pack.
        </p>
      )}

      {/* Live total of the per-card odds inputs — placed right above the
          action buttons so it's visible at decision time. An off-100% total
          BLOCKS the verbatim approve (the write would silently rescale every
          typed odd); the chip offers an explicit "Renormalize to 100%" that
          applies the rescale visibly into the inputs instead. */}
      <OddsTotalChip
        total={oddsTotal}
        hasRows={rows.length > 0}
        onRenormalize={renormalizeOdds}
        disabled={applying}
      />

      {/* Price-search opt-in — when checked, the auto-tune action sweeps a
          ±25% price band (cent-stepped) on the server and picks the candidate
          whose `shapeWeights` result lands every card on a clean ladder rung.
          DEFAULT ON (2026-06-28, Owner): the owner is fine with a ±25% nudge
          for clean odds; untick to hard-pin the staged price (cleanliness
          then depends on whether the staged price happens to land on the
          ladder). */}
      <label
        htmlFor={`allow-price-search-${packId}`}
        className="flex cursor-pointer items-start gap-2 rounded-lg border bg-card/40 px-3 py-2"
      >
        <Checkbox
          id={`allow-price-search-${packId}`}
          checked={allowPriceSearch}
          onCheckedChange={(checked) =>
            setAllowPriceSearch(checked === true)
          }
          disabled={applying}
          className="mt-0.5"
        />
        <div className="flex-1 space-y-0.5">
          <span className="flex items-center gap-1.5 text-xs font-medium">
            Allow price adjustment (±25%) for cleaner odds
            <InfoHint text="When ticked, the server may nudge the pack price by up to ±25% (cent-stepped) around the staged price to land every card on a clean odds rung (e.g. 0.01%, 0.1%, 25%). The exact chosen price is shown after the auto-tune runs." />
          </span>
          <p className="text-[11px] text-muted-foreground">
            On by default: auto-tune picks a nearby price (±25%, cent-stepped)
            so the odds snap onto a clean ladder (e.g. 0.05% / 0.1% / 25%).
            Untick to hold the staged price exactly.
          </p>
        </div>
      </label>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          size="sm"
          variant="outline"
          onClick={reshape}
          disabled={rows.length === 0 || reshaping || applying}
        >
          {reshaping ? (
            <Loader2 className="mr-1 size-3.5 animate-spin" />
          ) : (
            <Wand2 className="mr-1 size-3.5" />
          )}
          Re-shape to targets
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={onCancel}
            disabled={applying}
            title="Throws the staged changes away and re-seeds from the live pool. Use “Hide editor” above to close while KEEPING the staged edits."
          >
            <X className="mr-1 size-3.5" />
            Discard edits
          </Button>
          {/* VERBATIM (advanced) — outline + warning tooltip. Writes the owner's
              exact odds to MAIN; no shaping. Kept as an escape hatch. BLOCKED
              while the odds total is off 100% — verbatim means "exactly as
              typed", and an off-total would be silently rescaled on write. */}
          <TooltipProvider delay={150}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={approve}
                    disabled={
                      !feasible || !priceValid || applying || !oddsExact
                    }
                  >
                    {applying ? (
                      <Loader2 className="mr-1 size-3.5 animate-spin" />
                    ) : (
                      <Check className="mr-1 size-3.5" />
                    )}
                    Approve edited pool
                  </Button>
                }
              />
              <TooltipContent side="top" className="max-w-xs text-xs">
                {oddsExact ? (
                  <>
                    Advanced: writes your exact weights verbatim. Does NOT
                    optimize. Use Auto-tune for the safe path — it lets the
                    server pick weights that clear the pack&apos;s targets.
                  </>
                ) : (
                  <>
                    Blocked: the odds sum to {oddsTotal.toFixed(2)}%, and a
                    verbatim write would silently rescale every row to force
                    100% (e.g. 2.5% → 2.45% at a 102% total) — what lands
                    wouldn&apos;t be what you typed. Use &quot;Renormalize to
                    100%&quot; above or fix the rows first.
                  </>
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {/* AUTO-TUNE (PRIMARY, safe path) — server runs shapeWeights on the
              staged identity + targets and writes optimized weights. Rose tint
              signals "prod write" (same tone the confirm gate uses). */}
          <Button
            size="sm"
            onClick={approveAutoTune}
            disabled={!feasible || !priceValid || applying}
            className="bg-rose-600 text-white hover:bg-rose-600/90 dark:bg-rose-600 dark:hover:bg-rose-600/90"
          >
            {applying ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1 size-3.5" />
            )}
            Auto-tune &amp; push to production
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Seed the editable rows from a fresh `getPackEditPool` read. */
function seedRows(pool: EditPool): EditRow[] {
  const total = pool.cards.reduce(
    (s, c) => s + (c.weight > 0 ? c.weight : 0),
    0,
  );
  // Sort by price DESC on seed too, so the initial view matches the invariant
  // the editor enforces from here on out (and matches what the owner will see
  // after any add). The stored `order` is rewritten on Approve from the row
  // index, so display order = write order = sorted-by-price order.
  return sortByPriceDesc(
    pool.cards.map((c) => ({
      cardId: c.cardId,
      name: c.name,
      imageUrl: c.imageUrl || null,
      priceUsd: c.value,
      odds:
        total > 0
          ? Math.round(((c.weight / total) * 100) * 10000) / 10000
          : 0,
      color: c.color,
      animation: c.animation,
      added: false,
    })),
  );
}

/**
 * Sort the editor rows by card price DESCENDING — most expensive at index 0,
 * cheapest at the end. Used for the initial seed AND every time a card is
 * added, so the pool always reads top-down from jackpot to dust. Stable on
 * ties (preserves insertion order) so the owner's manual reordering of equal-
 * priced cards isn't shuffled. Not used in `onReorder` — manual DnD overrides
 * the price sort intentionally, so the owner can still hand-place same-price
 * variants. New adds go through this helper, so a fresh pick always lands in
 * its price-sorted position rather than being appended to the bottom.
 */
function sortByPriceDesc<T extends { priceUsd: number }>(rows: T[]): T[] {
  // Use index-tagged sort for stability — Array#sort isn't guaranteed stable
  // pre-ES2019 in every JS engine, and we lean on stability for equal prices.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (b.r.priceUsd !== a.r.priceUsd) return b.r.priceUsd - a.r.priceUsd;
      return a.i - b.i;
    })
    .map(({ r }) => r);
}

/**
 * Always-visible running total of the per-card odds-% inputs. Rendered ONCE
 * just above the Approve buttons so the owner sees it at decision time (a
 * previous version rendered the chip twice — top + bottom — but the duplicate
 * was distracting and the bottom placement is what matters). Three states:
 *
 * - Exactly 100% (±0.005)    → emerald, check icon — input matches a probability.
 * - Below 100%                → amber, info icon — verbatim approve blocked.
 * - Above 100%                → rose, BOLD + LARGER, triangle-alert — over-total,
 *                               the case the owner just hit (102%) without
 *                               noticing. Verbatim approve is BLOCKED.
 *
 * MODE-AWARE copy: the two Approve paths treat the typed odds differently —
 * VERBATIM writes each row exactly as typed (so an off-100% total would be
 * silently rescaled: 2.5% → 2.45098% at 102%; blocked instead), while
 * AUTO-TUNE re-shapes the odds from scratch (the total doesn't bind it). An
 * off-total chip offers "Renormalize to 100%" — the explicit version of the
 * rescale a verbatim write used to do silently, applied into the visible
 * inputs so what the owner approves is what lands.
 */
function OddsTotalChip({
  total,
  hasRows,
  onRenormalize,
  disabled,
}: {
  total: number;
  hasRows: boolean;
  /** Rescales every row's odds by 100/total, visibly, into the inputs. */
  onRenormalize: () => void;
  disabled: boolean;
}) {
  if (!hasRows) return null;
  // ±0.005 tolerance — anything that prints "100.00%" at two decimals counts
  // as exactly 100, so the chip and the displayed number agree. MUST match
  // the `oddsExact` gate on the verbatim Approve.
  const exact = Math.abs(total - 100) <= 0.005;
  const over = !exact && total > 100;
  const tone = exact
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
    : over
      ? "border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-400"
      : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  const Icon = exact ? Check : over ? TriangleAlert : Info;
  const label = exact
    ? "Total odds match 100%"
    : over
      ? "Over 100% — verbatim approve blocked"
      : "Under 100% — verbatim approve blocked";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2",
        tone,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon
          className={cn("shrink-0", over ? "size-4" : "size-3.5")}
          aria-hidden
        />
        <span
          className={cn(
            "tabular-nums",
            over ? "text-base font-bold sm:text-lg" : "text-sm font-semibold",
          )}
        >
          Total odds: {total.toFixed(2)}% / 100%
        </span>
        <span
          className={cn(
            "text-xs font-medium",
            over ? "font-bold uppercase tracking-wider" : "opacity-90",
          )}
        >
          {label}
        </span>
        {!exact && (
          <button
            type="button"
            onClick={onRenormalize}
            disabled={disabled}
            className="rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
            title="Rescale every row by 100 ÷ total so the odds sum to exactly 100% — the same rescale a verbatim write would otherwise apply silently, made visible in the inputs first."
          >
            Renormalize to 100%
          </button>
        )}
      </div>
      <p className="basis-full text-[11px] opacity-75">
        {exact ? (
          <>
            Verbatim (&quot;Approve edited pool&quot;) writes each row exactly
            as typed. Auto-tune re-shapes the odds from scratch — your typed
            odds don&apos;t bind it.
          </>
        ) : (
          <>
            Verbatim approve stays blocked until the total is exactly 100% —
            it writes each row as typed, and an off-total would silently
            rescale every odd (2.5% → 2.45% at 102%). Renormalize above to
            apply that rescale visibly, or fix the rows. Auto-tune is
            unaffected — the server re-shapes the odds from scratch.
          </>
        )}
      </p>
    </div>
  );
}

/** The live AFTER edge + EV/open + win-rate + max-win, animated. House-POV colors. */
function EditorPreview({
  after,
  price,
  targetEdge,
}: {
  after: PackRisk | null;
  price: number;
  targetEdge: number;
}) {
  if (!after) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
        No preview yet — add a card to the pool.
      </div>
    );
  }
  const healthy = after.edge >= targetEdge - 1e-9;
  const edgeTone = healthy
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  // House-POV color for EV: target EV = price · (1 − targetEdge). Below target
  // means the house gives back less than budgeted → emerald (healthy); above
  // target means the house gives back more → rose; equal is neutral. Mirrors
  // the rule "rose = player wins more, emerald = house healthy".
  const targetEv = price * (1 - targetEdge);
  const evDelta = after.ev - targetEv;
  const evTone =
    evDelta < -1e-9
      ? "text-emerald-600 dark:text-emerald-400"
      : evDelta > 1e-9
        ? "text-rose-600 dark:text-rose-400"
        : "";
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      <PreviewTile
        label="House edge"
        valueNode={
          <span className={cn("font-bold", edgeTone)}>
            <AnimatedNumber value={after.edge * 100} format="percent" />
          </span>
        }
        note={`target ${(targetEdge * 100).toFixed(2)}%`}
      />
      <PreviewTile
        label="EV / open"
        valueNode={
          <span className={cn("font-bold", evTone)}>
            <AnimatedNumber value={after.ev} format="currency" />
          </span>
        }
        note={`${formatCurrency(targetEv)} target at ${(targetEdge * 100).toFixed(2)}% edge`}
      />
      <PreviewTile
        label="Win rate"
        valueNode={
          <span className="font-bold text-rose-600 dark:text-rose-400">
            <AnimatedNumber value={after.winRate * 100} format="percent" />
          </span>
        }
        note="share of profit opens"
      />
      <PreviewTile
        label="Max win"
        valueNode={
          <span className="font-bold text-rose-600 dark:text-rose-400">
            <AnimatedNumber value={after.maxWin} format="currency" />
          </span>
        }
        note={`${after.maxMult.toFixed(1)}× price`}
      />
      <PreviewTile
        label="Tier"
        valueNode={
          <Badge
            variant="outline"
            className="h-5 px-1.5 text-[10px] font-semibold"
          >
            {after.tier}
          </Badge>
        }
        note={`CV ${after.cv.toFixed(2)} · price ${formatCurrency(price)}`}
      />
    </div>
  );
}

function PreviewTile({
  label,
  valueNode,
  note,
}: {
  label: string;
  valueNode: React.ReactNode;
  note: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-2.5">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5 flex items-center gap-1 text-lg tabular-nums">
        {valueNode}
      </p>
      <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
        <ArrowRight className="size-2.5" />
        {note}
      </p>
    </div>
  );
}
