import Link from "next/link";
import {
  Activity,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Gift,
  Info,
  Radio,
  Wallet,
} from "lucide-react";

import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/fade-in";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import {
  getCreatorSessionsData,
  SESSIONS_PAGE_SIZE,
  type CreatorSessionRow,
} from "../_queries/sessions-data";
import { SessionsTable } from "./sessions-table";

/**
 * Creator Hub — `creators/[id]` **Sessions** tab (owner spec → "New tab:
 * Sessions").
 *
 * Lists the creator's deal/stream sessions — ONE row per session showing every
 * available datum — each row clickable into a centered modal with the full
 * detail. A Kick VOD URL is editable inline + in the modal (persisted in the
 * ADMIN DB via a manager-gated, audit-logged server action). Tip + sponsorship
 * spend are surfaced per session AND summed in the KPI strip.
 *
 * House-POV finance colors:
 *   • Loaded / converted-out / tips + sponsor (house outflow) → rose.
 *   • Per-row spent (wagered fill) stays in the table only → emerald.
 *
 * LAZY (owner-mandated never-preload): this component is the ONLY caller of
 * {@link getCreatorSessionsData}, so the backend session read + the admin-DB
 * VOD/notes read run solely when the Sessions tab is opened. The page mounts it
 * inside a keyed `<Suspense>`; the read is timeout-bounded so a slow backend
 * degrades to a clean message instead of hanging the tab.
 *
 * DBs: the backend session read is READ-ONLY (MAIN/prod untouched); the
 * VOD/notes sidecar lives in the ADMIN DB (writable). No schema migration runs;
 * the read path self-heals a missing substrate table (see the query module).
 */
export async function SessionsTab({
  userId,
  page = 1,
}: {
  userId: string;
  /** 1-based page from `?sessionsPage=` (clamped by the page). The backend
   *  read offsets by `SESSIONS_PAGE_SIZE`; the page's Suspense key includes
   *  this value so paging remounts the boundary with the skeleton. */
  page?: number;
}) {
  const { data } = await safeQueryOrNull(
    () => getCreatorSessionsData(userId, page),
    "creator-hub.creators.sessions",
    20_000,
  );

  if (!data) {
    return (
      <FadeIn className="space-y-5">
        <SessionsHeading />
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <div>
            <div className="font-medium text-amber-500">
              Sessions are taking too long to load
            </div>
            <div className="mt-0.5 text-muted-foreground">
              The session list timed out. Refresh to retry — the rest of the
              page is unaffected.
            </div>
          </div>
        </div>
      </FadeIn>
    );
  }

  if (data.rows.length === 0) {
    // Distinguish "no sessions at all" from a hand-typed / stale page
    // beyond the real last page — the latter gets a clean way back instead
    // of looking like the creator never streamed.
    if (page > 1) {
      return (
        <FadeIn className="space-y-5 sm:space-y-6">
          <SessionsHeading total={data.total} />
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-12 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-muted">
              <Info className="size-4 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-semibold">Nothing on page {page}</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                This creator has {formatNumber(data.total)} session
                {data.total === 1 ? "" : "s"} — page {page} is out of range.
              </p>
            </div>
            <Link
              replace
              prefetch={false}
              href="?tab=sessions"
              className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
            >
              Back to page 1
            </Link>
          </div>
        </FadeIn>
      );
    }
    return (
      <FadeIn className="space-y-5 sm:space-y-6">
        <SessionsHeading />
        <EmptyState />
      </FadeIn>
    );
  }

  const summary = summarize(data.rows);
  const totalPages = Math.max(1, Math.ceil(data.total / SESSIONS_PAGE_SIZE));

  return (
    <FadeIn className="space-y-5 sm:space-y-6">
      <SessionsHeading total={data.total} />

      {/* KPI strip — session counts + lifetime fill economics + the per-spec
          tip + sponsorship spend, all house-POV. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Sessions"
          value={formatNumber(data.total)}
          sub={
            summary.activeCount > 0
              ? `${formatNumber(summary.activeCount)} live now`
              : "All ended"
          }
          icon={BarChart3}
          accent="blue"
        />
        <KpiTile
          label="Fill loaded"
          value={formatCurrency(summary.loadedUsd)}
          sub="House-provided"
          icon={Wallet}
          accent="rose"
        />
        <KpiTile
          label="Converted out"
          value={formatCurrency(summary.convertedUsd)}
          sub="Paid to creator"
          icon={Radio}
          accent="rose"
        />
        <KpiTile
          label="Tips"
          value={formatCurrency(summary.tipsUsd)}
          sub="House-funded"
          icon={Gift}
          accent="rose"
        />
        <KpiTile
          label="Sponsorship"
          value={formatCurrency(summary.sponsorUsd)}
          sub="House-funded"
          icon={Gift}
          accent="rose"
        />
      </div>

      {data.metaDegraded && (
        <div className="flex items-start gap-2 rounded-md border border-dashed border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span>
            VOD links couldn&apos;t be loaded this time (the session list still
            renders). Editing a VOD link will still save.
          </span>
        </div>
      )}

      <Card size="sm" className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            Click a row for full detail · add a Kick VOD link inline
          </p>
          <p className="text-[11px] text-muted-foreground">
            {formatNumber(data.total)} total
          </p>
        </div>
        <SessionsTable rows={data.rows} />
      </Card>

      {/* Server-side pager — URL-driven (`?sessionsPage=`), zero client
          state (no clobber risk): each Link replaces the URL, the page's
          Suspense key includes the page, so navigation remounts the
          boundary with the skeleton and fetches ONLY that page. */}
      {totalPages > 1 && (
        <SessionsPager page={page} totalPages={totalPages} />
      )}
    </FadeIn>
  );
}

