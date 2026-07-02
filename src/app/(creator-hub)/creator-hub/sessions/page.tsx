import { Suspense } from "react";
import Link from "next/link";
import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Gift,
  Info,
  Radio,
  Tv,
  Users,
  Wallet,
} from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FadeIn } from "@/components/fade-in";
import { cn } from "@/lib/utils";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { HubKpiBox } from "../_components/hub-kpi-box";
import {
  getAllSessionsPage,
  type AllSessionsOrder,
  type AllSessionsStatusFilter,
} from "./_queries/all-sessions-data";
import { AllSessionsTable } from "./_components/all-sessions-table";

export const metadata = { title: "All Sessions · Creator Hub" };

/**
 * Creator Hub — All Sessions.
 *
 * ONE merged chronological feed of EVERY creator's past + current activated
 * stream sessions, with the same columns + click-through detail as the
 * per-creator Sessions tab plus a leading Creator column. Default order is
 * NEWEST FIRST (desc), with a toggle to oldest first (asc) and a status filter
 * — all URL-driven (no client state), so only the active page/order/status
 * loads (active-timeframe/lazy rule).
 */

const STATUS_OPTIONS: { value: AllSessionsStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "ended", label: "Ended" },
  { value: "converted", label: "Converted" },
];

function normalizeOrder(raw: string | undefined): AllSessionsOrder {
  return raw === "asc" ? "asc" : "desc";
}

function normalizeStatus(raw: string | undefined): AllSessionsStatusFilter {
  if (raw === "active" || raw === "ended" || raw === "converted") return raw;
  return "all";
}

function normalizePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

export default async function CreatorHubAllSessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const sp = await searchParams;
  const order = normalizeOrder(sp.order);
  const status = normalizeStatus(sp.status);
  const page = normalizePage(sp.page);

  const orderLabel = order === "asc" ? "oldest first" : "newest first";

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Tv}
            accent="blue"
            title="All Sessions"
            subtitle={`Every creator's stream sessions, merged · ${orderLabel}`}
          />
          <SessionsToolbar order={order} status={status} />
        </div>
      </PageHero>

      <Suspense
        key={`${order}-${status}-${page}`}
        fallback={<AllSessionsSkeleton />}
      >
        <AllSessionsSection order={order} status={status} page={page} />
      </Suspense>
    </div>
  );
}

async function AllSessionsSection({
  order,
  status,
  page,
}: {
  order: AllSessionsOrder;
  status: AllSessionsStatusFilter;
  page: number;
}) {
  const { data, kind } = await safeQueryOrNull(
    () => getAllSessionsPage({ page, order, status }),
    "creator-hub.all-sessions",
    30_000,
  );

  if (!data) {
    // Truthful band — a hard failure must not masquerade as "slow".
    const timedOut = kind === "timeout";
    return (
      <FadeIn>
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <div>
            <div className="font-medium text-amber-500">
              {timedOut
                ? "Sessions are taking too long to load"
                : "Sessions failed to load"}
            </div>
            <div className="mt-0.5 text-muted-foreground">
              {timedOut
                ? "The merged session feed timed out. Refresh to retry — the backend may be rate-limited right now."
                : "The merged session feed failed to load — the backend may be unreachable. Refresh to retry."}
            </div>
          </div>
        </div>
      </FadeIn>
    );
  }

  const { kpis } = data;

  return (
    <FadeIn className="space-y-6">
      {/* KPI strip — full-set roll-up (house-POV). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <HubKpiBox
          label="Total sessions"
          icon={BarChart3}
          accent="blue"
          value={formatNumber(kpis.totalSessions)}
          sub={`${formatNumber(kpis.creatorsWithSessions)} creator${kpis.creatorsWithSessions === 1 ? "" : "s"}`}
        />
        <HubKpiBox
          label="Live now"
          icon={Radio}
          accent="blue"
          value={formatNumber(kpis.activeSessions)}
          sub={kpis.activeSessions > 0 ? "active sessions" : "none active"}
          live={kpis.activeSessions > 0}
        />
        <HubKpiBox
          label="Fill loaded"
          icon={Wallet}
          accent="rose"
          value={formatCurrency(kpis.loadedUsd)}
          sub="House-provided"
        />
        <HubKpiBox
          label="Converted out"
          icon={Radio}
          accent="rose"
          value={formatCurrency(kpis.convertedUsd)}
          sub="Paid to creators"
        />
        <HubKpiBox
          label="Tips"
          icon={Gift}
          accent="rose"
          value={formatCurrency(kpis.tipsUsd)}
          sub="House-funded"
        />
        <HubKpiBox
          label="Sponsorship"
          icon={Gift}
          accent="rose"
          value={formatCurrency(kpis.sponsorUsd)}
          sub="House-funded"
        />
        <HubKpiBox
          label="Creators"
          icon={Users}
          accent="blue"
          value={formatNumber(kpis.creatorsWithSessions)}
          sub={`of ${formatNumber(data.creatorsScanned)} scanned`}
        />
      </div>

      {/* Honest degrade banners. */}
      {data.partialCreators > 0 && (
        <DegradeBanner>
          {formatNumber(data.partialCreators)} creator
          {data.partialCreators === 1 ? "'s" : "s'"} sessions couldn&apos;t be
          loaded this time (the backend may be rate-limited). Totals may be
          slightly low — refresh to retry.
        </DegradeBanner>
      )}
      {data.truncated && (
        <DegradeBanner>
          This feed is very large — showing the most recent{" "}
          {formatNumber(data.total)} sessions in the merged history. Older
          sessions beyond that cap are not listed.
        </DegradeBanner>
      )}
      {data.metaDegraded && (
        <DegradeBanner>
          VOD links couldn&apos;t be loaded this time (the session list still
          renders). Editing a VOD link will still save.
        </DegradeBanner>
      )}

      {data.total === 0 ? (
        <EmptyState
          status={status}
          backendUnavailable={data.backendUnavailable}
        />
      ) : data.rows.length === 0 ? (
        // Hand-typed / stale page beyond the real last page.
        <OutOfRange order={order} status={status} total={data.total} page={page} />
      ) : (
        <>
          <Card size="sm" className="overflow-hidden p-0">
            <div className="flex items-center justify-between border-b px-4 py-2">
              <p className="text-xs font-medium text-muted-foreground">
                Click a row for full detail · add a Kick VOD link inline
              </p>
              <p className="text-[11px] text-muted-foreground">
                {formatNumber(data.total)} total
              </p>
            </div>
            <AllSessionsTable rows={data.rows} />
          </Card>

          {data.totalPages > 1 && (
            <AllSessionsPager
              page={page}
              totalPages={data.totalPages}
              order={order}
              status={status}
            />
          )}
        </>
      )}
    </FadeIn>
  );
}

