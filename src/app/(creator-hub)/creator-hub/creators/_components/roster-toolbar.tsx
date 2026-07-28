"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition, type ReactNode } from "react";
import { ArrowUpDown, LayoutGrid, List, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import {
  RosterSortMode,
  ROSTER_SORT_LABELS,
  ROSTER_SORT_ORDER,
  type RosterSortMode as SortMode,
} from "../_lib/roster-params";
import { useRosterSearch } from "./roster-search-context";
import { useRosterView } from "./roster-view-context";
import { AddCreatorDialogV2 } from "./add-creator-dialog-v2";

/**
 * Creator Hub roster toolbar — the ONE controls row:
 *
 *   [tabs] … [period] [search] [sort] [view] [Add Creator]
 *
 * The tab switcher and period chips are composed in by the page as nodes
 * (they carry their own client boundaries); everything wraps gracefully on
 * narrow viewports (tabs on their own line, controls flow underneath).
 *
 *   • Search  — instant client-side filter over the already-fetched rows
 *               (RosterSearchProvider). Never refetches.
 *   • Sort    — drives `?sortBy=`; `router.replace` inside a transition.
 *               Only `wager_desc` is window-scoped, so its label carries the
 *               active window ("Most wager (7d)"); every other sort is
 *               lifetime.
 *   • View    — grid / list (`?view=`), instant client presentation.
 *   • Add     — the Add Creator dialog trigger. Hidden on the Past tab.
 */
export function RosterToolbar({
  tabs,
  period,
  sortWindow,
}: {
  /** The tab switcher node (left-aligned). */
  tabs?: ReactNode;
  /** The period chips node (active tabs only). */
  period?: ReactNode;
  /** Short window label for the window-scoped wager sort, e.g. "7d". */
  sortWindow?: string;
}) {
  const searchParams = useSearchParams();
  const isPast = searchParams.get("tab") === "past";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {tabs}
      <div className="flex w-full min-w-0 flex-wrap items-center gap-2 lg:ml-auto lg:w-auto">
        {period}
        <RosterSearchInput />
        <RosterSortControl sortWindow={sortWindow} />
        <RosterViewToggle />
        {!isPast && <AddCreatorDialogV2 />}
      </div>
    </div>
  );
}

function RosterSearchInput() {
  const { query, setQuery } = useRosterSearch();
  return (
    <div className="relative w-full min-w-0 sm:w-56">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search creators..."
        className="h-9 pl-9"
        aria-label="Search creators"
      />
    </div>
  );
}

/** Label for a sort mode — only `wager_desc` is scoped to the window. */
function sortLabel(mode: SortMode, sortWindow?: string): string {
  if (mode === "wager_desc" && sortWindow) {
    return `${ROSTER_SORT_LABELS[mode]} (${sortWindow})`;
  }
  return ROSTER_SORT_LABELS[mode];
}

function RosterSortControl({ sortWindow }: { sortWindow?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const raw = searchParams.get("sortBy");
  const current: SortMode = RosterSortMode.safeParse(raw).success
    ? (raw as SortMode)
    : "newest";

  function handleChange(next: string | null) {
    const parsed = RosterSortMode.safeParse(next);
    if (!parsed.success) return;
    const params = new URLSearchParams(searchParams.toString());
    // `newest` is the default — drop the param so the URL stays clean.
    if (parsed.data === "newest") params.delete("sortBy");
    else params.set("sortBy", parsed.data);
    params.delete("page");
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  }

  return (
    <Select value={current} onValueChange={handleChange} disabled={isPending}>
      <SelectTrigger className="h-9 w-[180px] text-xs" aria-label="Sort creators">
        <ArrowUpDown className="size-3.5 text-muted-foreground" />
        <SelectValue>{sortLabel(current, sortWindow)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ROSTER_SORT_ORDER.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {sortLabel(mode, sortWindow)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RosterViewToggle() {
  const { view, setView } = useRosterView();
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border bg-muted/50 p-1"
      role="group"
      aria-label="View mode"
    >
      <ViewButton
        active={view === "grid"}
        onClick={() => setView("grid")}
        label="Grid view"
      >
        <LayoutGrid className="size-4" />
      </ViewButton>
      <ViewButton
        active={view === "list"}
        onClick={() => setView("list")}
        label="List view"
      >
        <List className="size-4" />
      </ViewButton>
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
