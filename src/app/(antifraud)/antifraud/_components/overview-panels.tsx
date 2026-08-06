"use client";

import * as React from "react";
import { Radio } from "lucide-react";

import { HostLink } from "@/components/host-link";
import { SectionHeading } from "@/components/modern-panels";
import { useSseStream } from "@/lib/hooks/use-sse";
import type { AntifraudActionFeedItem } from "@/lib/antifraud/overview";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
  MONITOR_STREAM_PATH,
  parseMonitorFrame,
} from "./monitor-stream";

/**
 * The live action feed. Recharts deliberately does NOT belong in this module —
 * the two 30-day charts live in `overview-charts.tsx` so this feed can hydrate
 * and open its SSE stream without first downloading and executing the chart
 * bundle. Do not import a chart back in here.
 */

const MAX_FEED_ITEMS = 24;

function feedDot(type: AntifraudActionFeedItem["type"]): string {
  switch (type) {
    case "fiat_deposit":
      return "bg-emerald-500";
    case "banned":
      return "bg-rose-500";
    case "locked":
    case "kyc_requested":
      return "bg-amber-500";
    case "kyc_reviewed":
      return "bg-cyan-500";
    case "high_risk_signup":
      return "bg-orange-500";
    default:
      return "bg-blue-500";
  }
}

export function OverviewActionFeed({
  initialItems,
}: {
  initialItems: AntifraudActionFeedItem[];
}) {
  const [items, setItems] = React.useState(initialItems);
  const [connection, setConnection] = React.useState<
    "connecting" | "live" | "offline"
  >("connecting");

  useSseStream<unknown>(
    MONITOR_STREAM_PATH,
    {
      onInit: () => {},
      onRow: (raw) => {
        const frame = parseMonitorFrame(raw);
        if (!frame) return;
        if (frame.kind === "transport") {
          // "unconfigured"/terminal/error must read as offline, not as a
          // permanent "connecting" that looks like a transient blip.
          setConnection(
            frame.state === "open"
              ? "live"
              : frame.state === "connecting"
                ? "connecting"
                : "offline",
          );
          return;
        }
        if (frame.kind !== "activity") return;
        setConnection("live");
        const event = frame.event;
        const item: AntifraudActionFeedItem = {
          id: `live:${event.id}`,
          type:
            event.type === "signup.assessed"
              ? "high_risk_signup"
              : "signal",
          title: event.title,
          detail: event.detail,
          occurredAt: event.at,
          userId: event.userId,
          href: event.userId
            ? `/antifraud/reviews?search=${encodeURIComponent(event.userId)}`
            : null,
          amountCents: null,
        };
        setItems((current) =>
          current.some((existing) => existing.id === item.id)
            ? current
            : [item, ...current].slice(0, MAX_FEED_ITEMS),
        );
      },
      onReconnect: () => setConnection("connecting"),
      onGiveUp: () => setConnection("offline"),
      onStale: () => setConnection("offline"),
    },
    { resumeParam: "after", staleAfterMs: 45_000 },
  );

  return (
    // Fixed height matching the chart panels (~p-4 + heading + 260px chart)
    // so the feed + charts row reads as one aligned band; the list scrolls
    // internally.
    <section className="flex h-[336px] min-h-0 flex-col rounded-xl border border-border/60 bg-card">
      <div className="border-b border-border/60 px-3 py-3 sm:px-4">
        <SectionHeading
          icon={Radio}
          title="Live action feed"
          action={
            <span
              role="status"
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                connection === "live"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : connection === "offline"
                    ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                    : "border-border bg-muted/50 text-muted-foreground",
              )}
            >
              {connection}
            </span>
          }
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex h-full items-center justify-center px-5 text-center text-xs text-muted-foreground">
            No persisted Fraud activity is available yet. New monitor events
            will appear here live.
          </div>
        ) : (
          <ul
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            className="divide-y divide-border/60"
          >
            {items.map((item) => {
              const body = (
                <>
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      feedDot(item.type),
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold">
                      {item.title}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">
                      {item.detail}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    {item.amountCents !== null && (
                      <span className="block text-xs font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(item.amountCents / 100)}
                      </span>
                    )}
                    <span className="block text-[10px] text-muted-foreground">
                      {formatRelative(item.occurredAt)}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={item.id}>
                  {item.href ? (
                    <HostLink
                      href={item.href}
                      className="flex gap-2.5 px-3 py-3 hover:bg-muted/40 sm:px-4"
                    >
                      {body}
                    </HostLink>
                  ) : (
                    <div className="flex gap-2.5 px-3 py-3 sm:px-4">
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
