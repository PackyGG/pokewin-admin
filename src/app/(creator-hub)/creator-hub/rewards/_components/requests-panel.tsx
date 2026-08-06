"use client";

import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, Inbox, Search, ShieldQuestion } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionHeading } from "@/components/modern-panels";
import type { CreatorRewardClaimRow } from "@/lib/creator-vip/queries";

import { HubEmptyState } from "../../_components/hub-notice";
import { ClaimRow } from "./claim-row";
import { WebhookTestButton } from "./claim-decision-dialogs";
import { QueuePager } from "./queue-pager";

const ALL_PROGRAMS = "__all__";

/** Claims per page. Enough to work a queue without scrolling for a minute. */
const PAGE_SIZE = 20;

export function RequestsPanel({
  claims,
  userHrefBase,
  claimsCap,
}: {
  claims: CreatorRewardClaimRow[];
  userHrefBase: string;
  claimsCap?: number;
}) {
  const [query, setQuery] = useState("");
  const [programId, setProgramId] = useState<string>(ALL_PROGRAMS);
  const [pendingPage, setPendingPage] = useState(1);
  const [reviewedPage, setReviewedPage] = useState(1);

  /** Distinct programs present in the loaded page, so the filter can't offer
      an option that would match nothing. */
  const programOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const c of claims) byId.set(c.programId, c.programName);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [claims]);

  // Client-side over the already-loaded page — narrowing a queue must not cost
  // a round-trip, and the cap note below still tells the truth about what was
  // fetched.
  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    return claims.filter((c) => {
      if (programId !== ALL_PROGRAMS && c.programId !== programId) return false;
      if (q === "") return true;
      return (
        (c.username ?? "").toLowerCase().includes(q) ||
        c.userId.toLowerCase().includes(q) ||
        c.programName.toLowerCase().includes(q)
      );
    });
  }, [claims, query, programId]);

  // A narrowed set almost never has the page the operator was on, and landing
  // on an empty page after typing reads as "no results".
  useEffect(() => {
    setPendingPage(1);
    setReviewedPage(1);
  }, [query, programId]);

  const filtered = query.trim() !== "" || programId !== ALL_PROGRAMS;
  const pending = matching.filter((c) => c.status === "pending");
  const reviewed = matching.filter((c) => c.status !== "pending");

  const pendingSlice = sliceFor(pending, pendingPage);
  const reviewedSlice = sliceFor(reviewed, reviewedPage);

  function clearFilters() {
    setQuery("");
    setProgramId(ALL_PROGRAMS);
  }

  const emptySub = filtered ? (
    <>
      Nothing matches the current search or program.{" "}
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
    "Claim requests raised from Discord land here for manual approval."
  );

  return (
    <div className="space-y-5">
      {claims.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full min-w-0 sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Player, user ID or program…"
              className="h-9 pl-9"
              aria-label="Search claims"
            />
          </div>
          <Select
            value={programId}
            onValueChange={(v) => setProgramId(v ?? ALL_PROGRAMS)}
          >
            <SelectTrigger
              className="h-9 w-full text-xs sm:w-[220px]"
              aria-label="Filter by program"
            >
              {/* Explicit label — `SelectValue` renders the raw value when it
                  has no children, which would print the `__all__` sentinel. */}
              <SelectValue>
                {programId === ALL_PROGRAMS
                  ? "All programs"
                  : (programOptions.find(([id]) => id === programId)?.[1] ??
                    "All programs")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROGRAMS}>All programs</SelectItem>
              {programOptions.map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-xs tabular-nums text-muted-foreground sm:ml-auto">
            {matching.length} of {claims.length}
          </span>
        </div>
      )}

      <div className="space-y-3">
        <SectionHeading icon={Inbox} title="Awaiting review" />
        {pending.length === 0 ? (
          <HubEmptyState
            icon={BadgeCheck}
            title={filtered ? "No matching claims" : "Nothing waiting"}
            sub={emptySub}
          />
        ) : (
          <>
            <div className="space-y-2">
              {pendingSlice.rows.map((c) => (
                <ClaimRow key={c.id} claim={c} userHrefBase={userHrefBase} />
              ))}
            </div>
            <QueuePager
              page={pendingSlice.page}
              pageCount={pendingSlice.pageCount}
              first={pendingSlice.first}
              last={pendingSlice.last}
              total={pending.length}
              noun="pending claims"
              onPageChange={setPendingPage}
            />
          </>
        )}
      </div>

      {reviewed.length > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={ShieldQuestion} title="Reviewed" />
          <div className="space-y-2">
            {reviewedSlice.rows.map((c) => (
              <ClaimRow key={c.id} claim={c} userHrefBase={userHrefBase} />
            ))}
          </div>
          <QueuePager
            page={reviewedSlice.page}
            pageCount={reviewedSlice.pageCount}
            first={reviewedSlice.first}
            last={reviewedSlice.last}
            total={reviewed.length}
            noun="reviewed claims"
            onPageChange={setReviewedPage}
          />
        </div>
      )}

      {/* Diagnostics footer. "Test bot connection" used to sit as the section
          action on "Awaiting review", where the eye reads it as a queue verb
          alongside Approve/Reject — it is neither, it messages nobody and
          decides nothing. Down here it sits with the other statement about how
          complete this view is. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        {/* Capped-list honesty: exactly hitting the fetch limit means older
            claims exist but were cut off — say so rather than letting the
            paged list read as the complete history. */}
        <p className="text-xs text-muted-foreground">
          {claims.length === 0
            ? "No claims have been raised yet."
            : claimsCap != null && claims.length === claimsCap
              ? `Showing the ${claimsCap} most recent claims — older ones aren't listed here.`
              : `Showing all ${claims.length} claim${claims.length === 1 ? "" : "s"}.`}
        </p>
        <WebhookTestButton />
      </div>
    </div>
  );
}

/** Clamp the page against the current row count and slice it. */
function sliceFor(rows: CreatorRewardClaimRow[], requested: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(Math.max(requested, 1), pageCount);
  const start = (page - 1) * PAGE_SIZE;
  return {
    rows: rows.slice(start, start + PAGE_SIZE),
    page,
    pageCount,
    first: rows.length === 0 ? 0 : start + 1,
    last: Math.min(start + PAGE_SIZE, rows.length),
  };
}
