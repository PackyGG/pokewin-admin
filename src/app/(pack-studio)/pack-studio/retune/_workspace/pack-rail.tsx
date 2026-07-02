"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import type { RetuneRailRow } from "../_queries/rail";
import { RailRow } from "./rail-row";
import type { PackVerdict } from "./plan-state";

/**
 * The left pack rail (§6): filter row (search / tier Select / Below-target /
 * Tagged / Off-tag chips / sort Select) + a plain list of all rows (183
 * memoized rows — no virtualization needed) + the bulk header checkbox
 * (select-all-filtered, shift-click range on rows).
 *
 * Default sort = **Attention**: offTagLive first → (targetEdge − edge) desc
 * → riskScore desc. The current FILTERED order is reported up
 * (`onVisibleIdsChange`) so ↑/↓ keyboard selection walks the same order the
 * operator sees.
 *
 * Below `lg` the rail renders as a Collapsible "Packs ({n})" above the
 * workspace (§8); at `lg`+ it is the sticky left column.
 */

export type RailSortKey = "attention" | "edgeGap" | "riskScore" | "price" | "name";

const SORT_LABELS: Record<RailSortKey, string> = {
  attention: "Attention",
  edgeGap: "Edge gap",
  riskScore: "Risk score",
  price: "Price",
  name: "Name",
};

export function attentionCompare(a: RetuneRailRow, b: RetuneRailRow): number {
  if (a.offTagLive !== b.offTagLive) return a.offTagLive ? -1 : 1;
  const gap = b.targetEdge - b.edge - (a.targetEdge - a.edge);
  if (Math.abs(gap) > 1e-12) return gap;
  return b.riskScore - a.riskScore;
}

function sortRows(rows: RetuneRailRow[], key: RailSortKey): RetuneRailRow[] {
  const out = [...rows];
  switch (key) {
    case "attention":
      out.sort(attentionCompare);
      break;
    case "edgeGap":
      out.sort((a, b) => b.targetEdge - b.edge - (a.targetEdge - a.edge));
      break;
    case "riskScore":
      out.sort((a, b) => b.riskScore - a.riskScore);
      break;
    case "price":
      out.sort((a, b) => b.price - a.price);
      break;
    case "name":
      out.sort((a, b) => a.name.localeCompare(b.name));
      break;
  }
  return out;
}

/** Small filter chip button (house pill style, no new primitives). */
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] font-medium motion-safe:transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border bg-card text-muted-foreground hover:bg-muted/50",
      )}
    >
      {children}
    </button>
  );
}

