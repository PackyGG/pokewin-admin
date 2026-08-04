import { BellRing, CheckCircle2, CircleAlert, Hash } from "lucide-react";

import { HostLink } from "@/components/host-link";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { readDiscordConfig } from "../_lib/read-discord-config";
import { EmptyState } from "./shared";

/**
 * DELIVERY TAB — where every enabled alert lands.
 *
 * Unrouted alerts are sorted to the top: an enabled action with no channel is
 * a silent failure (it fires and lands nowhere), so it must not be buried at
 * the bottom of an alphabetical list.
 */
export async function AutomationDelivery() {
  const config = await readDiscordConfig();

  if (!config) {
    return (
      <EmptyState text="Discord routing configuration is unavailable right now." />
    );
  }

  const channelById = new Map(
    config.channels.map((channel) => [channel.id, channel.name]),
  );
  const channelNamesByEvent = new Map<string, string[]>();
  for (const route of config.routes) {
    if (!route.enabled) continue;
    const names = channelNamesByEvent.get(route.eventKey) ?? [];
    names.push(channelById.get(route.channelId) ?? route.channelId);
    channelNamesByEvent.set(route.eventKey, names);
  }

  const enabled = config.events.filter((event) => event.enabled);
  const disabled = config.events.filter((event) => !event.enabled);
  const rows = enabled
    .map((event) => ({
      event,
      channels: channelNamesByEvent.get(event.key) ?? [],
    }))
    // Unrouted first, then by category so related alerts stay together.
    .sort((a, b) => {
      if (a.channels.length !== b.channels.length) {
        return a.channels.length === 0 ? -1 : b.channels.length === 0 ? 1 : 0;
      }
      return a.event.category.localeCompare(b.event.category);
    });
  const unroutedCount = rows.filter((row) => row.channels.length === 0).length;
  const usedChannels = new Set(
    config.routes.filter((route) => route.enabled).map((r) => r.channelId),
  );

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Enabled alerts"
          value={enabled.length.toLocaleString()}
          sub={`${disabled.length} turned off`}
          icon={BellRing}
          accent="cyan"
        />
        <KpiTile
          label="Routed"
          value={(enabled.length - unroutedCount).toLocaleString()}
          sub="Have at least one channel"
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Unrouted"
          value={unroutedCount.toLocaleString()}
          sub={unroutedCount === 0 ? "All actions covered" : "Fire but land nowhere"}
          icon={unroutedCount === 0 ? CheckCircle2 : CircleAlert}
          accent={unroutedCount === 0 ? "emerald" : "amber"}
        />
        <KpiTile
          label="Channels in use"
          value={usedChannels.size.toLocaleString()}
          sub={`${config.channels.length} available`}
          icon={Hash}
          accent="blue"
        />
      </div>

      <section className="space-y-3">
        <SectionHeading
          icon={BellRing}
          title="Alert coverage"
          action={
            <Button
              size="sm"
              variant="outline"
              render={<HostLink href="/antifraud/discord" />}
            >
              Edit routing
            </Button>
          }
        />
        {rows.length === 0 ? (
          <EmptyState text="No alert actions are enabled." />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
            <div className="divide-y divide-border/60">
              {rows.map(({ event, channels }) => (
                <article
                  key={event.key}
                  className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.45fr)_auto] md:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium">{event.label}</h3>
                      <Badge variant="outline" className="h-5 text-[10px]">
                        {event.category}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {event.description}
                    </p>
                    <code className="mt-1 block truncate text-[10px] text-muted-foreground">
                      {event.key}
                    </code>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {channels.length > 0 ? (
                      channels.map((channel) => (
                        <Badge key={channel} variant="secondary">
                          #{channel}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs font-medium text-amber-600 dark:text-amber-400">
                        No channel assigned
                      </span>
                    )}
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      "w-fit md:justify-self-end",
                      channels.length > 0
                        ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
                        : "border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {channels.length > 0 ? "Routed" : "Unrouted"}
                  </Badge>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>

      {disabled.length > 0 && (
        <section className="space-y-3">
          <SectionHeading
            icon={CircleAlert}
            title={
              <>
                Turned off
                <span className="text-xs font-normal text-muted-foreground">
                  these actions never fire, routed or not
                </span>
              </>
            }
          />
          <div className="flex flex-wrap gap-1.5 rounded-xl border border-border/60 bg-card p-4">
            {disabled.map((event) => (
              <Badge
                key={event.key}
                variant="outline"
                className="h-6 text-[11px] text-muted-foreground"
              >
                {event.label}
              </Badge>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
