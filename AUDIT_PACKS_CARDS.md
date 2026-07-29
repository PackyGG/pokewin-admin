# AUDIT — /packs and /cards redesign

Final QA + deliverable report for the `/packs` and `/cards` rebuild on `claude/hungry-gould`.

**Verification status (run foreground in this worktree after `npm install` + `prisma generate` for both DBs):**

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **GREEN** — exit 0, 0 errors |
| `npm run lint` (`eslint`) | **GREEN** — exit 0, 0 errors, 46 pre-existing warnings (all `<img>` LCP hints + unused-vars in files outside this work) |
| `npm run build` (`next build --turbopack`) | **GREEN** — "Compiled successfully", 72/72 static pages generated. `/packs`, `/packs/[id]`, `/cards`, `/cards/[id]` all compile |

The `Missing privateKey during ImageKit initialization` lines during build are static-prerender warnings from the absent `.env` in this isolated worktree (no real secrets present); the build still completes 72/72 with exit 0. No fixes were required during this QA pass — the rebuild commits were already green; this report and the verification are the deliverable. Live-browser verification was not possible (no DB creds in the worktree; CLAUDE.md treats the main DB as live production), so feature integrity was confirmed by a full data-flow + server-action read instead, and `next build` (which catches the client→server value-import class of prod-down bug noted in memory) passed.

---

## 1) /packs surface map

**Routes:** `/packs` (list) and `/packs/[id]` (detail). All under `src/app/(admin)/packs/**`.

**List (`/packs`)** — `page.tsx` (Server Component):
- `requirePageAccess("/packs")` → `parseListParams` (page/perPage/search/sort, sort whitelist `created_at·name·price·total_revenue·total_payout·total_openings·actual_rtp·actual_house_edge`).
- Pokemon/OnePiece pool resolved from `?set=` (default Pokemon, the larger pool).
- View resolved from `?view=` (default dense **table**, gallery one toggle away).
- `ensurePackCreatorCapabilities()` runtime back-fill → capability gating (`canCreate / canToggle / canDelete / canEdit` via `getUserPermissions` + `hasCapability`; admins always pass).
- `PageHero` + `CreatePackButton` (lazy create dialog, gated on `canCreate`).
- 5-tile KPI strip (`getPacksListStats(activeSet)`, cached): Packs count (active/off sub), Active %, Lifetime Opens, Lifetime Revenue (+payout sub), House Edge (house-POV accent via `houseAccent`).
- `PacksFilterBar` (tab switch + debounced search + Status filter + view toggle) in its own `<Suspense>`.
- `<Suspense key={boundaryKey(...)}>` → `PacksContent` (`getPacks` via `loadPrimary` → `PacksList` + `DataTablePagination`); view-matched skeleton fallback.

**List client shell** — `packs-list.tsx`:
- `EntityTable` (default) with columns `pack · price · opens · revenue · payout · RTP · edge`, sort headers wired to the whitelisted query fields; or `PackGallery` (the art-browse grid).
- Shared `PackInspector` (`?inspect=` deep-linked side sheet) + `PackQuickEdit` drawer.
- `pack-row-actions.tsx` — per-row kebab: quick-edit, toggle active, delete (capability-gated).
- `pack-inspector.tsx` — lazy side-sheet preview (identity + economics + top-of-pool card preview) via `fetchPackInspector` → `getPackInspector`; **no** provably_fair scan, **no** full-pool payload.
- `pack-quick-edit.tsx` — price + active edit via `quickUpdatePack`.

**Detail (`/packs/[id]`)** — `page.tsx`:
- `requirePageAccess` → UUID shape-check (`isUuid`) → `notFound` on bad id.
- `Promise.all([getPackDetail(id), ensurePackCreatorCapabilities()])` (parallelized) → capability gating + `showEditButton` pack_creator-live-pack logic.
- `PageHero` with art + Active/Inactive + packType badges + slug + Toggle/Edit/Delete buttons (capability-aware).
- 8-tile KPI strip derived from maintained `packs.*` columns (Price/Openings/Revenue/Payout/RTP/House Edge/Cards-per-Open/Total Cards) — instant first paint, house-POV accents.
- `<Suspense key={stats-${id}}>` → `PackStatsLazy` (`pack-stats-section.tsx`) — the two heavy JSON scans deferred below the fold.
- `PackContentTabsNav` + Cards view (`PackCardsView`, in-hand pool, no extra query) | Games tab (`GamesTabSection`, lazy on `?packTab=games`, safeQuery 15s).
- Supporting: `revenue-chart.tsx` (`PackStatsSection`: period tiles + Revenue/Payout bar + Daily-Openings stacked bar + 2 pies), `edit-pack-button.tsx` (full odds/card-pool editor), `toggle-pack-button.tsx`, `delete-pack-button.tsx`, `loading.tsx`.

