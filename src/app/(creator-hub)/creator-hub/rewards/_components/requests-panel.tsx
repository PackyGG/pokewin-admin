"use client";

import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, Check, Inbox, ShieldQuestion } from "lucide-react";
import type { RowSelectionState } from "@tanstack/react-table";

import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import type { CreatorRewardClaimRow } from "@/lib/creator-vip/queries";

import { HubEmptyState } from "../../_components/hub-notice";
import { ClaimsQueue } from "./claims-queue";
import {
  BulkApproveDialog,
  WebhookTestButton,
} from "./claim-decision-dialogs";

const ALL_PROGRAMS = "__all__";

export function RequestsPanel({
  claims,
  userHrefBase,
  claimsCap,
  query,
  programId,
  onClearFilters,
}: {
  claims: CreatorRewardClaimRow[];
  userHrefBase: string;
  claimsCap?: number;
  query: string;
  programId: string;
  onClearFilters: () => void;
}) {
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [bulkOpen, setBulkOpen] = useState(false);

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

  // Narrowing drops rows out of view, and a selection the operator can no
  // longer see is exactly the way a bulk payment goes somewhere unintended.
  // The pager resets itself (`autoResetPageIndex`); the selection must not
  // outlive the set it was made in.
  useEffect(() => {
    setSelection({});
  }, [query, programId]);

  const filtered = query.trim() !== "" || programId !== ALL_PROGRAMS;
  const pending = useMemo(
    () => matching.filter((c) => c.status === "pending"),
    [matching],
  );
  const reviewed = useMemo(
    () => matching.filter((c) => c.status !== "pending"),
    [matching],
  );

  // Only currently-visible pending rows can be acted on — a stale id would
  // otherwise survive a revalidation that decided the claim elsewhere.
  const selected = useMemo(
    () => pending.filter((c) => selection[c.id]),
    [pending, selection],
  );
  const selectedTotal = selected.reduce((sum, c) => sum + c.amountUsd, 0);

  function clearFilters() {
    onClearFilters();
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
      <div className="space-y-3">
        <SectionHeading icon={Inbox} title="Awaiting review" />

        {/* Bulk bar — only present when something is selected, so the queue
            reads unchanged in the normal single-decision case. The total is
            House-POV rose: every dollar here leaves the house. */}
        {selected.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2">
            <span className="text-sm">
              {selected.length} selected ·{" "}
              <strong className="tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(selectedTotal)}
              </strong>
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelection({})}
              >
                Clear
              </Button>
              <Button size="sm" onClick={() => setBulkOpen(true)}>
                <Check className="size-3.5" />
                Approve selected
              </Button>
            </div>
          </div>
        )}

        {pending.length === 0 ? (
          <HubEmptyState
            icon={BadgeCheck}
            title={filtered ? "No matching claims" : "Nothing waiting"}
            sub={emptySub}
          />
        ) : (
          <ClaimsQueue
            claims={pending}
            userHrefBase={userHrefBase}
            noun="pending claims"
            selectable
            rowSelection={selection}
            onRowSelectionChange={setSelection}
          />
        )}
      </div>

      {reviewed.length > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={ShieldQuestion} title="Reviewed" />
          <ClaimsQueue
            claims={reviewed}
            userHrefBase={userHrefBase}
            noun="reviewed claims"
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

      <BulkApproveDialog
        claims={selected}
        // Stays open on a partial pass even after the paid rows leave the
        // selection — the dialog holds its own frozen batch, and closing it
        // would hide which claims failed and why.
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        onApproved={(ids) =>
          setSelection((prev) => {
            const next = { ...prev };
            for (const id of ids) delete next[id];
            return next;
          })
        }
      />
    </div>
  );
}
