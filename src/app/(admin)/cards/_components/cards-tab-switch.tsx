"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

export type CardSetTab = {
  /** Set UUID — what gets written to `?set=` after slug resolution. */
  id: string;
  /** Human display label (the set's `name` column verbatim). */
  label: string;
  /**
   * Lowercase slug used as a nicer URL alias for the two well-known sets
   * ("pokemon" / "onepiece"). For any other set, `slug === id`. The page
   * server-side accepts either form so a link with `?set=pokemon` and one
   * with `?set=<uuid>` both land on the same tab.
   */
  slug: string;
};

// The Unassigned (set_id IS NULL) backlog is a first-class tab — the most-
// groomed pool, previously only reachable via a hidden SetFilter dropdown.
// `?set=unassigned` is its slug; the page resolves it to a NULL-set filter.
export const UNASSIGNED_TAB_SLUG = "unassigned";

/**
 * URL-driven per-set tab switcher for /cards. Mirrors the Fill /
 * Multiplier split on /creators — plain `<Link>` (not router.replace)
 * so the active tab survives page reload + ⌘-click into a new tab.
 *
 * Tabs are built server-side from the existing sets in the catalog,
 * with Pokemon + OnePiece pinned to the front (when they exist) and
 * the rest sorted alphabetically, plus a first-class "Unassigned"
 * backlog tab (set_id IS NULL) appended at the end. There is no implicit
 * "All" pill — the catalog is always scoped to one set; missing or
 * unknown `?set=` params fall through to Pokemon server-side.
 *
 * Switching tabs PRESERVES the triage filters (`rarity` / `minPrice` /
 * `maxPrice`) and the chosen `view`, but resets `page` and `search` and
 * drops the now-redundant `setId` dropdown sentinel — so a price/rarity
 * filter carries across sets (the discovery's "every set switch resets
 * your triage context" gap) without stranding the operator on a stale
 * page or search term.
 */
export function CardsTabSwitch({ tabs }: { tabs: CardSetTab[] }) {
  const searchParams = useSearchParams();
  const current = searchParams.get("set") ?? "";

  // Carry the triage filters + view across a tab switch.
  function hrefFor(slug: string): string {
    const next = new URLSearchParams();
    next.set("set", slug);
    for (const key of ["rarity", "minPrice", "maxPrice", "view"]) {
      const v = searchParams.get(key);
      if (v) next.set(key, v);
    }
    return `/cards?${next.toString()}`;
  }

  return (
    <div
      role="tablist"
      aria-label="Card set"
      // Allow horizontal scroll on narrow viewports when the catalog grows
      // past two sets — the pill row stays on one line, scrolls otherwise.
      className="inline-flex max-w-full overflow-x-auto rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {tabs.map((tab) => {
        // Tab is active when the URL `?set=` value matches either the
        // set's slug OR its UUID. The slug form is the nicer URL we
        // prefer to emit; both resolve to the same set server-side.
        // When `?set=` is absent the server falls through to Pokemon —
        // mirror that here so the Pokemon pill reads as active by default.
        const active =
          current === tab.slug ||
          current === tab.id ||
          (!current && tab.slug === "pokemon");
        return (
          <TabPill
            key={tab.id}
            href={hrefFor(tab.slug)}
            active={active}
            label={tab.label}
          />
        );
      })}
      <TabPill
        href={hrefFor(UNASSIGNED_TAB_SLUG)}
        active={current === UNASSIGNED_TAB_SLUG}
        label="Unassigned"
        icon={<Inbox className="size-3.5" />}
      />
    </div>
  );
}

function TabPill({
  href,
  active,
  label,
  icon,
}: {
  href: string;
  active: boolean;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      // `replace` so flipping tabs doesn't pollute browser history with
      // every navigation, but reload + ⌘-click still work because it's
      // a real `<Link>` navigation, not transient client state.
      replace
      scroll={false}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </Link>
  );
}