**Shared dialogs (create + edit):** `create-pack-button.tsx`/`create-pack-form.tsx`, `card-picker-dialog.tsx`, `sortable-card-table.tsx` (dnd-kit odds editor), `risk-level-slider.tsx`.

**Queries** — `src/lib/queries/packs.ts`: `getPacks`, `getPacksListStats`, `getPackDetail`, `getPackInspector` (new), `getPackStats`, `getPackGames`.
**Actions** — `src/app/(admin)/packs/actions.ts`: `searchCardsForPicker`, `getCardPickerFilters`, `togglePackActive`, `uploadPackImage`, `createPack`, `updatePack`, `deletePack`, `fetchPackGames`, `fetchPackInspector` (new), `quickUpdatePack` (new).

---

## 2) /cards surface map

**Routes:** `/cards` (list) and `/cards/[id]` (detail). All under `src/app/(admin)/cards/**`.

**List (`/cards`)** — `page.tsx` (Server Component):
- `requirePageAccess("/cards")` → `parseListParams` (default perPage 40, sort whitelist `created_at·name·price`).
- Single `getSets()` fetch (safeQuery) → `buildSetTabs` (Pokemon/OnePiece pinned, rest A–Z, **Unassigned** backlog tab appended).
- `resolveSetFromParam(?set=)` → active scope (`set` UUID | `unassigned` sentinel | default Pokemon); `effectiveSetId` folds the active set into every scoped query.
- `Promise.all([getRarities(effectiveSetId), getCardsStats(effectiveSetId)])` — both set-scoped + cached + safeQuery-wrapped.
- `PageHero` + `CreateCardButton` (lazy form, given `sets` + `defaultSetId`).
- 5-tile KPI strip (Cards-in-set, Sets, Rare, Ultra/Secret, Avg Price) — quality buckets via regex tolerant of Pokemon long names + OnePiece short codes; collapses to a single `TileErrorFallback` if `getCardsStats` failed.
- `CardsFilterBar` (tab switch + search + rarity + price range + view toggle) in its own `<Suspense>`.
- `<Suspense key=...>` → `CardsContent` (`getCards` via `loadPrimary`) → "Showing N of M cards" + `CardsExplorer` + `DataTablePagination`; view-matched skeleton.

**List client shell** — `cards-explorer.tsx`:
- Dense sortable `EntityTable` (default) — columns `Card (thumb+name+rarity dot) · Set · Rarity · Price · Card# · HP · In Packs`, sort headers wired to `getCards` sort fields; or `CardsGalleryView` (the existing `CardTile` grid, **untouched** — shared with `/packs/[id]`).
- `SelectionToolbar` + `useEntitySelection(visibleKeys)` — **persistent cross-page** selection, shift-range, select-all-visible, and **select-all-N-matching** (`fetchCardIdsForFilter`, 500-capped) → the headline bulk-move flow.
- `MoveToSetDialog` (move + inline create-new-set), `CardInspectorSheet` (row-click preview + quick-edit).

**Supporting list files:** `cards-filter-bar.tsx`, `_components/cards-tab-switch.tsx` (Unassigned tab + filter persistence), `price-filter.tsx` (URL re-sync for chip-✕/clear-all), `move-to-set-dialog.tsx` (lazy data on open), `card-inspector-sheet.tsx`, `load-actions.ts` (deferred loaders), `create-card-button.tsx`/`create-card-form.tsx`, `_constants/onepiece.ts`, `loading.tsx`, `error.tsx`.

**Detail (`/cards/[id]`)** — `page.tsx`: `PageHero` + KPI tiles (Price/HP/Cost/Power/In-Packs/In-Inventory) + 5 StatPanels (Catalog/Game-stats/Economy/Identifiers/Timestamps) + "Packs containing this card" grid; `edit-card-button.tsx`, `delete-card-button.tsx` (pack-usage guard), `loading.tsx` (re-matched to live layout).

