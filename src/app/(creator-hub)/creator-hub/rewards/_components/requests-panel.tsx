"use client";

import { useMemo, useState } from "react";
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

const ALL_PROGRAMS = "__all__";

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

  const filtered = query.trim() !== "" || programId !== ALL_PROGRAMS;
  const pending = matching.filter((c) => c.status === "pending");
  const reviewed = matching.filter((c) => c.status !== "pending");

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
              className="h-9 w-[220px] text-xs"
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
        <SectionHeading
          icon={Inbox}
          title="Awaiting review"
          action={<WebhookTestButton />}
        />
        {pending.length === 0 ? (
          <HubEmptyState
            icon={BadgeCheck}
            title={filtered ? "No matching claims" : "Nothing waiting"}
            sub={emptySub}
          />
        ) : (
          <div className="space-y-2">
            {pending.map((c) => (
              <ClaimRow key={c.id} claim={c} userHrefBase={userHrefBase} />
            ))}
          </div>
        )}
      </div>

      {reviewed.length > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={ShieldQuestion} title="Reviewed" />
          <div className="space-y-2">
            {reviewed.map((c) => (
              <ClaimRow key={c.id} claim={c} userHrefBase={userHrefBase} />
            ))}
          </div>
        </div>
      )}

      {/* Capped-list honesty: exactly hitting the fetch limit means older
          claims exist but were cut off — say so rather than letting the list
          read as the complete history. */}
      {claimsCap != null && claims.length === claimsCap && (
        <p className="text-xs text-muted-foreground">
          Showing the {claimsCap} most recent claims — older ones aren&apos;t
          listed here.
        </p>
      )}
    </div>
  );
}
