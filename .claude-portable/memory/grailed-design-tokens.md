---
name: grailed-design-tokens
description: "Real design tokens of the Grailed admin dashboard (grailed-mgmt.onrender.com), extracted live for the \"Grailed Dark\" theme"
metadata: 
  node_type: memory
  type: reference
  originSessionId: f16692e2-1482-4584-9e84-79b068f50bf9
---

Design tokens of the **Grailed admin dashboard** (`grailed-mgmt.onrender.com`), extracted 2026-07-11 by reading the live site's CSS + computed styles via the owner's Chrome (the design system loads on the public sign-in page, so no login was needed). Source of truth for the app's `grailed` theme ([[pack-studio-current-state]] repo). Recreating the *visual language* is authorized; do NOT copy their logo / gem glyph / brand assets.

**Typeface:** `Chakra Petch` (Google Fonts, non-variable — needs explicit weights 400/500/600/700). Bold-ish (600–700) on inputs/buttons; uppercase micro-labels tracked ~0.08–0.12em, weight 500, color `#9494B3`.

**Neutral ramp `--ds-*` (indigo/purple-tinted, NOT blue-slate):** 0 `#131320` · 10 `#1A1A29` (bg) · 50 `#1F1F30` (card/input fill) · 100 `#202032` · 150 `#242438` · 200 `#26263B` · 250 `#2A2A41` · 300 `#2E2E48` (borders) · 350 `#30304A` · 400 `#393956` · 600 `#6A6A8A` · 650 `#8383AA` · 700 `#9494B3` (secondary text) · 800 `#ACACCB` · 900 `#F1F1FE` (primary text).

**Accents (EXACT — from the public grailed.gg site, 2026-07-11):** cyan `#65E3FF` (`--ds-primary`, text-on `#131320`) · green `#5CFF6E` (positive/badge; tint bg `rgba(92,255,110,.12)`) · gold/amber `#FFB84F` (currency) · red `#FF5165` (`--ds-red`) · orange `#FF8E47` (`--ds-orange`) · blue `#54A3FF` (secondary accent). grailed.gg exposes only `--ds-primary/--ds-orange/--ds-red` as vars; green/blue/amber are rendered accents. **Badge/pill pattern:** `bg-{accent}/12` + `text-{accent}`, radius 4px, uppercase 12px/600, tracking ~-0.02em. **Radius scale:** badges 4px · controls/inputs ~8px · large product cards 12px (borderless, elevated bg `#202032`). The admin dashboard and public grailed.gg share the SAME design system (same `--ds-*` ramp, Chakra Petch, `#65E3FF`), so the public site is the accessible source of truth — no admin login needed.

**Metrics:** radius ~7–8px (`--border-radius: 8px`); 1px SOLID borders `#2E2E48` (indigo hairline, not translucent white); inputs h≈44px, px-12; borders/cards `#1F1F30` fill.

**Structural language (from dashboard screenshot):** colored left-accent-bar KPI cards, uppercase micro-labels, filled active-tab pills, segmented pill controls, darkest-surface (`#131320`) grouped sidebar with filled active pill, cyan-area + amber-dashed Recharts chart with a dark `#1F1F30`/`#2E2E48` micro-label tooltip.

**v1 mistake (commit 415d6dc5):** shipped as a recolor only — wrong hue (blue-slate `#131722` instead of indigo `#1A1A29`), missing Chakra Petch (was Geist), `#4CC3FF` instead of `#65E3FF`, translucent-white borders, 12px radius. v2 upgrade corrects all of these + adds the structural language. Adopt Grailed's styling but KEEP the app's House-POV money-color semantics (do not flip to Grailed's user-flow POV).