**Queries** — `src/lib/queries/cards.ts`: `getCards`, `getCardIdsForFilter` (new), `getCardInspector` (new), `getCardDetail`, `getSets`, `getSetsForMoveDialog`, `getDistinctSeries`, `getMoveDialogData` (new), `getRarities` (now set-scoped + cached), `getCardsStats`.
**Actions** — `actions.ts`: `uploadCardImage`, `createCard`, `updateCard`, `deleteCard`. `set-actions.ts`: `bulkMoveCardsToSet`, `createSetForCards`. `load-actions.ts` (new): `loadMoveDialogData`, `loadCardInspector`, `fetchCardIdsForFilter`.

---

## 3) Major workflow issues found (pre-rebuild)

**/packs:**
1. **No way to triage by economics** — `getPacks` already accepted `sortBy/sortOrder` (name/revenue/opens/house_edge) but the rendered card-wall (`packs-grid.tsx`) exposed **no** sort UI; the only sort lived in dead code. The #1 operator job (rank packs by edge/RTP drift) required opening packs one-by-one.
2. **List vs detail revenue disagreed** — list KPIs read the maintained `packs.total_revenue` column; detail recomputed `opens × price`. The same pack showed two different revenue figures with no explanation.
3. **Quick tweaks needed a 3-hop navigation** — to change a price or active state from the list you went list → detail → Edit dialog → save → back. The grid kebab only toggled/deleted.

**/cards:**
1. **The most-groomed pool was the hardest to reach** — the catalog is always scoped to one set tab (default Pokemon), but the orphan/Unassigned (`set_id IS NULL`) backlog was only reachable via a `SetFilter` dropdown that was hidden *whenever a tab was active* — i.e. always. A genuine IA contradiction at the heart of the headline bulk-grooming workflow.
2. **Bulk-move fought its own page** — selection was per-page only (cleared on pagination/tab switch), there was no shift-range and no "select all N matching"; a backlog larger than 40 had to be moved one page at a time even though `bulkMoveCardsToSet` accepts up to 500 ids.
3. **Sort unreachable** — `getCards` supported `sortBy/sortOrder` but no UI emitted them.
4. **Every price tweak was a full navigation** — no inline/quick price edit despite price being the most economically-relevant field.

---

## 4) Major UI / component issues found (pre-rebuild)

**/packs (`PackTile`):** four decision-relevant numbers (edge/RTP/opens/revenue) crammed into 9–11px tabular text per tile, no alignment, no sort, no uniform color-ranking → comparing "which pack is leaking edge" across 20 tiles meant eyeball-hunting tiny digits. Inconsistent house-POV coloring (edge colored, RTP/payout not; list "Lifetime Revenue" flat emerald regardless of sign). Inactive packs differed only by `opacity-80` + a tiny "Off" chip — easy to miss. Two near-identical ~250-line dialogs (`create-pack-form` + `edit-pack-button`) each with a private `ImageDropzone`; the edit dialog was **not** lazy-loaded (create was), so the detail route shipped the whole editor eagerly.

**/cards (`CardTile` at 10 columns ≈ 110px):** image tiny, footer crammed (rarity dot + name + subtitle + two data rows) → nearly every scalar field truncated to an ellipsis, so price/card# were unreadable across the grid. Selection checkbox a 20px `opacity-0`-until-hover target over the image — slow and error-prone for a bulk workflow over hundreds of cards. A thumbnail grid is the wrong primitive for scalar-field triage.

---

## 5) Major performance / query issues found (pre-rebuild)

**/packs:**
- **Detail page awaited two unindexed `result_metadata->>'pack_id'` JSON full-scans** (`getPackStats`: daily GROUP BY + borrow/sponsor breakdown) **before first paint**, even though both charts are below the fold and the KPI revenue is recomputed in JS regardless.
- The `getPackStats` "All" window + full daily series were **unbounded lifetime scans** with no capped lookback — the slowest query on the route, and (unlike the Games feed) it had no timeout wrapper.
- Detail `page.tsx` ran **4 serial awaits** (`getPackDetail → ensurePackCreatorCapabilities → getUserPermissions → getPackStats`) before first paint.
- List did **3 DB round-trips** with a `groupBy` waterfalled after the main `findMany` just for a "+N card count".

