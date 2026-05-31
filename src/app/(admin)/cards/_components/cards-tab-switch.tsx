"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
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

/**
 * URL-driven per-set tab switcher for /cards. Mirrors the Fill /
 * Multiplier split on /creators — plain `<Link>` (not router.replace)
 * so the active tab survives page reload + ⌘-click into a new tab.
 *
 * Tabs are built server-side from the existing sets in the catalog,
 * with Pokemon + OnePiece pinned to the front (when they exist) and
 * the rest sorted alphabetically. There is no implicit "All" pill —
 * the catalog is always scoped to one of the well-known sets; missing
 * or unknown `?set=` params fall through to Pokemon server-side.
 *
 * Switching tabs drops `search` / `rarity` / `setId` / `minPrice` /
 * `maxPrice` / `page` deliberately — the two pools surface different
 * card vocabularies (Pokemon's "Rare Holo" vs OnePiece's "SR") so
 * carrying a filter across feels broken.
 */
export function CardsTabSwitch({ tabs }: { tabs: CardSetTab[] }) {
  const searchParams = useSearchParams();
  const current = searchParams.get("set") ?? "";

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
            href={`/cards?set=${tab.slug}`}
            active={active}
            label={tab.label}
          />
        );
      })}
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
