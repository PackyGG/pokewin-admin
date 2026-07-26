"use client";

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  Clock3,
  Radio,
  RefreshCw,
  ShieldAlert,
  UserRoundSearch,
  WifiOff,
} from "lucide-react";

import { KpiTile } from "@/components/modern-panels";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Connection = "connecting" | "live" | "offline" | "unconfigured";

type MonitorSession = {
  session_id: string;
  case_id: string;
  user_id: string;
  username: string | null;
  started_at: string;
  ends_at: string;
  current_score: number;
  peak_score: number;
  event_count: number;
  severity: string;
};

type MonitorCase = {
  id: string;
  user_id: string;
  username: string | null;
  status: string;
  severity: string;
  score: number;
  peak_score: number;
  summary: string | null;
  updated_at: string;
};

type LiveEvent = {
  id: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
};

type Snapshot = {
  configured?: boolean;
  error?: string;
  live?: unknown;
  cases?: unknown;
};

const MAX_EVENTS = 60;
const SEVERITY_CLASSES: Record<string, string> = {
  low: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300",
  medium: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-300",
  high: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  critical: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300",
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseSession(value: unknown): MonitorSession | null {
  const row = record(value);
  if (!row || typeof row.session_id !== "string") return null;
  return {
    session_id: row.session_id,
    case_id: text(row.case_id),
    user_id: text(row.user_id),
    username: typeof row.username === "string" ? row.username : null,
    started_at: text(row.started_at, new Date().toISOString()),
    ends_at: text(row.ends_at, new Date().toISOString()),
    current_score: number(row.current_score),
    peak_score: number(row.peak_score),
    event_count: number(row.event_count),
    severity: text(row.severity, "medium"),
  };
}

function parseCase(value: unknown): MonitorCase | null {
  const row = record(value);
  if (!row || typeof row.id !== "string") return null;
  return {
    id: row.id,
    user_id: text(row.user_id),
    username: typeof row.username === "string" ? row.username : null,
    status: text(row.status, "open"),
    severity: text(row.severity, "medium"),
    score: number(row.score),
    peak_score: number(row.peak_score),
    summary: typeof row.summary === "string" ? row.summary : null,
    updated_at: text(row.updated_at, new Date().toISOString()),
  };
}

function list<T>(
  value: unknown,
  parser: (item: unknown) => T | null,
): T[] {
  return Array.isArray(value)
    ? value.map(parser).filter((item): item is T => item !== null)
    : [];
}

function severityBadge(severity: string) {
  return cn(
    "rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
    SEVERITY_CLASSES[severity] ?? SEVERITY_CLASSES.medium,
  );
}

function relativeTime(value: string, now: number): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "now";
  const seconds = Math.round((now - time) / 1_000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3_600)}h ago`;
}

function eventLabel(event: LiveEvent): { title: string; detail: string } {
  const data = event.data;
  const username = text(data.username);
  const player = username ? `@${username}` : text(data.userId, "player");

  switch (event.type) {
    case "signup.assessed":
      return {
        title: `Signup assessed · ${player}`,
        detail: `Initial risk score ${number(data.score)}`,
      };
    case "monitor.started":
      return {
        title: `Monitor started · ${player}`,
        detail: `${number(data.durationSeconds, 180)} second behavior window`,
      };
    case "monitor.event":
      return {
        title: text(data.title, text(data.eventType, "Player action")),
        detail: `${text(data.detail, player)} · ${number(data.scoreDelta) >= 0 ? "+" : ""}${number(data.scoreDelta)} points`,
      };
    case "rule.matched":
      return {
        title: `Flow matched · ${text(data.ruleName, "Configured rule")}`,
        detail: `${number(data.scoreDelta) >= 0 ? "+" : ""}${number(data.scoreDelta)} points · score ${number(data.score)}`,
      };
    case "monitor.completed":
      return {
        title: `Monitor completed · ${player}`,
        detail: `Final risk score ${number(data.score)}`,
      };
    case "case.decided":
      return {
        title: "Case decision recorded",
        detail: text(data.decision, "Updated by staff"),
      };
    case "rule.updated":
      return {
        title: "Monitor flow updated",
        detail: "The scoring configuration changed",
      };
    default:
      return {
        title: event.type.replaceAll(".", " "),
        detail: player,
      };
  }
}

export function MonitorConsole() {
  const [connection, setConnection] =
    React.useState<Connection>("connecting");
  const [sessions, setSessions] = React.useState<MonitorSession[]>([]);
  const [cases, setCases] = React.useState<MonitorCase[]>([]);
  const [events, setEvents] = React.useState<LiveEvent[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());

  const loadSnapshot = React.useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const response = await fetch("/api/antifraud/monitor", {
        cache: "no-store",
      });
      const payload = (await response.json()) as Snapshot;
      if (payload.configured === false) {
        setConnection("unconfigured");
        setError("Add the monitor API URL and token to enable this page.");
      } else if (!response.ok) {
        setConnection("offline");
        setError("The monitor service is currently unavailable.");
      } else {
        setSessions(list(payload.live, parseSession));
        setCases(list(payload.cases, parseCase));
        setError(null);
      }
    } catch {
      setConnection("offline");
      setError("The monitor service is currently unavailable.");
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void loadSnapshot();
    const refresh = window.setInterval(() => void loadSnapshot(), 30_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(refresh);
      window.clearInterval(clock);
    };
  }, [loadSnapshot]);

  React.useEffect(() => {
    const source = new EventSource("/api/antifraud/monitor/stream");
    source.onmessage = (message) => {
      let raw: unknown;
      try {
        raw = JSON.parse(message.data);
      } catch {
        return;
      }
      const frame = record(raw);
      if (!frame || typeof frame.type !== "string") return;
      const data = record(frame.data) ?? {};

      if (frame.type === "transport") {
        const state = text(data.state);
        if (state === "open") {
          setConnection("live");
          setError(null);
        } else if (state === "unconfigured") {
          setConnection("unconfigured");
          setError(text(data.message, "Monitor service is not configured."));
        } else if (state === "connecting") {
          setConnection("connecting");
        } else {
          setConnection("offline");
          setError(text(data.message, "Live stream interrupted."));
        }
        return;
      }
      if (frame.type === "connected") return;

      const event: LiveEvent = {
        id: `${text(frame.at, new Date().toISOString())}-${crypto.randomUUID()}`,
        type: frame.type,
        at: text(frame.at, new Date().toISOString()),
        data,
      };
      setEvents((current) => [event, ...current].slice(0, MAX_EVENTS));

      const sessionId = text(data.sessionId);
      if (frame.type === "monitor.started" && sessionId) {
        const started = Date.now();
        const durationSeconds = number(data.durationSeconds, 180);
        setSessions((current) => [
          {
            session_id: sessionId,
            case_id: text(data.caseId),
            user_id: text(data.userId),
            username:
              typeof data.username === "string" ? data.username : null,
            started_at: new Date(started).toISOString(),
            ends_at: new Date(started + durationSeconds * 1_000).toISOString(),
            current_score: number(data.score),
            peak_score: number(data.score),
            event_count: 0,
            severity: text(data.severity, "medium"),
          },
          ...current.filter((session) => session.session_id !== sessionId),
        ]);
      } else if (
        (frame.type === "monitor.event" || frame.type === "rule.matched") &&
        sessionId
      ) {
        setSessions((current) =>
          current.map((session) =>
            session.session_id === sessionId
              ? {
                  ...session,
                  current_score: number(data.score, session.current_score),
                  peak_score: Math.max(
                    session.peak_score,
                    number(data.score, session.current_score),
                  ),
                  event_count:
                    frame.type === "monitor.event"
                      ? session.event_count + 1
                      : session.event_count,
                }
              : session,
          ),
        );
      } else if (frame.type === "monitor.completed" && sessionId) {
        setSessions((current) =>
          current.filter((session) => session.session_id !== sessionId),
        );
        void loadSnapshot();
      } else if (frame.type === "case.decided") {
        void loadSnapshot();
      }
    };
    source.onerror = () => {
      setConnection((current) =>
        current === "unconfigured" ? current : "connecting",
      );
    };
    return () => source.close();
  }, [loadSnapshot]);

  const highestScore = sessions.reduce(
    (highest, session) => Math.max(highest, session.current_score),
    0,
  );
  const highRisk = sessions.filter(
    (session) =>
      session.severity === "high" || session.severity === "critical",
  ).length;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Connection"
          value={
            connection === "live"
              ? "Live"
              : connection === "connecting"
                ? "Connecting"
                : connection === "unconfigured"
                  ? "Not set"
                  : "Offline"
          }
          sub="Authenticated event stream"
          icon={connection === "live" ? Radio : WifiOff}
          accent={connection === "live" ? "emerald" : "rose"}
        />
        <KpiTile
          label="Monitoring now"
          value={sessions.length.toLocaleString()}
          sub="Active behavior windows"
          icon={UserRoundSearch}
          accent="cyan"
        />
        <KpiTile
          label="High risk"
          value={highRisk.toLocaleString()}
          sub="High or critical sessions"
          icon={ShieldAlert}
          accent="amber"
        />
        <KpiTile
          label="Highest score"
          value={highestScore.toLocaleString()}
          sub="Across active sessions"
          icon={Activity}
          accent={highestScore >= 80 ? "rose" : "blue"}
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
        <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-3 sm:px-4">
            <div>
              <h3 className="text-sm font-semibold">Active sessions</h3>
              <p className="text-[11px] text-muted-foreground">
                Three-minute signup behavior windows
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void loadSnapshot(true)}
              disabled={refreshing}
            >
              <RefreshCw
                className={cn("size-3.5", refreshing && "animate-spin")}
              />
              Refresh
            </Button>
          </div>

          {sessions.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-2 px-4 text-center">
              <UserRoundSearch className="size-6 text-muted-foreground" />
              <p className="text-sm font-semibold">No active monitors</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                A session appears here as soon as a signup crosses the configured
                risk threshold.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {sessions.map((session) => {
                const started = Date.parse(session.started_at);
                const ends = Date.parse(session.ends_at);
                const duration = Math.max(1, ends - started);
                const remainingMs = Math.max(0, ends - now);
                const progress = Math.max(
                  0,
                  Math.min(100, (remainingMs / duration) * 100),
                );
                return (
                  <li key={session.session_id} className="px-3 py-3 sm:px-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-semibold">
                            {session.username
                              ? `@${session.username}`
                              : session.user_id}
                          </span>
                          <span className={severityBadge(session.severity)}>
                            {session.severity}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {session.user_id} · {session.event_count} actions
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xl font-bold tabular-nums">
                          {session.current_score}
                        </p>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          risk score
                        </p>
                      </div>
                    </div>
                    <div className="mt-2.5 flex items-center gap-2">
                      <Clock3 className="size-3 shrink-0 text-muted-foreground" />
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-cyan-500 transition-[width] duration-1000"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <span className="w-12 text-right text-[11px] tabular-nums text-muted-foreground">
                        {Math.ceil(remainingMs / 1_000)}s
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
          <div className="border-b border-border/60 px-3 py-3 sm:px-4">
            <h3 className="text-sm font-semibold">Live activity</h3>
            <p className="text-[11px] text-muted-foreground">
              Signups, player actions and matched flows
            </p>
          </div>
          <div className="max-h-[480px] overflow-y-auto">
            {events.length === 0 ? (
              <div className="flex min-h-72 flex-col items-center justify-center gap-2 px-4 text-center">
                <Radio className="size-6 text-muted-foreground" />
                <p className="text-sm font-semibold">Waiting for events</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  New monitor events will appear here without refreshing.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {events.map((event) => {
                  const label = eventLabel(event);
                  return (
                    <li key={event.id} className="flex gap-2.5 px-3 py-3 sm:px-4">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-cyan-500" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold">
                          {label.title}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {label.detail}
                        </span>
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {relativeTime(event.at, now)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      </div>

      <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
        <div className="border-b border-border/60 px-3 py-3 sm:px-4">
          <h3 className="text-sm font-semibold">Recent monitor cases</h3>
          <p className="text-[11px] text-muted-foreground">
            Stored in the dedicated antifraud database
          </p>
        </div>
        {cases.length === 0 ? (
          <p className="px-4 py-10 text-center text-xs text-muted-foreground">
            No monitor cases have been recorded yet.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {cases.slice(0, 20).map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-4"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-semibold">
                      {item.username ? `@${item.username}` : item.user_id}
                    </span>
                    <span className={severityBadge(item.severity)}>
                      {item.severity}
                    </span>
                    <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                      {item.status}
                    </span>
                  </span>
                  <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                    {item.summary ?? "Behavior monitor case"}
                  </span>
                </span>
                <span className="flex shrink-0 items-center justify-between gap-5 sm:justify-end">
                  <span className="text-right">
                    <span className="block text-lg font-bold tabular-nums">
                      {item.score}
                    </span>
                    <span className="block text-[9px] uppercase tracking-wide text-muted-foreground">
                      score
                    </span>
                  </span>
                  <span className="w-16 text-right text-[10px] text-muted-foreground">
                    {relativeTime(item.updated_at, now)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