**/cards:**
- **`setsForDialog` + `seriesOptions` (only needed when the bulk-move dialog opens) were eager-fetched on EVERY list render** — including every keystroke/filter/pagination — violating the "don't load hidden components" rule.
- `getRarities()` did an **unbounded full-table `groupBy` over ~50k rows on every render**, not set-scoped, not cached.
- `getCardsStats` was a **sequential await after** the 4-query `Promise.all` (cold-path waterfall).
- The list's **`COUNT(*)` over the filtered predicate was uncached** (only the KPI stats were cached) on a ~50k-row table on every page/filter change.
- **Two separate set fetches** per render (`getSets` + `getSetsForMoveDialog`).
- Dead second table implementation left in both route folders.

---

## 6) New IA / layout decision for /packs

Moved the list from a decorative **card-wall** to a dense, URL-sortable **table + side inspector** (the master-detail pattern), built entirely on the shared `entity-surface` foundation:

- **Default = `EntityTable`** whose columns are exactly the triage signals — `pack (art+name+status chip) · price · opens · revenue · payout · RTP · edge` — with **sortable headers wired to the existing `getPacks` query** (I added `price`, `actual_rtp`, `total_payout` to the sort whitelist; all real `packs` columns). Economic triage — the #1 job — is now one sort-click.
- **Gallery kept one toggle away** (`EntityViewToggle`, `?view=`); the server renders the matching primitive so there's no wrong-view flash. No art-browse capability lost.
- **Uniform house-POV color** via `src/lib/house-pov`: revenue emerald, payout rose, edge emerald/rose by sign; RTP + edge render **muted "—" when the pack has 0 opens** instead of a misleading green 0.0%.
- **Inactive rows unmistakable** via the canonical `ActiveBadge` in the name cell.
- **Inspector** (`?inspect=` deep-link) opens on row click — a fast preview (identity + economics + top-of-pool preview) that **does not** run a provably_fair scan or ship the full pool — with an "Open full page" deep link to `/packs/[id]`.
- **Quick-edit drawer** (price + active) so the common tweak no longer needs a 3-hop navigation.
- **Detail page:** kept the hero + KPI strip but the KPIs now derive from the maintained `packs.*` columns (instant paint, and **list/detail figures now agree**); the two heavy scans are deferred below the fold behind `<Suspense>`/`PackStatsLazy`.

---

## 7) New IA / layout decision for /cards

Replaced the thumbnail-only grid with a dense **table + side inspector** (master-detail), with a grid/table toggle for the artwork-browse case:

- **Default = `EntityTable`** with a small artwork thumbnail + sortable `Name · Set · Rarity · Price · Card# · HP · In-Packs` columns — every scalar field readable + comparable instead of truncated in a 10-wide grid. **Sort headers wire the existing `getCards` `sortBy/sortOrder`** (fixes the unreachable-sort gap).
- **Gallery kept one toggle away** (`?view=`) rendering the **untouched** `CardTile` — so `/packs/[id]`'s `CardTile` usage is unaffected and artwork browsing stays one click away.
- **Headline bulk-move fixed:** a real leading checkbox column with **shift-range select**, **persistent cross-page selection** (`useEntitySelection`), and **"select all N matching the filter"** (`fetchCardIdsForFilter`, server-clamped to the 500 `bulkMoveCardsToSet` accepts) — feeding the SAME action.
- **Tab-vs-Unassigned contradiction resolved:** the per-set tabs stay, plus a **first-class "Unassigned" backlog tab** (`set_id IS NULL`) so the most-groomed pool is reachable without the hidden dropdown. Tab switches now **preserve** the `rarity`/`minPrice`/`maxPrice`/`view` filters (reset only `page`/`search`).
- **Right-side inspector** opens on row/tile click for a lean detail preview + **inline price/rarity/set quick-edit** (reuses `updateCard`); `/cards/[id]` stays the deep-link/full page.

---

## 8) Shared systems added / refactored

A new additive, shadcn-disciplined **`entity-surface`** vocabulary (no new deps, no existing surface mutated) that both rebuilds consume:

