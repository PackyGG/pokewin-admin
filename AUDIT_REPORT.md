# Layout-Integrity Audit — analytics / insights / creators / rewards

Scope: `src/app/(admin)/analytics/**`, `src/app/(admin)/insights/**` (excl.
`insights/cost-breakdown`, owned by another agent), `src/app/(admin)/creators/**`,
`src/app/(admin)/rewards/**`.

Target: the **layout-integrity** bug class the owner flagged from a screenshot of a
"GGR Breakdown" card — ultra-narrow text columns wrapping one word per line, blank /
unreserved chart regions, detached/orphan action buttons, misaligned filter rows, and
side-rails crowding the card edge. Skeleton / motion / loading was already handled by an
earlier UX swarm and was out of scope here.

Verification: `npx tsc --noEmit`, `npm run lint`, `npm run build` — all green.

---

## Headline finding

The in-scope surfaces are, with one exception, already free of the screenshot bug class.
The earlier UX swarm did thorough work: chart containers carry explicit reserved heights,
data grids use `min-w-0` + `truncate`, fixed-pixel column grids are wrapped in horizontal-
scroll containers, every chart has an empty/error placeholder, and headers compose the
`PageHero` / `SectionHeading` / `StatPanel` modern primitives correctly. I deliberately did
**not** invent cosmetic edits where none were warranted.

Exactly one genuine instance of the screenshot class was found and fixed.

---

## FIXED

### `insights/rewards/signup` — Country tab (`_components/country-tab.tsx`)

**Bug (screenshot class: side-rail crowding / horizontal overflow at small widths).**
The "Top 15 countries" table is a CSS-grid with five fixed metric columns plus a flexible
share-bar column:

```
grid-cols-[44px_minmax(0,1fr)_72px_64px_96px_64px]
```

Unlike its sibling tabs in the same folder — `cohort-tab.tsx` and `heatmap-grid.tsx`, which
both wrap their fixed-pixel grids in `overflow-x-auto` + `inline-block min-w-full` — this
grid had **no** horizontal-scroll wrapper. The five fixed columns total ≈340px; with the
five 8px gaps and row padding the unshrinkable content is ≈396px. Below ~400px viewport
width (e.g. 375px) the only flexible track (`minmax(0,1fr)`, the share bar) collapses toward
zero, leaving a crushed, edge-crowded row with a vanished bar — the screenshot symptom.

**Fix.** Mirrored the sibling pattern exactly:
- Wrapped the header row + the per-country rows in `overflow-x-auto` → `inline-block
  min-w-full`, so on narrow screens the table scrolls horizontally and every column keeps
  its intended width instead of crushing the bar.
- Raised the share-bar track from `minmax(0,1fr)` to `minmax(120px,1fr)` so the bar always
  has a readable minimum inside the scroll region.

Layout/structure only — no data, query, number, or color change. The continent-rollup block
above it was already responsive (`grid-cols-2 sm:grid-cols-3 lg:grid-cols-6`) and was left
untouched.

---

## Screenshot-derived fixes (per symptom)

| Symptom from the flagged screenshot | Instances found + fixed in scope |
|---|---|
| Ultra-narrow text column (one word per line) | none found — descriptive copy across the scope is already capped or laid out in flex rows with `min-w-0`/`truncate` |
| Blank / unreserved chart region | none found — every `ResponsiveContainer` / `ChartContainer` in scope sits inside an explicitly-sized parent (e.g. `h-[240px]`, `h-56`, `h-72`, `aspect-auto h-[280px]`) and every chart has an `EmptyState` for the no-data case |
| Detached / orphan action button | none found — chart-card controls (range toggles, export, popover triggers, manage-links) are anchored in their header/control rows via `flex … justify-between` |
| Misaligned filter row | none found — period filters / group-by toggles sit in the `PageHero` action slot or a `SectionHeading` action and align to the header row |
| Side-rail crowding / horizontal overflow at small widths | **1 fixed** — `insights/rewards/signup` Country tab (see FIXED above) |

---

## Verified clean (representative — not exhaustive)

These chart/card-heavy surfaces were read and confirmed to already satisfy the audit
criteria (reserved chart heights, `min-w-0`/`truncate`, wrapped fixed-pixel grids,
empty/error placeholders, aligned control rows, dark-mode CSS-variable tokens):

- **analytics**: `page.tsx` (PageHero + per-tab Suspense), `charts.tsx`, `sections.tsx`,
  `cohorts-heatmap.tsx`, `map/country-leaderboard.tsx`, `map/continent-breakdown.tsx`,
  `tab-geo.tsx` (via `insights`).
- **insights**: `games/page.tsx`, `games/tab-overview.tsx`, `games/overview-chart.tsx`,
  `games/upgrader-histogram.tsx`, `analytics/tab-geo.tsx`, `analytics/kpi-sparkline.tsx`,
  `edge-calc/scenario-builder.tsx`, `rewards/signup/cohort-tab.tsx`,
  `rewards/signup/heatmap-grid.tsx`, `rewards/rakeback/top-claimers-tab.tsx`,
  `rewards/rakeback/lapsed-tab.tsx`, `rewards/deposit-bonus/impact-charts.tsx`.
- **creators**: `[userId]/creator-pnl-panel.tsx`, `[userId]/wager-breakdown-card.tsx`,
  `[userId]/acquisition-chart.tsx`, `[userId]/_components/deals-tab.tsx`,
  `codes/[code]/charts.tsx`.
- **rewards**: `analytics/_components/overview-tab.tsx`, `analytics/rewards-chart.tsx`.

The shadcn `<Table>` primitive (`src/components/ui/table.tsx`) already wraps every table in
`overflow-x-auto`, so all `<Table>`-based leaderboards in scope are overflow-safe by
construction; only hand-rolled CSS-grid "tables" needed an explicit wrapper, and all but the
Country tab already had one.

---

## DEFERRED / out of scope (untouched)

- `insights/cost-breakdown/**`, the dashboard, `/ggr`, `revenue-stat-card.tsx`,
  `topbar-house-stats.tsx`, `admin-header.tsx`, `(admin)/layout.tsx` — owned by other agents.
- `src/lib/queries/**`, `src/lib/metrics/**`, `src/generated/**`, `src/components/ui/**`
  shared primitives — not edited (no shared-primitive change was required for the one fix).