// ── Toolbar (URL-driven segmented controls — no client state) ─────────

/**
 * Segmented order + status controls. Each is a row of `<Link>`s that rewrite
 * `?order=` / `?status=` and reset the page (a filter change invalidates the
 * current page index). Pure server-rendered, so nothing preloads.
 */
function SessionsToolbar({
  order,
  status,
}: {
  order: AllSessionsOrder;
  status: AllSessionsStatusFilter;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Order toggle */}
      <div className="inline-flex items-center rounded-lg border bg-card p-0.5">
        <ToolbarLink
          href={buildHref({ order: "asc", status })}
          active={order === "asc"}
          aria-label="Oldest first"
        >
          <ArrowUpNarrowWide className="size-3.5" />
          Oldest
        </ToolbarLink>
        <ToolbarLink
          href={buildHref({ order: "desc", status })}
          active={order === "desc"}
          aria-label="Newest first"
        >
          <ArrowDownNarrowWide className="size-3.5" />
          Newest
        </ToolbarLink>
      </div>

      {/* Status filter */}
      <div className="inline-flex items-center rounded-lg border bg-card p-0.5">
        {STATUS_OPTIONS.map((opt) => (
          <ToolbarLink
            key={opt.value}
            href={buildHref({ order, status: opt.value })}
            active={status === opt.value}
          >
            {opt.label}
          </ToolbarLink>
        ))}
      </div>
    </div>
  );
}

function ToolbarLink({
  href,
  active,
  children,
  ...rest
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
} & React.ComponentProps<typeof Link>) {
  return (
    <Link
      replace
      prefetch={false}
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
      {...rest}
    >
      {children}
    </Link>
  );
}

// ── Pager (mirrors SessionsPager — preserves order + status) ──────────

function AllSessionsPager({
  page,
  totalPages,
  order,
  status,
}: {
  page: number;
  totalPages: number;
  order: AllSessionsOrder;
  status: AllSessionsStatusFilter;
}) {
  const hrefFor = (n: number) => buildHref({ order, status, page: n });
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
          className={linkClass}
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

/**
 * Build the canonical URL for the feed. `order=desc` (newest first) +
 * `status=all` are the defaults and are omitted (clean URL); `page=1` is
 * omitted too.
 */
function buildHref({
  order,
  status,
  page,
}: {
  order: AllSessionsOrder;
  status: AllSessionsStatusFilter;
  page?: number;
}): string {
  const params = new URLSearchParams();
  if (order !== "desc") params.set("order", order);
  if (status !== "all") params.set("status", status);
  if (page != null && page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `?${qs}` : "/creator-hub/sessions";
}

// ── Banners / empty / out-of-range ────────────────────────────────────

function DegradeBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
      <span>{children}</span>
    </div>
  );
}

function EmptyState({
  status,
  backendUnavailable,
}: {
  status: AllSessionsStatusFilter;
  backendUnavailable: boolean;
}) {
  const filtered = status !== "all";
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Tv className="size-4 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold">
          {backendUnavailable
            ? "Couldn't reach the creator backend"
            : filtered
              ? `No ${status} sessions`
              : "No stream sessions yet"}
        </p>
        <p className="max-w-sm text-xs text-muted-foreground">
          {backendUnavailable
            ? "The creator roster couldn't be loaded this time — refresh to retry."
            : filtered
              ? "Try a different status filter, or switch back to All."
              : "Sessions appear here once any creator activates a fill from a deal. Each row shows fill loaded / spent / converted, tips + sponsorship spend, and timing — and lets you attach a Kick VOD link."}
        </p>
      </div>
      {filtered && !backendUnavailable && (
        <Link
          replace
          prefetch={false}
          href="/creator-hub/sessions"
          className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
        >
          Clear filters
        </Link>
      )}
    </div>
  );
}

function OutOfRange({
  order,
  status,
  total,
  page,
}: {
  order: AllSessionsOrder;
  status: AllSessionsStatusFilter;
  total: number;
  page: number;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Info className="size-4 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold">Nothing on page {page}</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          This feed has {formatNumber(total)} session{total === 1 ? "" : "s"} —
          page {page} is out of range.
        </p>
      </div>
      <Link
        replace
        prefetch={false}
        href={buildHref({ order, status })}
        className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
      >
        Back to page 1
      </Link>
    </div>
  );
}

// ── Skeleton (Suspense fallback) ──────────────────────────────────────

function AllSessionsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] rounded-2xl" />
        ))}
      </div>
      <Card size="sm" className="space-y-2 p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </Card>
    </div>
  );
}
