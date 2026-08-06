import { Suspense } from "react";
import {
  CalendarClock,
  ScrollText,
  ShieldX,
  UserRoundCog,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { KpiStripSkeleton } from "@/components/loading-skeletons";
import { KpiTile, PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ANTIFRAUD_AUDIT_CATEGORY_LABELS,
  ANTIFRAUD_AUDIT_EVENTS,
  listAntifraudStaffAudit,
  type AntifraudAuditCategory,
  type AntifraudAuditRow,
  type AntifraudAuditTone,
} from "@/lib/antifraud/staff-audit";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { canViewProtectedAuditActivity } from "@/lib/audit-visibility";
import { cn } from "@/lib/utils";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import {
  EmptyState,
  FilterButton,
  FilterGroup,
  ListPagination,
  parsePageParam,
} from "../_components/list-page";
import { ListSearchForm } from "../_components/list-search-form";

export const metadata = { title: "Audit Log · Antifraud" };

/**
 * STAFF AUDIT LOG — who on the team did what in the Fraud workspace.
 *
 * Source: `admin_audit_events` scoped to the workspace's event vocabulary
 * (see `@/lib/antifraud/staff-audit`). Deliberately NOT the security-boundary
 * log: page views, access denials and automated `antifraud-monitor` ingests
 * are system plumbing, not operator decisions, and they drowned out the real
 * staff actions this page exists to answer for.
 */

const CATEGORIES = Object.keys(
  ANTIFRAUD_AUDIT_CATEGORY_LABELS,
) as AntifraudAuditCategory[];

/** Same bound every sibling antifraud route puts on its own page read. */
const QUERY_TIMEOUT_MS = 10_000;

type SearchParams = {
  page?: string;
  category?: string;
  event?: string;
  actor?: string;
  search?: string;
};

type FilterState = {
  page: number;
  category?: AntifraudAuditCategory;
  event?: string;
  actor?: string;
  search: string;
};

function auditHref(state: FilterState): string {
  const params = new URLSearchParams();
  if (state.category) params.set("category", state.category);
  if (state.event) params.set("event", state.event);
  if (state.actor) params.set("actor", state.actor);
  if (state.search) params.set("search", state.search);
  if (state.page > 1) params.set("page", String(state.page));
  const query = params.toString();
  return query ? `/antifraud/audit?${query}` : "/antifraud/audit";
}

export default async function AntifraudAuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireAntifraudManagerPage();
  const params = await searchParams;
  const state: FilterState = {
    page: parsePageParam(params.page),
    category: CATEGORIES.includes(params.category as AntifraudAuditCategory)
      ? (params.category as AntifraudAuditCategory)
      : undefined,
    event:
      params.event && ANTIFRAUD_AUDIT_EVENTS[params.event]
        ? params.event
        : undefined,
    actor: /^[0-9a-f-]{36}$/i.test(params.actor ?? "")
      ? params.actor
      : undefined,
    search: params.search?.trim().slice(0, 100) ?? "",
  };

  return (
    <div className="space-y-4">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <p className="max-w-3xl text-xs text-muted-foreground">
        Every action a staff member took in the Fraud workspace — bans, case
        verdicts, KYC reviews, refund batches, blocklist edits and risk-config
        changes. Automated monitor signals are not staff actions; they live in{" "}
        <HostLink href="/antifraud/events" className="underline">
          Events
        </HostLink>
        .
      </p>

      <Filters state={state} />

      <Suspense key={auditHref(state)} fallback={<Fallback />}>
        <Content
          state={state}
          canViewProtectedActors={canViewProtectedAuditActivity(session)}
        />
      </Suspense>
    </div>
  );
}

