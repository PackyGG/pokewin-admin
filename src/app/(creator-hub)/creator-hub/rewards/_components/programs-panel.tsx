"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, Crown, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/components/modern-panels";
import { cn } from "@/lib/utils";
import type { CreatorRewardProgramWithStats } from "@/lib/creator-vip/types";

import { HubEmptyState } from "../../_components/hub-notice";
import { ProgramFormDialog } from "./program-form-dialog";
import { ProgramRow } from "./program-row";
import { QueuePager } from "./queue-pager";

type StatusFilter = "all" | "live" | "paused";

/**
 * Programs per page. Smaller than the claim queue's 20: a program row is a tall
 * card (avatar, code badges, two lines of terms, stats, controls), so twenty of
 * them is a scroll rather than a page.
 */
const PAGE_SIZE = 10;

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: "All",
  live: "Live",
  paused: "Paused",
};

export function ProgramsPanel({
  programs,
  creatorHrefBase,
}: {
  programs: CreatorRewardProgramWithStats[];
  creatorHrefBase: string;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage] = useState(1);

  const archivedCount = programs.filter((p) => p.archivedAt != null).length;

  /**
   * Client-side over the array the page already streamed — a program list is
   * tens of rows, so narrowing it must never cost a round-trip. An archived
   * program only appears once it is asked for, and a live/paused filter drops
   * it entirely: "paused" describes something you can still turn on.
   */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return programs.filter((p) => {
      const isArchived = p.archivedAt != null;
      if (isArchived && !showArchived) return false;
      if (status !== "all") {
        if (isArchived) return false;
        if (status === "live" && !p.isActive) return false;
        if (status === "paused" && p.isActive) return false;
      }
      if (q === "") return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.creatorUsername ?? "").toLowerCase().includes(q) ||
        p.codes.some((c) => c.toLowerCase().includes(q))
      );
    });
  }, [programs, query, status, showArchived]);

  // A narrowed set almost never has the page the operator was on, and landing
  // on an empty page after typing reads as "no results". Same rule the claim
  // queue follows.
  useEffect(() => {
    setPage(1);
  }, [query, status, showArchived]);

  const filtered = query.trim() !== "" || status !== "all";

  // Clamp against the current count, so a page that emptied out (a program was
  // archived while the operator sat on the last page) falls back instead of
  // rendering nothing.
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 1), pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRows = visible.slice(start, start + PAGE_SIZE);

  function clearFilters() {
    setQuery("");
    setStatus("all");
  }

  return (
    <div className="space-y-3">
      <SectionHeading
        icon={Crown}
        title="VIP wager programs"
        action={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            New program
          </Button>
        }
      />
      <p className="text-sm text-muted-foreground">
        &ldquo;Wager $X under my code, get $Y.&rdquo; Wager is read live from
        the player&apos;s attributed activity; claims are reviewed by staff
        before any balance moves. Only wager booked{" "}
        <strong>after a program is created</strong> counts towards it.
      </p>

      {programs.length === 0 ? (
        <HubEmptyState
          icon={Crown}
          title="No programs yet"
          sub={
            <>
              Create one to let a creator offer wager milestones to their
              referrals.{" "}
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={() => setCreateOpen(true)}
              >
                New program
              </Button>
            </>
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full min-w-0 sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Name, creator or code…"
                className="h-9 pl-9"
                aria-label="Search programs"
              />
            </div>

            <div
              className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/50 p-1"
              role="group"
              aria-label="Filter by status"
            >
              {(Object.keys(STATUS_LABELS) as StatusFilter[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  aria-pressed={status === s}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                    status === s
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {STATUS_LABELS[s]}
                </button>
              ))}
            </div>

            {archivedCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-9"
                aria-pressed={showArchived}
                onClick={() => setShowArchived((v) => !v)}
              >
                <Archive className="size-3.5" />
                {showArchived ? "Hide" : "Show"} archived ({archivedCount})
              </Button>
            )}

            <span className="text-xs tabular-nums text-muted-foreground sm:ml-auto">
              {visible.length} of {programs.length}
            </span>
          </div>

          {visible.length === 0 ? (
            <HubEmptyState
              icon={Crown}
              title="No programs match"
              sub={
                filtered ? (
                  <>
                    Nothing matches the current search or status.{" "}
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={clearFilters}
                    >
                      Clear filters
                    </Button>
                  </>
                ) : (
                  "Every program here is archived — turn the archived toggle on to see them."
                )
              }
            />
          ) : (
            <div className="space-y-2">
              {pageRows.map((p) => (
                <ProgramRow
                  key={p.id}
                  program={p}
                  creatorHrefBase={creatorHrefBase}
                />
              ))}
              <QueuePager
                page={currentPage}
                pageCount={pageCount}
                first={visible.length === 0 ? 0 : start + 1}
                last={Math.min(start + PAGE_SIZE, visible.length)}
                total={visible.length}
                noun="programs"
                onPageChange={setPage}
              />
            </div>
          )}
        </>
      )}

      <ProgramFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
