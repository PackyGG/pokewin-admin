"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import Link from "next/link";
import { ArrowUpDown, LayoutGrid, List, Scale, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { formatCompareParam } from "../../compare/_lib/compare-params";
import { useRosterSelection } from "./roster-selection-context";

import {
  RosterSortMode,
  ROSTER_SORT_LABELS,
  ROSTER_SORT_ORDER,
  type RosterSortMode as SortMode,
} from "../_lib/roster-params";
import { useRosterSearch } from "./roster-search-context";
import { useRosterView } from "./roster-view-context";

/**
 * Creator Hub roster toolbar — instant search + sort dropdown + grid/list
 * toggle, on one responsive row.
 *
 *   • Search  — instant client-side filter over the already-fetched rows
 *               (RosterSearchProvider). Never refetches.
 *   • Sort    — drives `?sortBy=`; a new sort restarts at page 1 and is a
 *               `router.replace` (no history spam) inside a transition.
 *   • View    — grid / list, pure client presentation (RosterViewProvider).
 *
 * Client-safe: imports only UI primitives + the client-safe param enum/labels
 * + the two roster contexts — no server query-module value imports.
 */
export function RosterToolbar() {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <RosterSearchInput />
      <div className="flex items-center gap-2">
        <RosterCompareButton />
        <RosterSortControl />
        <RosterViewToggle />
      </div>
    </div>
  );
}

function RosterCompareButton() {
  const { selectedIds, canCompare, clear } = useRosterSelection();

  if (selectedIds.length === 0) return null;

  const href = `/creator-hub/compare?compare=${formatCompareParam(selectedIds)}`;
  const label = (
    <>
      <Scale className="size-3.5" />
      Compare ({selectedIds.length})
    </>
  );

  if (canCompare) {
    return (
      <Link
        href={href}
        onClick={() => clear()}
        className={buttonVariants({
          variant: "default",
          size: "sm",
          className: "h-9 gap-1.5 text-xs",
        })}
        title="Compare selected creators"
      >
        {label}
      </Link>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-9 gap-1.5 text-xs"
      disabled
      title="Select at least 2 creators to compare"
    >
      {label}
    </Button>
  );
}

function RosterSearchInput() {
  const { query, setQuery } = useRosterSearch();
  return (
    <div className="relative w-full sm:max-w-xs">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by username, email, or code..."
        className="h-9 pl-9"
        aria-label="Search creators"
      />
    </div>
  );
}

function RosterSortControl() {
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
      <SelectTrigger className="h-9 w-[170px] text-xs" aria-label="Sort creators">
        <ArrowUpDown className="size-3.5 text-muted-foreground" />
        <SelectValue>{ROSTER_SORT_LABELS[current]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ROSTER_SORT_ORDER.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {ROSTER_SORT_LABELS[mode]}
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
