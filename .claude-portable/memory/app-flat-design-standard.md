---
name: app-flat-design-standard
description: Whole admin app standardized on the cleaner-flatter flat-tile look (2026-07-12) — do NOT reintroduce colored-fill/gradient/glow tiles
metadata: 
  node_type: memory
  type: project
  originSessionId: f16692e2-1482-4584-9e84-79b068f50bf9
---

The admin UI was swept to a **"cleaner & flatter"** standard: users/[id] pilot → app-wide (owner: "i rly like it, go for it", 2026-07-12).

**The flat tile rule (default for all display boxes/tiles):** shared primitives in `src/components/modern-panels.tsx` (`KpiTile`/`MetricTile`/`StatPanel`/`SectionHeading`) are FLAT — solid `bg-card`, hairline `border-border`, `rounded-lg` tiles / `rounded-xl` panels, NO gradient / glow / sheen / colored-fill; accent color lives ONLY on the icon + the value number; micro-caps labels (`text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground`); `tabular-nums` values. Do NOT reintroduce `bg-{color}-500/10` tile FILLS or `gradient`/`blur`-glow panels on tiles.

**Intentionally NOT flattened (keep glow):** `PageHero`/`PageHeroIdentity` (heroes, not tiles) and chart cards (`surface-sheen` + gradient) — their skeletons stay glowy to match.

**Preserved everywhere (stay colored — semantic):** House-POV money colors on signed-number TEXT (user profit = rose, user loss = emerald, neutral = blue) and status/rarity/role **badge pills**. Only the container SURFACES went neutral.

**Coverage:** shared primitives flattened (`406c108c`) → auto-flattened ~218 consumers; per-page custom colored tiles flattened across dashboard, insights (cost-breakdown/real-numbers), creators, analytics, upgrader (had a hand-rolled KpiTile dup), users/[id] remainder, and the tier-3 tail (rewards/challenges/rain/salaries); shared `loading-skeletons.tsx` + `tile-error-fallback.tsx` twins matched (`6270f70b`). Composed-main build verified green (64/64 pages, no cross-agent breakage).

Three selectable themes: light / dark / grailed ([[grailed-design-tokens]]). Money-color semantics are the House-POV rule (never flip to user-POV).