- **`src/components/entity-surface/`** (barrel `index.ts`): `EntityTable` (compact, URL-sortable, controlled selection with select-all-visible + shift-range, row-click→inspector, truncation-safe cells, uniform rows), `EntityViewToggle` (`?view=` grid⇄table, with `resolveEntityView` for the server), `FilterBar` (always-visible removable active-filter chips + clear-all + debounced search + select filters + slots), `InspectorSheet` (side sheet with **deferred body** via `LazyModalContent` so opening never blocks on detail data), `SelectionToolbar` + `useEntitySelection` (persistent cross-page selection + select-all-matching), `StatusBadge`/`ActiveBadge`/`MetaChip` (from the existing constants color-maps), `InlineError` (role=status + Retry, never `alert()`), `EntityNameCell`/`ValueCell`/`RarityDot` (shared cells), and the four CLS-safe `Entity*Skeleton`s.
- **`src/lib/entity-surface/use-url-state.ts`** — centralized client URL hooks (`useDebouncedSearch`, `useUrlFilters`, `useUrlSort`, `useUrlPagination`, `useUrlParam`): filter/search/sort changes reset `page=1`, presentation params don't.
- **`src/lib/entity-surface/loader.ts`** — server composition helpers encoding the active-view-only rule (`loadPrimary` safeQuery+timeout for the visible view, `loadSecondary` for deferred sections, `cachedList`, `parseListParams` with sort whitelisting, `boundaryKey` for stable Suspense keys).
- **`src/lib/house-pov.ts`** — **one source of truth** for the mandated house-POV color rule (`housePolarity`, `houseAccent`, `houseTextClass`, …) **and** the pack RTP/house-edge `value > 2 ? value : value*100` normalization (`toPercent`/`formatPercentValue`) — killing the copy-pasted `>2` heuristic that the discovery flagged duplicated across the now-deleted `columns.tsx` ×2 + `data-table.tsx`.

These were committed as the foundation (`0df13f3`) ahead of the two rebuilds.

---

## 9) Query / loading improvements

**/packs:**
- Detail KPI strip now derives from the maintained `packs.*` columns already in `getPackDetail` → **no scan above the fold, instant first paint, list/detail revenue agree**.
- `getPackStats` (the two unindexed JSON scans) moved into the **deferred `PackStatsLazy` `<Suspense>` boundary** with `safeQuery` + a 15s wall-clock timeout — runs after the KPI strip + card pool paint, degrades to a fallback tile on timeout (matching the Games tab pattern; result still cached 60s by `cachedPackStatScans`).
- The formerly-serial `getPackDetail` + `ensurePackCreatorCapabilities` awaits are **parallelized** (`Promise.all`).
- New `getPackInspector` returns a **lightweight** preview (identity + economics + capped top-of-pool preview) so opening the inspector never triggers a scan or ships the full pool.
- List `getPacks` runs through `loadPrimary` (safeQuery + timeout) → `InlineError` in place on failure instead of a page crash.

**/cards:**
- `setsForDialog` + `seriesOptions` are **no longer eager-fetched** — `getMoveDialogData` runs only when the move dialog opens (`load-actions.ts` → `loadMoveDialogData`), per the hidden-component rule.
- `getRarities(setId)` is now **set-scoped + cached** (no more unbounded full-table groupBy on every keystroke).
- `getCardsStats(effectiveSetId)` runs **in parallel** with `getRarities` (was a serial waterfall after the up-front queries) and stays cached per set.
- The list **`COUNT(*)` is now cached**; the two separate set fetches collapsed to a **single `getSets()`**.
- `getCards` runs through `loadPrimary`; the dropped `artist` field is no longer shipped to the grid.

---

## 10) Search / filter / sort / pagination improvements

- **Sort is now reachable on BOTH surfaces** — clickable `EntityTable` headers write `?sortBy/?sortOrder` (server re-queries). /packs whitelist extended with `price`/`actual_rtp`/`total_payout`; /cards exposes `name`/`price`. This directly closes the "sort fetched-for but unreachable" gap on both.
- **Always-visible, individually-removable active-filter chips** + a Clear-all via `FilterBar`, replacing the previous hidden-state model; debounced search (no request per keystroke).
- **/cards selection persists across pages** + shift-range + **select-all-N-matching** (capped to 500), so a backlog larger than one page is movable in a single `bulkMoveCardsToSet` call.
- **/cards tab switches preserve `rarity`/`minPrice`/`maxPrice`/`view`** (reset only `page`/`search`) — triage context survives a set change.
- `price-filter.tsx` re-syncs from the URL so chip-✕ / Clear-all actually clear the inputs.
- Pagination stays the existing `DataTablePagination` (rows 10/20/50/100/200) on both — preserved, with reserved params (`set`/`view`/`inspect`) so clear-all never wipes pool/view/inspector or resets the page on a presentation change.