/** `lg` media-query hook (the rail collapses below the 2-column breakpoint). */
function useIsLg(): boolean {
  const [isLg, setIsLg] = React.useState(false);
  React.useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setIsLg(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isLg;
}

export function PackRail({
  rows,
  selectedPackId,
  checkedIds,
  stagedIds,
  pushedIds,
  verdictByPack,
  searchInputRef,
  onSelect,
  onCheck,
  onVisibleIdsChange,
}: {
  rows: RetuneRailRow[];
  selectedPackId: string | null;
  checkedIds: Set<string>;
  stagedIds: Set<string>;
  pushedIds: Set<string>;
  verdictByPack: Map<string, PackVerdict>;
  /** The workspace's `/` shortcut focuses this input. */
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onSelect: (packId: string) => void;
  /** Batch check/uncheck (single row, shift-range, select-all-filtered). */
  onCheck: (ids: string[], checked: boolean) => void;
  /** Reports the CURRENT filtered+sorted order (keyboard ↑/↓ + select-all). */
  onVisibleIdsChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = React.useState("");
  const [tier, setTier] = React.useState("all");
  const [belowTarget, setBelowTarget] = React.useState(false);
  const [tagged, setTagged] = React.useState(false);
  const [offTag, setOffTag] = React.useState(false);
  const [sortKey, setSortKey] = React.useState<RailSortKey>("attention");
  const lastCheckedRef = React.useRef<string | null>(null);

  // Stable display order (§4 "no resort, don't yank the list"): the order is
  // recomputed ONLY when the filter/sort spec or the visible MEMBERSHIP
  // changes — a value-only update (optimistic post-push rail patch, or the
  // server re-stream after `router.refresh()`) keeps every row where the
  // operator last saw it. Changing the sort Select re-sorts explicitly.
  const orderRef = React.useRef<{ sig: string; ids: string[] } | null>(null);
  const sortSig = `${search.trim().toLowerCase()}|${tier}|${belowTarget}|${tagged}|${offTag}|${sortKey}`;
  const visible = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (tier !== "all" && r.tier !== tier) return false;
      if (belowTarget && !(r.edge < r.targetEdge - 1e-9)) return false;
      if (tagged && r.tag === null) return false;
      if (offTag && !r.offTagLive) return false;
      return true;
    });
    const prev = orderRef.current;
    if (prev && prev.sig === sortSig && prev.ids.length === filtered.length) {
      const byId = new Map(filtered.map((r) => [r.packId, r]));
      if (prev.ids.every((id) => byId.has(id))) {
        return prev.ids.map((id) => byId.get(id)!);
      }
    }
    const sorted = sortRows(filtered, sortKey);
    orderRef.current = { sig: sortSig, ids: sorted.map((r) => r.packId) };
    return sorted;
  }, [rows, search, tier, belowTarget, tagged, offTag, sortKey, sortSig]);

  const visibleIds = React.useMemo(
    () => visible.map((r) => r.packId),
    [visible],
  );
  React.useEffect(() => {
    onVisibleIdsChange(visibleIds);
  }, [visibleIds, onVisibleIdsChange]);

  const allVisibleChecked =
    visible.length > 0 && visible.every((r) => checkedIds.has(r.packId));
  const someVisibleChecked = visible.some((r) => checkedIds.has(r.packId));

  const handleRowCheck = React.useCallback(
    (packId: string, shiftKey: boolean) => {
      const last = lastCheckedRef.current;
      if (shiftKey && last && last !== packId) {
        const a = visibleIds.indexOf(last);
        const b = visibleIds.indexOf(packId);
        if (a !== -1 && b !== -1) {
          const range = visibleIds.slice(Math.min(a, b), Math.max(a, b) + 1);
          onCheck(range, !checkedIds.has(packId));
          lastCheckedRef.current = packId;
          return;
        }
      }
      onCheck([packId], !checkedIds.has(packId));
      lastCheckedRef.current = packId;
    },
    [visibleIds, checkedIds, onCheck],
  );

  const isLg = useIsLg();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  const railBody = (
    <div className="flex min-h-0 flex-col">
      {/* Sticky filter header */}
      <div className="sticky top-0 z-10 space-y-2 border-b bg-card/95 p-2.5 backdrop-blur">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search packs…"
            className="h-8 pl-8 text-sm"
            aria-label="Search packs"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip
            active={belowTarget}
            onClick={() => setBelowTarget((v) => !v)}
          >
            Below target
          </FilterChip>
          <FilterChip active={tagged} onClick={() => setTagged((v) => !v)}>
            Tagged
          </FilterChip>
          <FilterChip active={offTag} onClick={() => setOffTag((v) => !v)}>
            Off-tag
          </FilterChip>
        </div>
        <div className="flex items-center gap-1.5">
          <Select value={tier} onValueChange={(v) => setTier(v ?? "all")}>
            <SelectTrigger size="sm" className="h-7 flex-1 text-xs">
              <SelectValue placeholder="Tier" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tiers</SelectItem>
              {["T1", "T2", "T3", "T4", "T5"].map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={sortKey}
            onValueChange={(v) => setSortKey((v ?? "attention") as RailSortKey)}
          >
            <SelectTrigger size="sm" className="h-7 flex-1 text-xs">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as RailSortKey[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {SORT_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 pt-0.5">
          <Checkbox
            checked={allVisibleChecked}
            indeterminate={!allVisibleChecked && someVisibleChecked}
            onCheckedChange={(checked) =>
              onCheck(visibleIds, checked === true)
            }
            aria-label="Select all filtered packs"
            className="size-3.5"
          />
          <span className="text-[11px] text-muted-foreground">
            {checkedIds.size > 0
              ? `${checkedIds.size} selected`
              : `${visible.length} of ${rows.length} packs`}
          </span>
        </div>
      </div>

      {/* Plain list — 183 memoized rows render fine (no virtualization). */}
      <div role="listbox" aria-label="Packs" className="min-h-0">
        {visible.map((r) => (
          <RailRow
            key={r.packId}
            row={r}
            selected={r.packId === selectedPackId}
            checked={checkedIds.has(r.packId)}
            staged={stagedIds.has(r.packId)}
            pushed={pushedIds.has(r.packId)}
            verdict={verdictByPack.get(r.packId)}
            onSelect={onSelect}
            onCheck={handleRowCheck}
          />
        ))}
        {visible.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No packs match these filters.
          </p>
        )}
      </div>
    </div>
  );

  if (!isLg) {
    return (
      <Collapsible
        open={mobileOpen}
        onOpenChange={setMobileOpen}
        className="rounded-xl border bg-card"
      >
        <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm font-medium">
          <span>Packs ({rows.length})</span>
          <span className="text-xs text-muted-foreground">
            {mobileOpen ? "Hide" : "Show"}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {/* Mount the list only while open — 183 rows are not free on phones. */}
          {mobileOpen && (
            <div className="max-h-[60vh] overflow-y-auto border-t">
              {railBody}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <aside className="sticky top-4 max-h-[calc(100vh-12rem)] overflow-y-auto rounded-xl border bg-card">
      {railBody}
    </aside>
  );
}
