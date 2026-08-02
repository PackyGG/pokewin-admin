"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Flame,
  Gauge,
  Layers,
  Rocket,
  Save,
  ShieldCheck,
  Target,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  KpiTile,
  SectionHeading,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { uploadImageClient } from "@/lib/upload-image-client";
import { hrefFrom } from "@/lib/app-hosts";
import { useAppHost } from "@/lib/use-app-host";
import {
  clampPackBuilderEdge,
  isPackBuilderEdgeInRange,
  PACK_BUILDER_EDGE_MAX,
  PACK_BUILDER_EDGE_MIN,
} from "@/lib/packs/builder-edge";

import {
  shapeWeights,
  computePackRisk,
  type RiskTier,
} from "@/app/(admin)/insights/edge-calc/risk";
import { buildPack } from "@/app/(admin)/packs/actions";
import {
  autoTargetEdge,
  autoMaxWinCap,
  parsePackHitRate,
  type EdgeCurveConfig,
} from "@/app/(admin)/packs/_lib/auto-targets";
import {
  SortableCardTable,
  type SortableCard,
} from "@/app/(admin)/packs/sortable-card-table";

import { RiskLevelSlider } from "@/app/(admin)/packs/risk-level-slider";

import { RiskLevelBar } from "../_components/risk-level-bar";
import { PackRiskBarPreview } from "../_components/pack-risk-bar-preview";
import { BuilderCardPicker } from "./builder-card-picker";
import {
  calculateBuilderPricing,
  EXACT_ODDS_TOTAL_UNITS,
  getBuilderOddsTotalUnits,
  hasExactBuilderOddsTotal,
  normalizeBuilderOdds,
} from "./builder-pricing";
import type { BuilderCardItem } from "./actions";
import type { PackBuilderInitialDraft } from "./draft-types";

/**
 * Pack-Studio Builder — single-page design-a-pack flow.
 *
 * (a) Identity: name / slug / image / price.
 * (b) Card pool: reuse the Pack-Studio card picker (value + inPacks + liability).
 * (c) Dials: ONE win-rate slider (default 0.20), optional max-win cap (default
 *     from admin_settings `pack_system_config`, fallback 25000 — passed in), a
 *     near-miss floor (default 0.10), and one calmer↔spicier nudge that pins /
 *     releases the modal floor.
 *
 * The LIVE preview runs the SAME pure `shapeWeights` + `computePackRisk` the
 * server-side `buildPack` uses, so the operator sees the exact edge / win-rate /
 * near-miss / max-win / multiplier / floor + an auto risk-tier badge + a
 * within-phase compliance check + any feasibility error BEFORE submitting.
 *
 * House-POV colors: a HEALTHY (>= target) edge is GREEN (house keeps its
 * margin); a SHORTFALL edge is RED (house gives margin away). Over-cap exposure
 * is RED. Generated odds are shown read-only in the shared <SortableCardTable>
 * (a manual nudge is allowed but the server re-shapes weights authoritatively).
 */

type Spiciness = "calmer" | "balanced" | "spicier";

// Floor-ratio the "calmer" nudge pins (the modal card returns >= 40% of price),
// vs. nothing pinned for balanced/spicier (swingier modal outcome). Kept modest
// so the EV solve stays feasible on most pools.
const CALMER_FLOOR_RATIO = 0.4;

const TIER_LABELS: Record<RiskTier, string> = {
  T1: "T1 · calm",
  T2: "T2 · steady",
  T3: "T3 · lively",
  T4: "T4 · swingy",
  T5: "T5 · wild",
};