/** Prev / Next + "Page X of Y" — `<Link replace prefetch={false}>` like the
 *  tab bar; a disabled edge renders a muted non-link span. */
function SessionsPager({
  page,
  totalPages,
}: {
  page: number;
  totalPages: number;
}) {
  // Page 1 keeps a canonical URL (param cleared) — same convention as the
  // period chips' default value.
  const hrefFor = (n: number) =>
    n <= 1 ? "?tab=sessions" : `?tab=sessions&sessionsPage=${n}`;
  const linkClass =
    "inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted/50";
  const disabledClass =
    "inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium text-muted-foreground/50 cursor-not-allowed";

  return (
    <div className="flex items-center justify-between gap-3">
      {page > 1 ? (
        <Link
          replace
          prefetch={false}
          href={hrefFor(page - 1)}
          className={linkClass}
          aria-label="Previous sessions page"
        >
          <ChevronLeft className="size-3.5" />
          Prev
        </Link>
      ) : (
        <span className={disabledClass} aria-disabled>
          <ChevronLeft className="size-3.5" />
          Prev
        </span>
      )}

      <span className="text-[11px] tabular-nums text-muted-foreground">
        Page {formatNumber(page)} of {formatNumber(totalPages)}
      </span>

      {page < totalPages ? (
        <Link
          replace
          prefetch={false}
          href={hrefFor(page + 1)}
          className={cn(linkClass)}
          aria-label="Next sessions page"
        >
          Next
          <ChevronRight className="size-3.5" />
        </Link>
      ) : (
        <span className={disabledClass} aria-disabled>
          Next
          <ChevronRight className="size-3.5" />
        </span>
      )}
    </div>
  );
}

function SessionsHeading({ total }: { total?: number }) {
  return (
    <SectionHeading
      icon={BarChart3}
      title="Sessions"
      action={
        total != null ? (
          <span className="text-[11px] text-muted-foreground">
            {formatNumber(total)} session{total === 1 ? "" : "s"}
          </span>
        ) : undefined
      }
    />
  );
}

type Summary = {
  activeCount: number;
  loadedUsd: number;
  convertedUsd: number;
  tipsUsd: number;
  sponsorUsd: number;
};

/** Sum the per-session figures across the loaded page (house-POV labels). */
function summarize(rows: CreatorSessionRow[]): Summary {
  const acc: Summary = {
    activeCount: 0,
    loadedUsd: 0,
    convertedUsd: 0,
    tipsUsd: 0,
    sponsorUsd: 0,
  };
  for (const r of rows) {
    if (r.status === "active") acc.activeCount += 1;
    acc.loadedUsd += num(r.fill_loaded_usd);
    acc.convertedUsd += num(r.converted_to_raw_usd);
    acc.tipsUsd += num(r.tips_spent_this_session_usd);
    acc.sponsorUsd += num(r.sponsorship_spent_this_session_usd);
  }
  return acc;
}

function num(v: string | null): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Activity className="size-4 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold">No stream sessions yet</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Sessions appear here once the creator activates a fill from a deal.
          Each row shows fill loaded / spent / converted, tips + sponsorship
          spend, and timing — and lets you attach a Kick VOD link.
        </p>
      </div>
    </div>
  );
}

/** Suspense fallback — matches the heading + KPI strip + table shell. */
export function SessionsTabSkeleton() {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className="h-5 w-40" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
      <Card size="sm" className="space-y-2 p-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </Card>
    </div>
  );
}
