"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * One of the two well-known pack pools. `pokemon` is the implicit
 * default — most packs are Pokemon and carry no OnePiece marker, so an
 * absent / unknown `?set=` param falls through to Pokemon both here and
 * server-side in page.tsx.
 */
export type PackSetSlug = "pokemon" | "onepiece";

type PackSetTab = {
  slug: PackSetSlug;
  label: string;
};

// Static two-tab list. Unlike /cards (which builds tabs from every set
// in the catalog) a pack's "type" is binary: it either contains OnePiece
// cards or it doesn't. So the switch is a fixed Pokemon / OnePiece pair.
const PACK_SET_TABS: PackSetTab[] = [
  { slug: "pokemon", label: "Pokemon" },
  { slug: "onepiece", label: "OnePiece" },
];

/**
 * URL-driven Pokemon / OnePiece tab switcher for /packs. Mirrors the
 * per-set switch on /cards (`cards-tab-switch.tsx`) — plain `<Link>`
 * with `replace` (not router state) so the active tab survives a reload
 * and ⌘-click into a new tab.
 *
 * A pack is "OnePiece" when its cards belong to the OnePiece set; every
 * other pack (including ones with no cards yet) is "Pokemon". That
 * classification happens server-side in `getPacks` — this component only
 * reflects/writes the `?set=` param.
 *
 * Switching tabs deliberately drops `search` / `active` / `sortBy` /
 * `sortOrder` / `page`: the two pools are independent catalogs, so
 * carrying a filter across feels broken.
 */
export function PacksTabSwitch() {
  const searchParams = useSearchParams();
  const current = searchParams.get("set") ?? "";

  return (
    <div
      role="tablist"
      aria-label="Pack set"
      className="inline-flex max-w-full overflow-x-auto rounded-lg border border-border/60 bg-muted/30 p-0.5"
    >
      {PACK_SET_TABS.map((tab) => {
        // Pokemon reads as active when the param is absent (the default)
        // or explicitly "pokemon"; OnePiece only on an exact match.
        const active =
          current === tab.slug || (!current && tab.slug === "pokemon");
        return (
          <TabPill
            key={tab.slug}
            href={`/packs?set=${tab.slug}`}
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
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      // `replace` so flipping tabs doesn't pile every navigation onto the
      // history stack, but it's still a real `<Link>` so reload + ⌘-click
      // resolve the tab from the URL rather than transient client state.
      replace
      scroll={false}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
}
