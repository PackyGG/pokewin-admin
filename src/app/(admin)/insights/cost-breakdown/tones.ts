/**
 * ─────────────────────────────────────────────────────────────────────
 * Cost-Breakdown semantic tone language (SERVER-SAFE — no "use client")
 * ─────────────────────────────────────────────────────────────────────
 *
 * The page's restrained colour vocabulary, pulled into a directive-free
 * module so BOTH the server `page.tsx` and the client components
 * (`_components.tsx`, `waterfall-row.tsx`) read the SAME real object.
 *
 * Why this lives apart from `_components.tsx`: that file carries the
 * "use client" directive (it owns the interactive popover + chips), so
 * anything imported FROM it by a server component is a CLIENT REFERENCE
 * proxy — not the actual value. The server `page.tsx` reads
 * `SEMANTIC_TONES[tone]` directly while rendering its tiles/waterfall; if
 * that lookup resolves against a client-reference proxy it is `undefined`,
 * and `undefined.face` crashes during Flight serialization
 * ("Cannot read properties of undefined (reading 'face')" at stringify) —
 * the `?? SEMANTIC_TONES.muted` guard is a no-op because the fallback
 * reads from the very same dead proxy. Defining the pure tokens in this
 * directive-free module lets the server import the genuine object, while
 * client components import it just the same. Mirrors the
 * `entity-surface/view.ts` split that fixed the /cards + /packs crash.
 *
 * Flat direction (matches the modern-panels pilot): the tinted FACE + the
 * hue RING were the layered colour that read as "not clean" — dropped. Every
 * tone's `face`/`ring` is now the SAME neutral surface (a solid muted face +
 * a hairline border ring); the tone's meaning survives ONLY on the value
 * TEXT, the icon glyph, the icon CHIP and the magnitude BAR (House-POV):
 * held / unrealized liabilities keep AMBER so they never read as a realized
 * loss (rose); realized costs / money-back stay rose; the house keep
 * (GGR/NGR/P&L positive) is emerald; the base wager is blue; the honest
 * leftover is muted.
 */

export type SemanticTone =
  /** Money the house KEEPS / is up on (GGR, NGR, P&L positive). */
  | "keep"
  /** A realized cost — money that flowed BACK to users (rose). */
  | "cost"
  /** Held / unrealized liability the house still owes (amber, NOT a
   *  realized loss). */
  | "held"
  /** The starting wager / a neutral cash-in (blue). */
  | "base"
  /** Honest leftover / rounding (muted). */
  | "muted";

export type ToneTokens = {
  /** Neutral surface face (flattened — no longer per-tone tinted). */
  face: string;
  /** Neutral hairline ring (flattened — no longer the tone hue). */
  ring: string;
  /** Icon-chip background (keeps the tone hue — the accent chip). */
  chip: string;
  /** Value / accent text colour (light + dark). */
  text: string;
  /** Bare icon colour. */
  icon: string;
  /** Magnitude-bar fill. */
  bar: string;
  /** Focus ring for interactive triggers. */
  focus: string;
};

export const SEMANTIC_TONES: Record<SemanticTone, ToneTokens> = {
  keep: {
    // Flat: neutral face + hairline ring; the emerald hue lives on the
    // text / icon / chip / bar below, never the surface.
    face: "bg-muted/40",
    ring: "ring-border/60",
    chip: "bg-emerald-500/15 text-emerald-500 dark:text-emerald-400",
    text: "text-emerald-600 dark:text-emerald-400",
    icon: "text-emerald-500",
    bar: "bg-emerald-500/55",
    focus: "focus-visible:ring-emerald-500/40",
  },
  cost: {
    // Flat: neutral face + hairline ring; the rose hue lives on the text /
    // icon / chip / bar below, never the surface.
    face: "bg-muted/40",
    ring: "ring-border/60",
    chip: "bg-rose-500/15 text-rose-500 dark:text-rose-400",
    text: "text-rose-600 dark:text-rose-400",
    icon: "text-rose-500",
    bar: "bg-rose-500/55",
    focus: "focus-visible:ring-rose-500/40",
  },
  held: {
    // Flat: neutral face + hairline ring; the amber hue lives on the text /
    // icon / chip / bar below, never the surface.
    face: "bg-muted/40",
    ring: "ring-border/60",
    chip: "bg-amber-500/15 text-amber-500 dark:text-amber-400",
    text: "text-amber-600 dark:text-amber-400",
    icon: "text-amber-500",
    bar: "bg-amber-500/55",
    focus: "focus-visible:ring-amber-500/40",
  },
  base: {
    // Flat: neutral face + hairline ring; the blue hue lives on the text /
    // icon / chip / bar below, never the surface.
    face: "bg-muted/40",
    ring: "ring-border/60",
    chip: "bg-blue-500/15 text-blue-500 dark:text-blue-400",
    text: "text-blue-600 dark:text-blue-400",
    icon: "text-blue-500",
    bar: "bg-blue-500/55",
    focus: "focus-visible:ring-blue-500/40",
  },
  muted: {
    face: "bg-muted/40",
    ring: "ring-border/60",
    chip: "bg-muted text-muted-foreground",
    text: "text-muted-foreground",
    icon: "text-muted-foreground",
    bar: "bg-muted-foreground/40",
    focus: "focus-visible:ring-ring/40",
  },
};
