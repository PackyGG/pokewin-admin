"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import type { CreatorSocialStatus } from "@/lib/backend-api";
import { useHostHref } from "@/lib/use-app-host";

const TABS: { key: CreatorSocialStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

const HUB_SOCIALS_REVIEW_PATH = "/creator-hub/socials-review";

export function SocialsQueueTabs({
  current,
}: {
  current: CreatorSocialStatus;
}) {
  // Host-aware: the `/creator-hub` prefix is stripped on the marketing
  // subdomain, keeping status switches a clean soft navigation.
  const reviewHref = useHostHref(HUB_SOCIALS_REVIEW_PATH);
  return (
    <nav className="flex flex-wrap gap-1 rounded-lg border border-pink-500/15 bg-background/40 p-1">
      {TABS.map((tab) => {
        const active = tab.key === current;
        return (
          <Link
            key={tab.key}
            href={`${reviewHref}?status=${tab.key}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
              active
                ? "bg-pink-500/15 text-pink-700 dark:text-pink-300"
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
