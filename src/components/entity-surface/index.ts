/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Entity-surface foundation  (pokewin-admin · src/components/entity-surface)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * A shared, shadcn-disciplined component system for OPERATIONAL ENTITY surfaces
 * — the dense "scan → triage → act" list+detail pages. Built additively on the
 * existing primitives (src/components/ui, src/components/data-table,
 * src/components/ux, modern-panels, the constants color-maps) with NO new deps.
 * The /packs and /cards rebuilds consume these; nothing here mutates the shared
 * CardTile or any existing surface.
 *
 * What's in the box:
 *
 *   Table + cells
 *     EntityTable          — compact, sortable (URL-driven), selection-aware
 *                            data-table foundation: sticky header, row-click →
 *                            inspector, shift-click range select, long-text-safe
 *                            cells, virtualization-ready uniform rows.
 *     rangeSelectKeys      — span helper for shift-range selection.
 *     EntityNameCell       — leading thumbnail + name (+ secondary) cell.
 *     ValueCell            — right-aligned numeric/money cell, House-POV tinted.
 *     RarityDot            — shared rarity dot.
 *
 *   Views + chrome
 *     EntityViewToggle     — URL-driven grid ⇄ table (gallery/table) switch.
 *     resolveEntityView    — server-side reader for `?view=`.
 *     FilterBar            — grouped, always-visible ACTIVE filters + clear-all,
 *                            debounced search, declarative select filters,
 *                            custom-control + leading/trailing slots.
 *     SelectionToolbar     — sticky bulk-selection bar (persistent, cross-page).
 *     useEntitySelection   — selection state with shift-range + select-all.
 *
 *   Detail without leaving the page
 *     InspectorSheet       — side-sheet detail preview with DEFERRED body
 *                            (mounts only when open) + "Open full page" deep link.
 *
 *   Status / states
 *     StatusBadge          — pill colored from the constants color-maps.
 *     ActiveBadge          — live/off availability pill.
 *     MetaChip             — neutral count/meta chip.
 *     EmptyState           — (re-export) shared empty state.
 *     InlineError          — non-blocking failed-section block with Retry
 *                            (role=status, never alert()).
 *     TileErrorFallback    — (re-export) degraded-tile fallback.
 *
 *   Skeletons (layout-matched, CLS-safe)
 *     EntityTableSkeleton, EntityGridSkeleton, FilterBarSkeleton,
 *     EntityPaginationSkeleton
 *
 * URL-state hooks live in `@/lib/entity-surface/use-url-state` (client) and
 * server loader helpers in `@/lib/entity-surface/loader`. House-POV color
 * helpers live in `@/lib/house-pov`.
 *
 * Note: most exports here are Client Components (each file carries its own
 * directive where needed). Server-only consumers can still import the
 * server-safe pieces (skeletons, cells, badges) directly.
 */

export {
  EntityTable,
  rangeSelectKeys,
  type EntityColumn,
  type EntityTableProps,
} from "./entity-table";

export { EntityViewToggle, ENTITY_VIEW_OPTIONS } from "./view-toggle";

// `resolveEntityView` + `EntityView` come from the directive-free `./view`
// module (NOT `./view-toggle`, which is "use client") so server components
// importing them from this barrel call a server-safe function rather than a
// client reference. See `./view`'s header for the full rationale.
export { resolveEntityView, type EntityView } from "./view";

export {
  FilterBar,
  type FilterBarProps,
  type FilterSelectSpec,
} from "./filter-bar";

export {
  SelectionToolbar,
  useEntitySelection,
} from "./selection-toolbar";

export { InspectorSheet } from "./inspector-sheet";

export { StatusBadge, ActiveBadge, MetaChip } from "./status-badge";

export { InlineError } from "./inline-error";

export { EntityNameCell, ValueCell, RarityDot } from "./entity-cells";

export {
  EntityTableSkeleton,
  EntityGridSkeleton,
  FilterBarSkeleton,
  EntityPaginationSkeleton,
} from "./entity-skeletons";

// Re-exports of the existing shared primitives so the rebuild can import its
// whole surface vocabulary from one place.
export { EmptyState } from "@/components/empty-state";
export { TileErrorFallback } from "@/components/tile-error-fallback";
