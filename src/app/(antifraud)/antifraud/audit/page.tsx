import Link from "next/link";
import { Activity, ArrowRight, LockKeyhole } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  listAntifraudSecurityAuditEvents,
  type AntifraudAuditKind,
  type AntifraudAuditOutcome,
} from "@/lib/antifraud/security-audit";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";
import { EmptyState } from "../_components/list-page";

export const metadata = { title: "Audit Log · Antifraud" };

type SearchParams = {
  action?: string;
  kind?: string;
  outcome?: string;
  correlation?: string;
  before?: string;
};

export default async function AntifraudAuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAntifraudManagerPage();
  const filters = await searchParams;
  const data = await listAntifraudSecurityAuditEvents({
    action: filters.action,
    kind: filters.kind,
    outcome: filters.outcome,
    correlationId: filters.correlation,
    before: filters.before,
  });

  return (
    <div className="space-y-4">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <section className="space-y-3">
        <SectionHeading icon={Activity} title="Immutable Fraud audit" />
        <p className="max-w-3xl text-xs text-muted-foreground">
          Every authorized or denied Fraud page view, search, automated event,
          and protected mutation. The database rejects updates, deletes, and
          truncation.
        </p>
        <div className="flex gap-2 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs text-muted-foreground">
          <LockKeyhole className="mt-0.5 size-4 shrink-0 text-cyan-500" />
          Provider secrets, session values, raw payloads, and direct personal
          fields are redacted or one-way hashed before storage.
        </div>
      </section>

      <AuditFilters filters={filters} />

      {data.events.length === 0 ? (
        <EmptyState text="No audit events match these filters." icon={Activity} />
      ) : (
        <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
          <div className="divide-y divide-border/60">
            {data.events.map((event) => (
              <details key={event.id} className="group p-4">
                <summary className="flex cursor-pointer list-none items-start gap-3">
                  <span
                    className={cn(
                      "mt-1 size-2 shrink-0 rounded-full",
                      event.outcome === "failed" || event.outcome === "denied"
                        ? "bg-rose-500"
                        : event.outcome === "rate_limited"
                          ? "bg-amber-500"
                          : "bg-emerald-500",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-mono text-xs font-semibold">
                        {event.action}
                      </span>
                      <Badge variant="outline">{event.eventKind}</Badge>
                      <Badge variant="secondary">{event.outcome}</Badge>
                    </span>
                    <span className="mt-1 block text-xs tabular-nums text-muted-foreground">
                      {event.actorUsername ?? "system"} ·{" "}
                      {new Date(event.createdAt).toLocaleString()} · correlation{" "}
                      <span className="font-mono">{event.correlationId}</span>
                    </span>
                  </span>
                  <ArrowRight className="mt-1 size-4 text-muted-foreground transition-transform group-open:rotate-90" />
                </summary>
                <div className="mt-4 grid gap-3 border-t border-border/60 pt-4 text-xs md:grid-cols-2">
                  <AuditValue label="Path" value={event.requestPath} />
                  <AuditValue label="Method" value={event.requestMethod} />
                  <AuditValue
                    label="Target"
                    value={
                      event.targetType || event.targetId
                        ? `${event.targetType ?? "target"}:${event.targetId ?? "unknown"}`
                        : null
                    }
                  />
                  <AuditValue label="Reason code" value={event.reasonCode} />
                  <AuditValue label="Roles" value={event.actorRoles.join(", ")} />
                  <AuditValue label="Model" value={event.modelVersion} />
                  {Object.keys(event.metadata).length > 0 && (
                    <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-[11px] md:col-span-2">
                      {JSON.stringify(event.metadata, null, 2)}
                    </pre>
                  )}
                </div>
              </details>
            ))}
          </div>
        </section>
      )}

      {data.nextCursor && (
        <Button variant="outline" render={<Link href={auditHref(filters, data.nextCursor)} />}>
          Older events
          <ArrowRight />
        </Button>
      )}
    </div>
  );
}

function AuditFilters({ filters }: { filters: SearchParams }) {
  return (
    <form className="grid gap-3 rounded-xl border border-border/60 bg-card p-4 md:grid-cols-4">
      <label className="space-y-1.5">
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Action contains
        </span>
        <input
          name="action"
          defaultValue={filters.action}
          maxLength={160}
          className="h-9 w-full rounded-md border border-border/60 bg-background px-3 font-mono text-xs"
        />
      </label>
      <SelectFilter
        label="Kind"
        name="kind"
        value={filters.kind}
        options={["view", "search", "export", "action"] satisfies AntifraudAuditKind[]}
      />
      <SelectFilter
        label="Outcome"
        name="outcome"
        value={filters.outcome}
        options={[
          "allowed",
          "denied",
          "succeeded",
          "failed",
          "rate_limited",
        ] satisfies AntifraudAuditOutcome[]}
      />
      <div className="flex items-end gap-2">
        <Button type="submit" className="flex-1">Filter</Button>
        <Button variant="ghost" render={<Link href="/antifraud/audit" />}>
          Clear
        </Button>
      </div>
    </form>
  );
}

function SelectFilter({
  label,
  name,
  value,
  options,
}: {
  label: string;
  name: string;
  value?: string;
  options: readonly string[];
}) {
  return (
    <label className="space-y-1.5">
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <select
        name={name}
        defaultValue={value ?? ""}
        className="h-9 w-full rounded-md border border-border/60 bg-background px-3 text-xs"
      >
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function AuditValue({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div className="min-w-0">
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="mt-0.5 block break-all font-mono">{value ?? "—"}</span>
    </div>
  );
}

function auditHref(filters: SearchParams, before: string): string {
  const params = new URLSearchParams();
  for (const key of ["action", "kind", "outcome", "correlation"] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  params.set("before", before);
  return `/antifraud/audit?${params.toString()}`;
}
