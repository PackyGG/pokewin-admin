"use client";

import * as React from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  KeyRound,
  ListChecks,
  SlidersHorizontal,
  Undo2,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * The plain-English explanation layer for the bulk re-tune review. Two
 * default-closed collapsibles the owner can open to understand exactly what
 * they're doing:
 *
 *   1. `RetuneGuide`   — "How re-tuning works": the full flow, step by step
 *      (Start review → BEFORE vs AFTER per card → Approve / Decline / Adjust /
 *      Back), with the load-bearing facts made explicit (nothing writes until
 *      Approve; each Approve is ONE immediate live write for that single pack;
 *      everything is revertable later from the History page).
 *   2. `RetuneGlossary` — every term used on the review surface defined once.
 *
 * Pure presentation, string-only props — no function props cross the RSC
 * boundary. Built from the house collapsible + lucide + Tailwind primitives so
 * it matches the rest of the surface.
 */

/** A reusable default-closed disclosure shell with a header row + chevron. */
function Disclosure({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-xl border bg-card shadow-sm"
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left",
          "transition-colors hover:bg-muted/40",
        )}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block text-xs text-muted-foreground">
            {subtitle}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t px-4 py-4">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One numbered / icon'd step in the flow guide. */
function Step({
  icon: Icon,
  tint,
  title,
  children,
}: {
  icon: React.ElementType;
  tint: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg",
          tint,
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {children}
        </p>
      </div>
    </li>
  );
}

/** "How re-tuning works" — the full flow, default-closed, top of the review. */
export function RetuneGuide() {
  return (
    <Disclosure
      icon={ListChecks}
      title="How re-tuning works"
      subtitle="Read me first — the full flow, and exactly what each button does."
    >
      <div className="space-y-4">
        <p className="rounded-lg border border-primary/20 bg-primary/[0.04] px-3 py-2 text-xs leading-relaxed">
          <span className="font-semibold text-foreground">
            Nothing changes until you Approve.
          </span>{" "}
          Each Approve is one immediate live write for that single pack — and
          every approved change is revertable later from the History page.
        </p>

        <ol className="space-y-3">
          <Step
            icon={KeyRound}
            tint="bg-blue-500/15 text-blue-600 dark:text-blue-400"
            title="1 · Start review"
          >
            Mints a single operator session token — no 2FA prompt on this flow
            (the owner removed it; the operator, capability, and audit checks
            on every write still hold, and other retune tools keep their TOTP
            dialogs). The token authorizes every Approve below and writes
            nothing by itself. If it expires mid-review, a fresh token is
            minted silently and the same Approve is retried.
          </Step>
          <Step
            icon={ListChecks}
            tint="bg-blue-500/15 text-blue-600 dark:text-blue-400"
            title="2 · Review one pack at a time"
          >
            Each card shows the pack&apos;s current state (
            <span className="font-medium text-foreground">BEFORE</span>) next to
            the proposed re-tune (
            <span className="font-medium text-foreground">AFTER</span>) — house
            edge, risk profile, key metrics, and every card&apos;s weight change.
            The proposal is a read-only dry-run; looking at it writes nothing.
          </Step>
          <Step
            icon={Check}
            tint="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            title="3 · Approve — writes THIS pack, immediately"
          >
            Writes that one pack&apos;s proposed re-tune to the live DB right
            away. The server re-shapes the pack fresh and applies it — one pack,
            one live write. Revertable later from the History page.
          </Step>
          <Step
            icon={X}
            tint="bg-muted text-muted-foreground"
            title="4 · Decline — skip it, no change"
          >
            Skips this pack entirely. Nothing is written; the pack stays exactly
            as it is and you move to the next one.
          </Step>
          <Step
            icon={SlidersHorizontal}
            tint="bg-amber-500/15 text-amber-600 dark:text-amber-400"
            title="5 · Adjust — tweak the targets, re-preview live"
          >
            Open the Adjust panel to change the win-rate, max-win cap, or
            near-miss floor. The card re-previews the AFTER instantly (still a
            local dry-run — nothing is written). Approve then applies your
            adjusted targets instead of the auto ones.
          </Step>
          <Step
            icon={Undo2}
            tint="bg-muted text-muted-foreground"
            title="6 · Back — revisit the previous pack"
          >
            Steps back to a pack you already passed, so you can re-read it or
            change your decision before approving.
          </Step>
        </ol>

        <p className="rounded-lg bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">System balance</span> —
          the toggle above re-loads every proposal so the whole catalog is
          balanced together (the cross-pack balancer tightens packs to keep total
          jackpot exposure and the spicy share inside their bounds), instead of
          tuning each pack on its own targets.
        </p>
      </div>
    </Disclosure>
  );
}

type GlossaryTerm = { term: string; def: string };

const GLOSSARY: GlossaryTerm[] = [
  {
    term: "House edge",
    def: "Your margin per open: 1 − (expected payout ÷ price). Higher = the house keeps more. Each pack has its own target — a 10.99% floor plus a small risk premium for pricier / jackpot-heavy packs. Emerald = at or above target (good for you); rose = below.",
  },
  {
    term: "Win-rate",
    def: "The share of opens that hit a profit card (value ≥ price) — the hit / gold rate. For a tagged pack (e.g. \"1%\"), the target equals the tag. A higher win-rate means players win more often, which costs the house.",
  },
  {
    term: "Near-miss",
    def: "The share of opens that land just below the price (between half-price and full price) — a \"so close\" outcome. A feel dial that keeps a pack from feeling dead. Some pools have no cards in that band and can't produce it.",
  },
  {
    term: "Max-win",
    def: "The single highest card value in the pool — the jackpot, the biggest payout a player can win on one open.",
  },
  {
    term: "Max-mult",
    def: "The jackpot as a multiple of the ticket price (max-win ÷ price) — the headline \"Nx\" a lucky open can return. Bounded by the pack's max-multiplier cap.",
  },
  {
    term: "CV (coefficient of variation)",
    def: "Payout volatility — the spread of payouts relative to the average. Higher = swingier, more lottery-like.",
  },
  {
    term: "Risk score (0–100)",
    def: "How swingy the pack is overall, driven mostly by CV plus jackpot size. 0 = flat, steady payouts; 100 = extreme jackpot lottery.",
  },
  {
    term: "Tier (T1–T5)",
    def: "The risk score bucketed into volatility tiers: T1 steady → T5 lottery (T1/T2 calm, T3 medium, T4/T5 jackpot-driven).",
  },
];

/** A short glossary defining every term used on the review surface. */
export function RetuneGlossary() {
  return (
    <Disclosure
      icon={BookOpen}
      title="Glossary"
      subtitle="Every term on this page, defined in one place."
    >
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {GLOSSARY.map((g) => (
          <div key={g.term} className="space-y-0.5">
            <dt className="text-xs font-semibold text-foreground">{g.term}</dt>
            <dd className="text-xs leading-relaxed text-muted-foreground">
              {g.def}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">
        Colors are from the{" "}
        <span className="font-medium text-foreground">house</span>&apos;s point
        of view:{" "}
        <span className="font-medium text-rose-600 dark:text-rose-400">rose</span>{" "}
        = the player wins more / the house gives away margin;{" "}
        <span className="font-medium text-emerald-600 dark:text-emerald-400">
          emerald
        </span>{" "}
        = healthy for the house;{" "}
        <span className="font-medium text-blue-600 dark:text-blue-400">blue</span>{" "}
        = neutral.
      </p>
    </Disclosure>
  );
}
