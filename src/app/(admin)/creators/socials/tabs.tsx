"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import type { CreatorSocialStatus } from "@/lib/backend-api";

const TABS: { key: CreatorSocialStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

export function SocialsQueueTabs({
  current,
}: {
  current: CreatorSocialStatus;
}) {
  return (
    <nav className="flex flex-wrap gap-1 rounded-lg border p-1 bg-background/40">
      {TABS.map((tab) => {
        const active = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={`/creators/socials?status=${tab.key}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
