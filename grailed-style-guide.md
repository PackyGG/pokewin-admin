# Grailed Dark theme — quick style guide

pokewin-admin's third theme (`.grailed` class, `next-themes`, toggled alongside `light`/`dark`). Faithful recreation of the real Grailed admin dashboard's design language, tokens extracted live from `grailed-mgmt.onrender.com` / `grailed.gg` on 2026-07-11. Implemented in `src/app/globals.css` (search `.grailed`).

**Do not copy Grailed's logo / gem glyph / brand assets.** Visual language only. Keep this app's House-POV money-color semantics (emerald/rose) — do NOT flip to Grailed's own user-flow color convention; those two systems are independent.

## Typeface

`Chakra Petch` (Google Fonts, non-variable — load explicit weights 400/500/600/700).
- Inputs/buttons: bold-ish, weight 600–700.
- Uppercase micro-labels: tracking ~0.08–0.12em, weight 500, color `#9494B3`.

## Neutral ramp (`--ds-*`, indigo/purple-tinted — NOT blue-slate)

| Step | Hex | Use |
|---|---|---|
| 0 | `#131320` | darkest surface (sidebar) |
| 10 | `#1A1A29` | page background |
| 50 | `#1F1F30` | card / input fill |
| 100 | `#202032` | elevated surface (large cards) |
| 150 | `#242438` | |
| 200 | `#26263B` | |
| 250 | `#2A2A41` | |
| 300 | `#2E2E48` | borders (solid, not translucent) |
| 350 | `#30304A` | |
| 400 | `#393956` | |
| 600 | `#6A6A8A` | |
| 650 | `#8383AA` | |
| 700 | `#9494B3` | secondary text |
| 800 | `#ACACCB` | |
| 900 | `#F1F1FE` | primary text |

## Accents (exact, from the public site)

| Accent | Hex | Notes |
|---|---|---|
| Cyan (`--ds-primary`) | `#65E3FF` | text-on `#131320` |
| Green | `#5CFF6E` | positive / badge; tint bg `rgba(92,255,110,.12)` |
| Gold/amber | `#FFB84F` | currency |
| Red (`--ds-red`) | `#FF5165` | |
| Orange (`--ds-orange`) | `#FF8E47` | |
| Blue | `#54A3FF` | secondary accent |

Only `--ds-primary` / `--ds-orange` / `--ds-red` are real CSS vars on the source site; green/blue/amber are rendered accents, not vars — treat all six the same way here.

## Metrics

- Radius: **~8px** (`--border-radius: 8px`) for controls/inputs. Badges/pills: **4px**. Large product/KPI cards: **12px**, borderless, elevated bg `#202032`.
- Borders: **1px solid `#2E2E48`** (indigo hairline — solid, never translucent white).
- Inputs: height ≈44px, px-12.
- Card/input fill: `#1F1F30`.

## Badge / pill pattern

`bg-{accent}/12` + `text-{accent}`, radius 4px, uppercase, 12px, weight 600, tracking ≈ -0.02em.

## Structural language

- Colored left-accent-bar KPI cards.
- Uppercase micro-labels throughout.
- Filled active-tab pills, segmented pill controls.
- Darkest-surface (`#131320`) grouped sidebar with a filled active pill.
- Charts (Recharts): cyan-area + amber-dashed lines, dark tooltip using `#1F1F30` fill / `#2E2E48` border, micro-label typography.

## Known past mistake (do not repeat)

An earlier v1 pass (commit `415d6dc5`) shipped as a plain recolor and got it wrong: blue-slate `#131722` instead of indigo `#1A1A29`, Geist instead of Chakra Petch, `#4CC3FF` instead of `#65E3FF`, translucent-white borders instead of solid `#2E2E48`, 12px radius instead of 8px. The v2 fix corrected all of these and added the structural language above — don't regress back toward v1.

## Source of truth in repo

`src/app/globals.css` → search for `.grailed` (theme block starts around the `"Grailed Dark" — third theme` comment). `next-themes` applies a single `.grailed` class to `<html>`; the `dark` custom-variant also matches `.grailed`, so every `dark:` utility fires under Grailed automatically — only the palette + typeface differ, no per-component `grailed:` variants needed.