const TIER_ACCENT: Record<RiskTier, string> = {
  T1: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  T2: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  T3: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  T4: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  T5: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

type PoolCard = {
  cardId: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number;
  /** Operator-nudged odds % (display + optional manual override). */
  odds: number;
  /** True while showing the auto-shaped odds; flips false on manual edit. */
  autoOdds: boolean;
  color: string | null;
  animation: boolean;
};

function autoSlug(val: string): string {
  return val
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function ImageDropzone({
  preview,
  onFile,
  onClear,
}: {
  preview: string | null;
  onFile: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = useCallback(
    (file: File) => {
      if (file.type.startsWith("image/")) onFile(file);
    },
    [onFile],
  );

  if (preview) {
    return (
      <div className="relative inline-block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={preview} alt="Preview" className="h-24 rounded-lg object-contain" />
        <button
          type="button"
          onClick={onClear}
          className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs"
        >
          &times;
        </button>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors ${
        dragging
          ? "border-primary bg-primary/5"
          : "border-muted-foreground/25 hover:border-muted-foreground/50"
      }`}
    >
      <Upload className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        Drop an image here or{" "}
        <span className="text-primary underline underline-offset-2">browse</span>
      </p>
      <p className="text-xs text-muted-foreground/60">PNG, JPG, WebP up to 20 MB</p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
    </div>
  );
}

export function PackBuilderForm({
  sets,
  rarities,
  defaultMaxWinCap,
  maxMultCeiling,
  edgeCurve,
  canBuild,
  initialDraft,
}: {
  sets: { id: string; name: string }[];
  rarities: string[];
  /** Resolved `pack_system_config.maxWinCap` (fallback 25000) from the server. */
  defaultMaxWinCap: number;
  /** Resolved `pack_system_config.maxMultCeiling` (fallback 100) — the price-relative jackpot bound. */
  maxMultCeiling: number;
  /** Resolved per-pack edge-curve config (floor + risk-premium coefficients). */
  edgeCurve: EdgeCurveConfig;
  /** True when the viewer can save a build draft or request live approval. */
  canBuild: boolean;
  /** Existing ADMIN-only saved build when the form is opened in edit mode. */
  initialDraft: PackBuilderInitialDraft | null;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const appHost = useAppHost();

  // ── Identity ──────────────────────────────────────────────────────
  const [name, setName] = useState(initialDraft?.name ?? "");
  const [slug, setSlug] = useState(initialDraft?.slug ?? "");
  const [slugManual, setSlugManual] = useState(initialDraft !== null);
  const [price, setPrice] = useState(
    initialDraft ? String(initialDraft.price) : "",
  );
  // ONE auto-tune switch. It owns BOTH auto-derived numbers — the EV price AND
  // the solver-shaped odds. They are the same loop (odds → EV → price → re-shape
  // → odds), so gating only the price left the shaper still rewriting every
  // unpinned row on any target-edge change (including typing a "10%" into the
  // NAME, which is tag-aware). Off = the pool is frozen exactly as edited.
  const [autoTune, setAutoTune] = useState(initialDraft === null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(
    initialDraft?.imageUrl ?? null,
  );

  // ── Pool ──────────────────────────────────────────────────────────
  const [cards, setCards] = useState<PoolCard[]>(() =>
    (initialDraft?.cards ?? []).map((card) => ({
      ...card,
      odds: 0,
      autoOdds: true,
    })),
  );

  // ── Dials ─────────────────────────────────────────────────────────
  const [winRatePct, setWinRatePct] = useState(
    (initialDraft?.targets.targetWinRate ?? 0.2) * 100,
  ); // % (slider) → ratio
  const [capEnabled, setCapEnabled] = useState(
    initialDraft ? initialDraft.targets.maxWinCap !== null : true,
  );
  const [maxWinCap, setMaxWinCap] = useState(
    String(initialDraft?.targets.maxWinCap ?? defaultMaxWinCap),
  );
  const [nearMissPct, setNearMissPct] = useState(
    (initialDraft?.targets.nearMissMin ?? 0.1) * 100,
  ); // % → ratio
  const [spiciness, setSpiciness] = useState<Spiciness>(
    initialDraft?.targets.floorRatioMin != null ? "calmer" : "balanced",
  );
  const [customEdgeEnabled, setCustomEdgeEnabled] = useState(
    initialDraft?.targets.targetEdge != null,
  );
  const [customEdgePct, setCustomEdgePct] = useState(
    (
      (initialDraft?.targets.targetEdge ??
        clampPackBuilderEdge(edgeCurve.edgeFloor)) * 100
    ).toFixed(2),
  );
  // Player-facing risk level (0..1) — the on-site `difficulty` dial. Manual,
  // NOT derived from the CV tier (they are different measures). Defaults to 0
  // so, like the create/edit pack forms, an untouched pack ships `difficulty:
  // null` (no on-site bar) until the operator sets a level.
  const [difficulty, setDifficulty] = useState(initialDraft?.difficulty ?? 0);
  // Controlled so the confirm can be closed explicitly on push (the shared
  // AlertDialogAction is a plain button, not a Close — it wouldn't auto-close
  // on the error path otherwise).
  const [activateConfirmOpen, setActivateConfirmOpen] = useState(false);

  const packPrice = parseFloat(price) || 0;
  const capValue = parseFloat(maxWinCap);
  const cap = capEnabled && Number.isFinite(capValue) && capValue > 0 ? capValue : undefined;
  const targetWinRate = winRatePct / 100;
  const nearMissMin = nearMissPct / 100;
  const floorRatioMin = spiciness === "calmer" ? CALMER_FLOOR_RATIO : undefined;

  // ── Per-pack target edge (edge curve: floor 10.99% + risk premium) ──
  // This pack's OWN target edge — NOT a flat 10.99%. The premium rises with the
  // pack's house risk (max-win $ exposure, then price), so a calm/cheap pack sits
  // at the floor while a pricey/jackpot-heavy one targets a little above it. The
  // max-win proxy mirrors the auto-retune contract: the cap the pack is allowed
  // to carry (the operator's cap when set, else the auto cap = lesser of the
  // global cap and price × the multiplier ceiling). Updates live as price/cap
  // change; 0 until a positive price is entered.
  const configuredTargetEdge = useMemo(() => {
    if (!(packPrice > 0)) return clampPackBuilderEdge(edgeCurve.edgeFloor);
    // TAG-AWARE auto cap: a lottery pack ("1% …") gets the hit-rate-loosened
    // jackpot ceiling so the live edge preview matches the retune's cap.
    const intendedHitRate = parsePackHitRate(name) ?? undefined;
    const maxWinProxy =
      cap ??
      autoMaxWinCap(
        packPrice,
        { globalCap: defaultMaxWinCap, maxMultCeiling },
        intendedHitRate,
      );
    return clampPackBuilderEdge(
      autoTargetEdge({ price: packPrice, maxWin: maxWinProxy }, edgeCurve),
    );
  }, [packPrice, cap, defaultMaxWinCap, maxMultCeiling, edgeCurve, name]);
  const customEdgeValue = Number(customEdgePct);
  const customEdgeValid =
    Number.isFinite(customEdgeValue) &&
    isPackBuilderEdgeInRange(customEdgeValue / 100);
  const targetEdge =
    customEdgeEnabled && customEdgeValid
      ? customEdgeValue / 100
      : configuredTargetEdge;

  // Auto-price from the pool's EV using the same formula as the standard pack
  // create/edit forms: price = EV / (1 - target edge). Before the shaper has
  // produced odds for a new pool, equal weights provide the initial seed. Once
  // odds exist, their exact EV drives the price and the loop settles at the
  // selected edge (whole-cent rounding is intentional: packs.price is scale 2).
  const pricing = useMemo(
    () =>
      customEdgeEnabled && !customEdgeValid
        ? { expectedPayout: 0, suggestedPrice: 0 }
        : calculateBuilderPricing(cards, targetEdge),
    [cards, customEdgeEnabled, customEdgeValid, targetEdge],
  );
  const pricingEv = pricing.expectedPayout;
  const suggestedPrice = pricing.suggestedPrice;

  useEffect(() => {
    if (!autoTune || !(suggestedPrice > 0)) return;
    const next = suggestedPrice.toFixed(2);
    setPrice((current) => (current === next ? current : next));
  }, [autoTune, suggestedPrice]);

  function handleNameChange(val: string) {
    setName(val);
    if (!slugManual) setSlug(autoSlug(val));
  }

  function handleAddCard(item: BuilderCardItem) {
    setCards((prev) => {
      if (prev.some((c) => c.cardId === item.id)) {
        toast.error("Card already added");
        return prev;
      }
      return [
        ...prev,
        {
          cardId: item.id,
          name: item.name,
          imageUrl: item.imageUrl,
          priceUsd: item.priceUsd,
          odds: 0,
          autoOdds: true,
          color: null,
          animation: false,
        },
      ];
    });
  }

  // ── Live shape preview (pure, client-side) ───────────────────────
  // Runs the SAME shapeWeights the server-side buildPack runs. On success we
  // surface the generated odds read-only in the table; on failure we surface
  // the feasibility error and disable submit.
  const shaped = useMemo(() => {
    if (cards.length === 0 || !(packPrice > 0)) return null;
    return shapeWeights({
      cards: cards.map((c) => ({ value: c.priceUsd })),
      price: packPrice,
      targetEdge,
      targetWinRate,
      maxWinCap: cap,
      floorRatioMin,
      nearMissMin,
    });
  }, [cards, packPrice, targetEdge, targetWinRate, cap, floorRatioMin, nearMissMin]);

  const shapeError = shaped && "error" in shaped ? shaped.error : null;
  const shapeOk = shaped && "weights" in shaped ? shaped : null;

  // Push the auto-shaped weights into the table as odds % (sum to 100) whenever
  // the shape succeeds — but ONLY for rows still on auto (a manual nudge sticks
  // until the operator re-adds / changes the pool). The auto flag resets to true
  // when the pool itself changes (handleAddCard / remove set autoOdds:true).
  useEffect(() => {
    if (!autoTune) return;
    if (!shapeOk) return;
    const totalW = shapeOk.weights.reduce((s, w) => s + w, 0);
    if (!(totalW > 0)) return;
    const normalizedOdds = normalizeBuilderOdds(
      shapeOk.weights.map((weight) => (weight / totalW) * 100),
    );
    setCards((prev) => {
      let changed = false;
      const next = prev.map((c, i) => {
        if (!c.autoOdds) return c;
        const normalized = normalizedOdds[i]!;
        if (Math.abs(normalized - c.odds) < 1e-9) return c;
        changed = true;
        return { ...c, odds: normalized };
      });
      return changed ? next : prev;
    });
  }, [autoTune, shapeOk]);

  // Risk read off the CURRENT table odds (auto OR manually nudged) — this is the
  // preview the operator actually sees, reflecting any manual override.
  const previewRisk = useMemo(() => {
    if (cards.length === 0 || !(packPrice > 0)) return null;
    const totalOdds = cards.reduce((s, c) => s + c.odds, 0);
    if (!(totalOdds > 0)) return null;
    return computePackRisk({
      cards: cards.map((c) => ({ value: c.priceUsd, weight: c.odds })),
      price: packPrice,
    });
  }, [cards, packPrice]);

  // ── Compliance (within-phase) ────────────────────────────────────
  const edgePct = previewRisk ? previewRisk.edge * 100 : 0;
  const targetEdgePct = targetEdge * 100;
  const edgeWithinBuilderRange = previewRisk
    ? isPackBuilderEdgeInRange(previewRisk.edge)
    : false;
  const edgeHealthy = previewRisk ? previewRisk.edge >= targetEdge - 1e-6 : false;
  const overCap =
    previewRisk && cap !== undefined ? previewRisk.maxWin > cap + 1e-9 : false;
  const compliant =
    Boolean(previewRisk) &&
    edgeWithinBuilderRange &&
    edgeHealthy &&
    !overCap;
  const oddsTotalUnits = getBuilderOddsTotalUnits(cards);
  const oddsTotalPct = oddsTotalUnits / 10_000;
  const oddsTotalExact = hasExactBuilderOddsTotal(cards);

  // ── Table glue (reuse the shared SortableCardTable) ──────────────
  const tableCards: SortableCard[] = cards.map((c) => ({
    cardId: c.cardId,
    name: c.name,
    imageUrl: c.imageUrl,
    priceUsd: c.priceUsd,
    odds: c.odds,
    color: c.color,
    animation: c.animation,
  }));

  function handleReorder(next: SortableCard[]) {
    const byId = new Map(cards.map((c) => [c.cardId, c]));
    setCards(next.map((n) => byId.get(n.cardId)!).filter(Boolean));
  }

  function handleUpdateCard(index: number, updates: Partial<SortableCard>) {
    setCards((prev) =>
      prev.map((c, i) => {
        if (i !== index) return c;
        const next = {
          ...c,
          color: updates.color !== undefined ? updates.color : c.color,
          animation:
            updates.animation !== undefined ? updates.animation : c.animation,
        };
        // A manual odds edit pins the row to its value (autoOdds:false).
        if (typeof updates.odds === "number") {
          return { ...next, odds: updates.odds, autoOdds: false };
        }
        return next;
      }),
    );
  }

  function handleRemoveCard(index: number) {
    setCards((prev) => {
      const survivors = prev.filter((_, i) => i !== index);
      // Re-arm auto-odds on the survivors so the shape re-distributes cleanly —
      // but ONLY while auto-tune is driving. With auto-tune off this used to
      // silently unpin every hand-set row, so deleting one card rewrote the
      // whole pool on the next shape.
      return autoTune ? survivors.map((c) => ({ ...c, autoOdds: true })) : survivors;
    });
  }

  // ── Submit → saved draft OR owner approval queue ──
  const canSubmit =
    canBuild &&
    !isPending &&
    name.trim().length > 0 &&
    slug.trim().length > 0 &&
    packPrice > 0 &&
    cards.length > 0 &&
    oddsTotalExact &&
    (!customEdgeEnabled || customEdgeValid) &&
    edgeWithinBuilderRange &&
    !shapeError &&
    Boolean(shapeOk);
  const canRequestLive =
    canSubmit && (imageFile !== null || imagePreview !== null);

  // `activate:true` requests a live push. `false` saves an ADMIN-only draft.
  // Neither path changes MAIN at submission time.
  function handleSubmit(activate: boolean) {
    if (!canSubmit) return;
    if (activate && imageFile === null && imagePreview === null) {
      toast.error(
        "Add a pack image before requesting a live push. Drafts can be saved without one.",
      );
      return;
    }
    startTransition(async () => {
      try {
        let imageUrl =
          imagePreview && !imagePreview.startsWith("blob:")
            ? imagePreview
            : undefined;
        if (imageFile) {
          imageUrl = await uploadImageClient(imageFile, "/packs");
        }

        const result = await buildPack({
          name: name.trim(),
          slug: slug.trim(),
          description: initialDraft?.description ?? undefined,
          imageUrl,
          price: packPrice,
          cardsPerOpen: initialDraft?.cardsPerOpen ?? undefined,
          difficulty,
          activate,
          cards: cards.map((c) => ({
            cardId: c.cardId,
            color: c.color,
            animation: c.animation,
          })),
          targets: {
            // The pack's OWN per-pack target edge (edge curve), so the server
            // re-shape matches the live preview — not a flat 10.99%.
            targetEdge,
            targetWinRate,
            maxWinCap: cap,
            floorRatioMin,
            nearMissMin,
          },
        }, initialDraft?.id);

        if (!result.ok) {
          toast.error(result.error);
          return;
        }

        if (result.requestedActive) {
          toast.success(
            `${initialDraft ? "Build updated and live push requested" : "Live push requested"} · owner approval required · edge ${(result.edge * 100).toFixed(2)}% · win-rate ${(result.winRate * 100).toFixed(1)}%`,
          );
          if (initialDraft) {
            router.push(
              appHost
                ? hrefFrom(appHost, "/pack-studio/builder-drafts")
                : "/pack-studio/builder-drafts",
            );
          }
        } else {
          toast.success(
            `Build draft ${initialDraft ? "updated" : "saved"} · edge ${(result.edge * 100).toFixed(2)}% · win-rate ${(result.winRate * 100).toFixed(1)}%`,
          );
          router.push(
            appHost
              ? hrefFrom(appHost, "/pack-studio/builder-drafts")
              : "/pack-studio/builder-drafts",
          );
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to create pack");
      }
    });
  }

  return (
    <div className="space-y-6">
      {initialDraft && (
        <div className="flex items-start gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-sm text-blue-600 dark:text-blue-400">
          <Save className="mt-0.5 size-4 shrink-0" />
          <p>
            Editing saved build <strong>{initialDraft.name}</strong>. Saving
            updates this draft in place.
          </p>
        </div>
      )}
      {!canBuild && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <p>
            Your account can explore this builder, but it does not have pack
            creation permission. Submit is disabled.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ── Left: identity + pool + dials ── */}
        <div className="space-y-6 lg:col-span-2">
          {/* Identity */}
          <div className="space-y-4">
            <SectionHeading icon={Layers} title="Pack identity" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="Pack name"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Slug</Label>
                <Input
                  value={slug}
                  onChange={(e) => {
                    setSlugManual(true);
                    setSlug(e.target.value);
                  }}
                  placeholder="pack-slug"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="pack-price">Price (USD)</Label>
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor="auto-pack-price"
                      className="text-xs font-normal text-muted-foreground"
                    >
                      Auto-tune price + odds
                    </Label>
                    <Switch
                      id="auto-pack-price"
                      size="sm"
                      checked={autoTune}
                      onCheckedChange={(checked) => {
                        const on = !!checked;
                        setAutoTune(on);
                        // Turning it back ON is an explicit "let the solver
                        // drive again" — release every hand-pinned row so the
                        // shape re-distributes the whole pool.
                        if (on) {
                          setCards((prev) =>
                            prev.map((c) => ({ ...c, autoOdds: true })),
                          );
                        }
                      }}
                    />
                  </div>
                </div>
                <Input
                  id="pack-price"
                  type="number"
                  value={price}
                  onChange={(e) => {
                    setAutoTune(false);
                    setPrice(e.target.value);
                  }}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  readOnly={autoTune}
                />
                <p className="text-xs text-muted-foreground">
                  {pricingEv > 0
                    ? `EV ${formatCurrency(pricingEv)} · ${autoTune ? "Auto price" : "Suggested"} ${formatCurrency(suggestedPrice)} · target ${targetEdgePct.toFixed(2)}%`
                    : "Add cards to calculate the pack price automatically from EV and edge."}
                  {!autoTune && suggestedPrice > 0 && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        onClick={() => {
                          setAutoTune(true);
                          setCards((prev) =>
                            prev.map((c) => ({ ...c, autoOdds: true })),
                          );
                          setPrice(suggestedPrice.toFixed(2));
                        }}
                        className="text-primary underline underline-offset-2"
                      >
                        use auto price
                      </button>
                    </>
                  )}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Image</Label>
                <ImageDropzone
                  preview={imagePreview}
                  onFile={(file) => {
                    setImageFile(file);
                    setImagePreview(URL.createObjectURL(file));
                  }}
                  onClear={() => {
                    setImageFile(null);
                    setImagePreview(null);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Optional for saved drafts. Required before requesting a live
                  push.
                </p>
              </div>
            </div>
          </div>

          {/* Pool */}
          <div className="space-y-3">
            <SectionHeading icon={Layers} title="Card pool" />
            <BuilderCardPicker
              selectedIds={cards.map((c) => c.cardId)}
              onSelect={handleAddCard}
              sets={sets}
              rarities={rarities}
              price={packPrice}
            />
            {cards.length > 0 ? (
              <>
                <SortableCardTable
                  cards={tableCards}
                  onReorder={handleReorder}
                  updateCard={handleUpdateCard}
                  removeCard={handleRemoveCard}
                />
                <p className="text-xs text-muted-foreground">
                  {autoTune
                    ? "Auto-tune is on: odds are re-shaped to the target edge + win-rate whenever the pool, price or dials change. Editing an odds cell pins that row."
                    : "Auto-tune is off: these odds stay exactly as you set them. Turn it back on to let the solver re-shape the pool."}{" "}
                  The server re-shapes weights authoritatively on submit.
                </p>
                <div
                  className={cn(
                    "flex items-center justify-between rounded-md border px-3 py-2 text-xs",
                    oddsTotalExact
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
                  )}
                  role={oddsTotalExact ? undefined : "alert"}
                >
                  <span>Total odds</span>
                  <span className="font-semibold tabular-nums">
                    {oddsTotalPct.toFixed(4)}%
                  </span>
                </div>
                {!oddsTotalExact && (
                  <p className="text-xs text-destructive">
                    Total odds must equal exactly 100.0000% before this pack can
                    be submitted
                    {oddsTotalUnits > EXACT_ODDS_TOTAL_UNITS
                      ? " — reduce the odds."
                      : " — add the missing odds."}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No cards yet. Use the picker above to build the pool.
              </p>
            )}
          </div>

          {/* Dials */}
          <div className="space-y-4">
            <SectionHeading icon={Target} title="Dials" />

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="custom-edge-toggle">Target edge</Label>
                  <p className="text-xs text-muted-foreground">
                    {customEdgeEnabled
                      ? "Custom edge drives the automatic EV price."
                      : `Configured curve · ${targetEdgePct.toFixed(2)}% for this pack.`}
                  </p>
                </div>
                <Switch
                  id="custom-edge-toggle"
                  size="sm"
                  checked={customEdgeEnabled}
                  onCheckedChange={(checked) => setCustomEdgeEnabled(!!checked)}
                />
              </div>
              {customEdgeEnabled && (
                <>
                  <div className="relative">
                    <Input
                      type="number"
                      value={customEdgePct}
                      onChange={(event) => setCustomEdgePct(event.target.value)}
                      min={PACK_BUILDER_EDGE_MIN * 100}
                      max={PACK_BUILDER_EDGE_MAX * 100}
                      step="0.01"
                      aria-label="Custom target edge percentage"
                      className="pr-8"
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                      %
                    </span>
                  </div>
                  {!customEdgeValid && (
                    <p className="text-xs text-destructive">
                      Target edge must be between{" "}
                      {(PACK_BUILDER_EDGE_MIN * 100).toFixed(2)}% and{" "}
                      {(PACK_BUILDER_EDGE_MAX * 100).toFixed(2)}%.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Win-rate</Label>
                <span className="text-sm font-medium tabular-nums">
                  {winRatePct.toFixed(0)}%
                </span>
              </div>
              <Slider
                value={winRatePct}
                onValueChange={setWinRatePct}
                min={1}
                max={60}
                step={1}
                aria-label="Win-rate"
              />
              <p className="text-xs text-muted-foreground">
                Probability mass on cards worth at least the pack price.
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Near-miss floor</Label>
                <span className="text-sm font-medium tabular-nums">
                  {nearMissPct.toFixed(0)}%
                </span>
              </div>
              <Slider
                value={nearMissPct}
                onValueChange={setNearMissPct}
                min={0}
                max={40}
                step={1}
                aria-label="Near-miss floor"
              />
              <p className="text-xs text-muted-foreground">
                Minimum mass on &ldquo;close but no win&rdquo; cards
                (0.5×–1× price).
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="cap-toggle">Max-win cap</Label>
                  <Switch
                    id="cap-toggle"
                    size="sm"
                    checked={capEnabled}
                    onCheckedChange={(v) => setCapEnabled(!!v)}
                  />
                </div>
                <Input
                  type="number"
                  value={maxWinCap}
                  onChange={(e) => setMaxWinCap(e.target.value)}
                  disabled={!capEnabled}
                  min="0"
                  step="1"
                />
                <p className="text-xs text-muted-foreground">
                  Drops any pool card worth more than this (jackpot ceiling).
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>Feel</Label>
                <div className="flex gap-1.5">
                  {(["calmer", "balanced", "spicier"] as const).map((s) => {
                    const active = spiciness === s;
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSpiciness(s)}
                        className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium capitalize transition-colors ${
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  Calmer pins a predictable modal floor; spicier lets the modal
                  outcome swing.
                </p>
              </div>
            </div>

            {/* Player-facing risk bar — the on-site `difficulty` dial (0..1).
                Manual product choice, same control the create/edit pack forms
                use; NOT the house CV tier. Preview lives in the right column. */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Player-facing risk bar</Label>
                <span className="text-sm font-medium tabular-nums">
                  {Math.round(difficulty * 100)}%
                </span>
              </div>
              <RiskLevelSlider value={difficulty} onChange={setDifficulty} />
              <p className="text-xs text-muted-foreground">
                The green→red risk level players see on the pack card — preview
                on the right. This is a display choice, separate from the house
                CV risk tier. Leave at 0% to ship no bar.
              </p>
            </div>
          </div>
        </div>

        {/* ── Right: live preview ── */}
        <div className="space-y-4">
          <SectionHeading icon={Flame} title="Live preview" />

          {/* On-site risk bar — a faithful replica of the player-facing bar
              (game-site parity). Shown always: it only needs the difficulty
              dial, not the card pool, so the operator sees exactly how the pack
              will look the moment it is pushed. */}
          <div className="space-y-3 rounded-xl border bg-card/50 p-4">
            <div className="flex items-center gap-2">
              <div className="flex size-7 items-center justify-center rounded-lg bg-muted">
                <Gauge className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-none">
                  On-site risk bar
                </p>
                <p className="mt-1 text-[11px] leading-none text-muted-foreground">
                  How players see this pack if you push it now
                </p>
              </div>
            </div>
            <PackRiskBarPreview difficulty={difficulty > 0 ? difficulty : null} />
          </div>

          {!previewRisk ? (
            // A FAILED solve is the common reason there is no preview: when
            // `shapeWeights` refuses, the odds stay 0, so `previewRisk` is null
            // and the KPI branch below — which owns the only `shapeError`
            // banner — never renders. That left an infeasible pool showing
            // "Add cards and set a price" while cards and a price were already
            // set, hiding the solver's own explanation. Show the refusal here;
            // fall back to the add-cards prompt only when nothing was entered.
            shapeError ? (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-600 dark:text-rose-400">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{shapeError}</span>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                Add cards and set a price to preview the pack.
              </div>
            )
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <KpiTile
                  label="House edge"
                  value={`${edgePct.toFixed(2)}%`}
                  sub={`target ${targetEdgePct.toFixed(2)}%`}
                  icon={ShieldCheck}
                  accent={
                    edgeWithinBuilderRange && edgeHealthy ? "emerald" : "rose"
                  }
                />
                <KpiTile
                  label="Win-rate"
                  value={`${(previewRisk.winRate * 100).toFixed(1)}%`}
                  sub={`near-miss ${(previewRisk.nearMiss * 100).toFixed(1)}%`}
                  icon={Target}
                  accent="blue"
                />
                <KpiTile
                  label="Max win"
                  value={formatCurrency(previewRisk.maxWin)}
                  sub={`${previewRisk.maxMult.toFixed(1)}× price`}
                  icon={Flame}
                  accent={overCap ? "rose" : "amber"}
                />
                <KpiTile
                  label="Floor"
                  value={formatCurrency(previewRisk.floorValue)}
                  sub={`${(previewRisk.floorRatio * 100).toFixed(0)}% of price`}
                  icon={Layers}
                  accent="cyan"
                />
              </div>

              <StatPanel
                icon={Flame}
                accent={
                  previewRisk.tier === "T5"
                    ? "rose"
                    : previewRisk.tier === "T4"
                      ? "amber"
                      : "emerald"
                }
                title="Risk tier"
              >
                <p className="mb-1.5 text-xl font-bold tracking-tight">
                  {TIER_LABELS[previewRisk.tier]}
                </p>
                {/* Owner ask 2026-07-11: the game-style risk LEVEL BAR, not
                    just the raw numbers (they stay below as detail rows). */}
                <RiskLevelBar
                  tier={previewRisk.tier}
                  showLabel={false}
                  className="mb-3"
                />
                <PanelRow
                  label="Volatility (CV)"
                  value={previewRisk.cv.toFixed(2)}
                />
                <PanelRow
                  label="Risk score"
                  value={`${previewRisk.riskScore0to100}/100`}
                />
                <PanelRow label="EV / open" value={formatCurrency(previewRisk.ev)} />
              </StatPanel>

              <div className="flex items-center gap-2">
                <Badge variant="outline" className={TIER_ACCENT[previewRisk.tier]}>
                  {previewRisk.tier}
                </Badge>
                {compliant ? (
                  <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-3.5" />
                    Within phase
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-xs font-medium text-rose-600 dark:text-rose-400">
                    <AlertTriangle className="size-3.5" />
                    {!edgeWithinBuilderRange
                      ? `Edge ${edgePct.toFixed(2)}% outside ${(PACK_BUILDER_EDGE_MIN * 100).toFixed(2)}%–${(PACK_BUILDER_EDGE_MAX * 100).toFixed(2)}%`
                      : !edgeHealthy
                      ? `Edge ${edgePct.toFixed(2)}% below ${targetEdgePct.toFixed(2)}%`
                      : "Max win over cap"}
                  </span>
                )}
              </div>

              {shapeError && (
                <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-600 dark:text-rose-400">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{shapeError}</span>
                </div>
              )}

              <div className="space-y-2">
                {/* Live intent is queued. The owner approval click is the only
                    path that may create and activate the pack. */}
                <AlertDialog
                  open={activateConfirmOpen}
                  onOpenChange={setActivateConfirmOpen}
                >
                  <AlertDialogTrigger
                    disabled={!canRequestLive}
                    className={cn(buttonVariants(), "w-full gap-2")}
                  >
                    <Rocket className="size-4" />
                    {isPending ? "Submitting…" : "Request live push"}
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Request owner approval?</AlertDialogTitle>
                      <AlertDialogDescription>
                        &ldquo;{name.trim() || "This pack"}&rdquo; will be{" "}
                        {initialDraft ? "updated and sent" : "sent"} to the owner
                        queue with a request to go live at{" "}
                        {formatCurrency(packPrice)}. Nothing is created or shown
                        to players until an owner clicks Approve. House edge{" "}
                        {edgePct.toFixed(2)}% ·
                        win-rate{" "}
                        {previewRisk ? (previewRisk.winRate * 100).toFixed(1) : "0"}
                        %
                        {difficulty > 0
                          ? ` · risk bar ${Math.round(difficulty * 100)}%`
                          : " · no risk bar"}
                        .
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          setActivateConfirmOpen(false);
                          handleSubmit(true);
                        }}
                      >
                        Submit request
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                {!imageFile && (
                  <p className="flex items-center justify-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="size-3.5" />
                    Add an image to request a live push. You can still save this
                    as a draft.
                  </p>
                )}

                {/* ADMIN-only saved build. It enters the owner queue only when
                    a builder requests a live push from Saved Builds. */}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleSubmit(false)}
                  disabled={!canSubmit}
                  className="w-full gap-2"
                >
                  <Save className="size-4" />
                  {isPending
                    ? "Saving…"
                    : initialDraft
                      ? "Update build draft"
                      : "Save build draft"}
                </Button>
              </div>
              <p className="text-center text-[11px] text-muted-foreground">
                Saved drafts go straight to Saved Builds with no approval.
                Only live requests enter System → Approval Queue.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