async function Content({
  state,
  canViewProtectedActors,
}: {
  state: FilterState;
  canViewProtectedActors: boolean;
}) {
  // Bounded like every sibling antifraud route: this read spans the ADMIN DB
  // and a MAIN-DB hydration, and an unwrapped await here hung the whole
  // segment until the platform killed the request instead of degrading.
  const { data } = await safeQueryOrNull(
    () =>
      listAntifraudStaffAudit({
        page: state.page,
        category: state.category,
        event: state.event,
        actorId: state.actor,
        search: state.search,
        canViewProtectedActors,
      }),
    "antifraud.staff-audit",
    QUERY_TIMEOUT_MS,
  );

  if (!data) {
    return (
      <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center">
        <ShieldX className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="text-sm font-semibold">
          The audit log could not be loaded
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Nothing was changed. Refresh to retry, or narrow the filters.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile
          label="Matching actions"
          value={String(data.total)}
          icon={ScrollText}
          accent="blue"
        />
        <KpiTile
          label="Last 24 hours"
          value={String(data.last24h)}
          icon={CalendarClock}
          accent="amber"
        />
        <KpiTile
          label="Staff active (30d)"
          value={String(data.activeStaff)}
          icon={UserRoundCog}
          accent="purple"
        />
      </div>

      {data.actors.length > 0 && (
        <FilterGroup label="Staff member">
          <FilterButton
            label="Everyone"
            active={!state.actor}
            href={auditHref({ ...state, actor: undefined, page: 1 })}
          />
          {data.actors.map((actor) => (
            <FilterButton
              key={actor.id}
              label={actor.username}
              active={state.actor === actor.id}
              href={auditHref({ ...state, actor: actor.id, page: 1 })}
            />
          ))}
        </FilterGroup>
      )}

      {data.rows.length === 0 ? (
        <EmptyState
          text="No staff actions match these filters."
          icon={ScrollText}
        />
      ) : (
        <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
          <div className="divide-y divide-border/60">
            {data.rows.map((row) => (
              <AuditRow key={row.id} row={row} />
            ))}
          </div>
        </section>
      )}

      <ListPagination
        page={data.page}
        pages={data.pages}
        total={data.total}
        unitLabel="staff actions"
        previousHref={
          data.page > 1
            ? auditHref({ ...state, page: data.page - 1 })
            : undefined
        }
        nextHref={
          data.page < data.pages
            ? auditHref({ ...state, page: data.page + 1 })
            : undefined
        }
      />
    </>
  );
}

const TONE_DOT: Record<AntifraudAuditTone, string> = {
  danger: "bg-rose-500",
  warn: "bg-amber-500",
  good: "bg-emerald-500",
  neutral: "bg-blue-500",
};

/** Bookkeeping keys — the row already shows actor, target and time. */
const HIDDEN_METADATA_KEYS = new Set([
  "idempotencyKey",
  "correlationId",
  "source",
  "issuer_main_user_id",
  "user_ids",
]);

function AuditRow({ row }: { row: AntifraudAuditRow }) {
  const details = Object.entries(row.metadata ?? {}).filter(
    ([key, value]) =>
      !HIDDEN_METADATA_KEYS.has(key) && value !== null && value !== "",
  );
  const reason =
    typeof row.metadata?.reason === "string" && row.metadata.reason.trim()
      ? row.metadata.reason
      : null;

  return (
    <details className="group p-4">
      <summary className="flex cursor-pointer list-none items-start gap-3">
        <span
          className={cn(
            "mt-1.5 size-2 shrink-0 rounded-full",
            TONE_DOT[row.tone],
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{row.label}</span>
            <Badge variant="outline">
              {ANTIFRAUD_AUDIT_CATEGORY_LABELS[row.category]}
            </Badge>
            {row.targetUserId && (
              <Badge variant="secondary" className="font-mono text-[11px]">
                {row.targetUsername ?? row.targetUserId.slice(0, 12)}
              </Badge>
            )}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {row.actorUsername ?? "unattributed"}
            </span>
            {row.actorRole ? ` · ${row.actorRole}` : ""} ·{" "}
            <span className="tabular-nums">
              {formatRelative(row.createdAt)}
            </span>{" "}
            ·{" "}
            <span className="tabular-nums">
              {formatDateTime(row.createdAt)}
            </span>
          </span>
          {reason && (
            <span className="mt-1 block truncate text-xs text-muted-foreground">
              &ldquo;{reason}&rdquo;
            </span>
          )}
        </span>
      </summary>
      <div className="mt-4 grid gap-3 border-t border-border/60 pt-4 text-xs md:grid-cols-2">
        <Fact label="Action" value={row.eventType} />
        <Fact label="Target user" value={row.targetUserId} />
        {details.length === 0 ? (
          <p className="text-muted-foreground md:col-span-2">
            No further details were recorded.
          </p>
        ) : (
          <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-[11px] md:col-span-2">
            {JSON.stringify(Object.fromEntries(details), null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="mt-0.5 block break-all font-mono">{value ?? "—"}</span>
    </div>
  );
}

function Filters({ state }: { state: FilterState }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <FilterGroup label="Area">
          <FilterButton
            label="All"
            active={!state.category && !state.event}
            href={auditHref({
              ...state,
              category: undefined,
              event: undefined,
              page: 1,
            })}
          />
          {CATEGORIES.map((category) => (
            <FilterButton
              key={category}
              label={ANTIFRAUD_AUDIT_CATEGORY_LABELS[category]}
              active={state.category === category && !state.event}
              href={auditHref({
                ...state,
                category,
                event: undefined,
                page: 1,
              })}
            />
          ))}
        </FilterGroup>
        <ListSearchForm
          action="/antifraud/audit"
          placeholder="Target user, username or email"
          ariaLabel="Search audited users"
          defaultValue={state.search}
          carry={{
            category: state.category,
            event: state.event,
            actor: state.actor,
          }}
          submitLabel="Search"
          className="w-full xl:w-auto"
          inputClassName="xl:w-72"
        />
      </div>
    </div>
  );
}

function Fallback() {
  return (
    <>
      <KpiStripSkeleton count={3} />
      {Array.from({ length: 6 }).map((_, index) => (
        <Skeleton key={index} className="h-20 w-full rounded-xl" />
      ))}
    </>
  );
}