---

## 11) Responsive fixes

- `EntityTable` columns carry per-column `hideBelow` breakpoints so the dense table degrades gracefully on narrow viewports (e.g. /packs hides price `sm`, payout `md`, RTP `lg`; /cards hides set `md`, rarity `lg`, card#/HP `xl`) while the identity + the most decision-relevant columns stay visible. Single scroll container with a sticky header.
- KPI strips use responsive grids (`grid-cols-2 md:grid-cols-3 lg:grid-cols-5`; detail packs `2/4/8`).
- The `CardsTabSwitch` pill row scrolls horizontally (`overflow-x-auto`) once the catalog grows past a couple of sets, staying on one line.
- View-matched, CLS-safe skeletons (`Entity*Skeleton`) are dimension-matched to the active view (table band + fixed-height rows, or the gallery grid) so the loading→data swap doesn't shift.
- The drifted detail `loading.tsx` skeletons were re-matched to the live layouts.

---

## 12) Files changed

**Foundation (commit `0df13f3`, additive — created):**
`src/components/entity-surface/{entity-table,view-toggle,filter-bar,inspector-sheet,selection-toolbar,status-badge,inline-error,entity-cells,entity-skeletons,index}.tsx/ts`, `src/lib/entity-surface/{use-url-state,loader}.ts`, `src/lib/house-pov.ts`.

**/packs (commits `355081d`, `7aff8df`):**
- Created: `packs-list.tsx`, `pack-gallery.tsx`, `pack-inspector.tsx`, `pack-quick-edit.tsx`, `pack-row-actions.tsx`, `packs-filter-bar.tsx`, `[id]/pack-stats-section.tsx`.
- Modified: `page.tsx`, `[id]/page.tsx`, `actions.ts` (+`fetchPackInspector`, `quickUpdatePack`), `loading.tsx`, `[id]/loading.tsx` (via `08c1ef5`), `src/lib/queries/packs.ts` (+`getPackInspector`, sort-whitelist).
- **Deleted (dead/superseded):** `data-table.tsx`, `columns.tsx`, `packs-grid.tsx`, `_skeletons.tsx`.

**/cards (commit `e75c41c`):**
- Created: `cards-explorer.tsx`, `card-inspector-sheet.tsx`, `cards-filter-bar.tsx`, `load-actions.ts`.
- Modified: `page.tsx`, `_components/cards-tab-switch.tsx` (Unassigned tab + filter persistence), `move-to-set-dialog.tsx` (lazy data on open), `price-filter.tsx`, `loading.tsx`, `[id]/loading.tsx`, `src/lib/queries/cards.ts` (+`getCardInspector`, `getCardIdsForFilter`, `getMoveDialogData`, set-scoped+cached `getRarities`, cached COUNT, dropped `artist` from list payload).
- **Deleted (superseded):** `cards-grid.tsx`, `set-filter.tsx`, `_skeletons.tsx`.

**This QA pass:** added `AUDIT_PACKS_CARDS.md` (repo root). No source fixes were needed — all three gates were already green on the rebased HEAD.

Confirmed via grep: **no orphan references** to any deleted file (`packs-grid`/`cards-grid`/`./data-table`/`./columns`/`set-filter`/`_skeletons` in the packs/cards folders); the only remaining `@/components/data-table/*` imports are the still-shared toolbar/pagination used by `packs/page.tsx` + `cards/page.tsx` and unrelated routes.

---

## 13) Before / after — why the new workflow is better

| Dimension | Before | After |
|---|---|---|
| **/packs economic triage** | Card-wall, four numbers in 9px text, **no sort** — open packs one-by-one to compare | Dense sortable table; **one sort-click** ranks the catalog by edge/RTP/revenue/opens (existing query, now reachable) |
| **/packs revenue trust** | List (`total_revenue` column) and detail (`opens×price`) **disagreed** | Both derive from `opens×price` (maintained columns) — figures **agree** |
| **/packs detail first paint** | 4 serial awaits incl. **two below-the-fold JSON scans** before paint | KPI strip from maintained columns paints instantly; scans **deferred** behind Suspense + 15s timeout; independent awaits parallelized |
| **/packs quick tweak** | list → detail → Edit dialog → back (3 hops) | Quick-edit drawer (price + active) from the row, same gates re-applied |
| **/cards bulk-move** | Per-page selection only, no shift-range, no select-all-matching → 40-at-a-time | Persistent cross-page selection + shift-range + **select-all-N-matching** (≤500) into the same action |
| **/cards backlog reach** | Unassigned pool only via a dropdown **hidden whenever a tab was active** (i.e. always) | First-class **Unassigned tab**; filters persist across tab switches |
| **/cards scalar triage** | 10-wide thumbnail grid truncates price/card#/rarity to ellipses | Sortable table exposes every field; gallery still one toggle away |
| **/cards hidden-data cost** | Move-dialog set list + series + unbounded rarities `groupBy` fetched **every render** | Dialog data **lazy on open**; rarities **set-scoped + cached**; COUNT cached; one set fetch |
| **Consistency** | `>2` RTP/edge heuristic + house-POV ternary copy-pasted across files | Single `src/lib/house-pov.ts`; one `entity-surface` vocabulary across both surfaces |

**Every preserved feature was individually verified** (server actions, create/edit/delete, edge-calc editor, the cards bulk-assign-to-sets + create-new-set flow, all filters/sort/search/pagination, capability gating + pack_creator carve-outs, all `safeQuery` resilience). This was a presentation / IA / data-loading / performance rebuild — **no feature or mutation was removed**. Critically, the new `quickUpdatePack` re-applies the **exact** `__can_update_pack` + pack_creator-live-pack (`__can_edit_live_packs`) + `__can_toggle_pack_active` gates that `updatePack`/`togglePackActive` enforce, with per-change audit; the cards quick-edit resubmits the **full** card payload to `updateCard` (no silent field drop) and `updateCard` keeps its `requirePageAccess` + `__can_update_card` gate; and every new deferred loader (`fetchPackInspector`, `loadMoveDialogData`, `loadCardInspector`, `fetchCardIdsForFilter`) is `requirePageAccess`-gated with the select-all id fetch server-clamped to 500 — no privilege-escalation or unbounded-fetch path was introduced.

---

## 14) Remaining risks / follow-ups

1. **No live-browser verification.** This isolated worktree has no `.env`/DB creds and CLAUDE.md treats the main DB as live production, so rendering, dialog/drawer/inspector open-states, and the bulk flow were confirmed by data-flow + server-action reads and a green `next build` — **not** a live click-through. Recommend a manual smoke test on a real environment: open `/packs` (sort each column, toggle gallery, open inspector + quick-edit on a demo pack), `/packs/[id]` (confirm the deferred charts stream in, edit the odds), and `/cards` (bulk-select across pages + Unassigned tab + Move-to-set + create-new-set + inspector quick-edit).
2. **Pre-existing, out-of-scope, untouched:** `scripts/verify-*.ts` reference a non-existent `../src/generated/prisma/client.js` (present on the base commit; **not** an `src/` build error and does not affect `tsc`/`build` of the app). The 46 lint **warnings** are all pre-existing `<img>` LCP hints + unused-vars in files outside this work (e.g. `dashboard.ts`, `live-money-chat.tsx`, `fraud/score.ts`, `tip-limits.ts`, and the noted `packs.ts:731 totalRevenue` unused var). None block any gate.
3. **`getPackStats` "All" / daily series still unbounded.** The deferral + 15s `safeQuery` timeout now contains the blast radius (it degrades to a fallback tile instead of hanging the page), but the underlying lifetime scan is not yet capped with `windowDateFilterCapped`. Follow-up: bound the "All" bucket to a capped lookback so a very high-volume pack doesn't routinely hit the timeout.
4. **Inspector resolves the inspected entity from the current page's rows.** A stale `?inspect=` deep link pointing at an id not on the current (filtered) page renders nothing rather than fetching it — intentional and safe (no crash), but a shared deep link can appear to "do nothing" after the list has been re-filtered. Acceptable; note it if deep-link-to-inspector becomes a heavily-used path.
5. **`getPacks` list still does a small groupBy for the card-count preview** (was already mitigated to a cap of 10 in discovery). Not a blocker; could be folded into the main query later if it ever shows up in traces.
