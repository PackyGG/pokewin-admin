"use client";

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Clock3,
  Radio,
  RefreshCw,
  ShieldAlert,
  UserRoundSearch,
  WifiOff,
  X,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { KpiTile } from "@/components/modern-panels";
import { Button } from "@/components/ui/button";
import { useSseStream } from "@/lib/hooks/use-sse";
import { cn } from "@/lib/utils";
import {
  NetworkRiskBadges,
  networkRiskLabels,
} from "../_components/network-risk-badges";
import { RiskScoreBar } from "../_components/risk-score-bar";

/**
 * Live behaviour monitor console.
 *
 * Data flow (deliberate, do not "simplify" back into a poller):
 *   - ONE snapshot fetch on mount paints the initial state.
 *   - Every subsequent change arrives on the SSE stream and is applied from
 *     the frame payload itself. No frame triggers a refetch; the engine
 *     expires a whole batch of sessions in one statement and publishes one
 *     frame per row, so refetching per frame produced dozens of concurrent
 *     snapshot requests and tripped the endpoint's own rate limit.
 *   - There is no timer-based snapshot polling. Manual refresh and a bounded
 *     stream-triggered resync for an unknown case are the only later reads.
 *
 * Two independent health signals are tracked: `streamState` (the live feed,
 * shown in the Connection tile) and `snapshotNotice` (a one-off snapshot
 * failure, shown as a dismissible notice). A slow snapshot must never make a
 * healthy stream look offline.
 */

type StreamState = "connecting" | "live" | "offline" | "unconfigured";

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
  proxycheck_signals: unknown;
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
  proxycheck_signals: unknown;
};

type LiveEvent = {
  id: string;
  type: string;
  at: string;
  severity: string;
  data: Record<string, unknown>;
};

type Snapshot = {
  configured?: boolean;
  error?: string;
  live?: unknown;
  cases?: unknown;
};

const MAX_EVENTS = 60;
const MAX_CASES = 40;
/** No frame at all (not even a heartbeat) for this long = the feed stalled. */
const STALE_STREAM_MS = 45_000;
/** Hard floor between two stream-triggered resyncs. */
const RESYNC_COOLDOWN_MS = 10_000;
const SEVERITY_CLASSES: Record<string, string> = {
  low: "border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300",
  medium: "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-300",
  high: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  critical: "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300",
};

const SEVERITY_DOT: Record<string, string> = {
  low: "bg-slate-500",
  medium: "bg-blue-500",
  high: "bg-amber-500",
  critical: "bg-rose-500",
};

/**
 * Mirrors `SEVERITY_BANDS` in `services/antifraud-monitor/src/score-catalog.ts`
 * (low 0-39, medium 40-79, high 80-119, critical 120+). The publisher only
 * stamps a severity on some frames; deriving it here keeps a score that climbs
 * mid-window from being badged with the severity it had when it started.
 */
const SEVERITY_BANDS: ReadonlyArray<{ key: string; minimum: number }> = [
  { key: "critical", minimum: 120 },
  { key: "high", minimum: 80 },
  { key: "medium", minimum: 40 },
  { key: "low", minimum: 0 },
];

function severityForScore(score: number): string {
  return SEVERITY_BANDS.find((band) => score >= band.minimum)?.key ?? "low";
}

function isSeverity(value: unknown): value is string {
  return typeof value === "string" && value in SEVERITY_CLASSES;
}

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

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSession(value: unknown): MonitorSession | null {
  const row = record(value);
  if (!row || typeof row.session_id !== "string") return null;
  const currentScore = number(row.current_score);
  return {
    session_id: row.session_id,
    case_id: text(row.case_id),
    user_id: text(row.user_id),
    username: typeof row.username === "string" ? row.username : null,
    started_at: text(row.started_at, new Date().toISOString()),
    ends_at: text(row.ends_at, new Date().toISOString()),
    current_score: currentScore,
    peak_score: number(row.peak_score),
    event_count: number(row.event_count),
    severity: isSeverity(row.severity)
      ? row.severity
      : severityForScore(currentScore),
    proxycheck_signals: row.proxycheck_signals,
  };
}

function parseCase(value: unknown): MonitorCase | null {
  const row = record(value);
  if (!row || typeof row.id !== "string") return null;
  const score = number(row.score);
  return {
    id: row.id,
    user_id: text(row.user_id),
    username: typeof row.username === "string" ? row.username : null,
    status: text(row.status, "open"),
    severity: isSeverity(row.severity) ? row.severity : severityForScore(score),
    score,
    peak_score: number(row.peak_score),
    summary: typeof row.summary === "string" ? row.summary : null,
    updated_at: text(row.updated_at, new Date().toISOString()),
    proxycheck_signals: row.proxycheck_signals,
  };
}

function list<T>(value: unknown, parser: (item: unknown) => T | null): T[] {
  return Array.isArray(value)
    ? value.map(parser).filter((item): item is T => item !== null)
    : [];
}

function timeOf(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Merge a snapshot into the live session list instead of replacing it.
 *
 * A snapshot is a picture of the past: it was requested at `requestedAt` and
 * resolved later, so any session the stream opened after that instant is
 * legitimately missing from it and must survive. Everything else the snapshot
 * omits really did end. For rows in both, the side that has seen more events
 * is the fresher one.
 */
function mergeSessions(
  current: MonitorSession[],
  incoming: MonitorSession[],
  requestedAt: number,
): MonitorSession[] {
  const merged = new Map<string, MonitorSession>();
  for (const session of incoming) merged.set(session.session_id, session);

  for (const live of current) {
    const snapshot = merged.get(live.session_id);
    if (!snapshot) {
      // Only keep a locally-known session the snapshot could not have seen.
      if (timeOf(live.started_at) >= requestedAt) merged.set(live.session_id, live);
      continue;
    }
    const fresher = live.event_count >= snapshot.event_count ? live : snapshot;
    merged.set(live.session_id, {
      ...snapshot,
      ...fresher,
      peak_score: Math.max(live.peak_score, snapshot.peak_score),
      username: fresher.username ?? snapshot.username ?? live.username,
    });
  }

  return [...merged.values()].sort(
    (a, b) => timeOf(b.started_at) - timeOf(a.started_at),
  );
}

/** Merge by id, preferring whichever row carries the newer `updated_at`. */
function mergeCases(
  current: MonitorCase[],
  incoming: MonitorCase[],
): MonitorCase[] {
  const merged = new Map<string, MonitorCase>();
  for (const item of incoming) merged.set(item.id, item);
  for (const local of current) {
    const snapshot = merged.get(local.id);
    if (!snapshot) {
      merged.set(local.id, local);
      continue;
    }
    merged.set(
      local.id,
      timeOf(local.updated_at) > timeOf(snapshot.updated_at)
        ? { ...snapshot, ...local }
        : snapshot,
    );
  }
  return [...merged.values()]
    .sort((a, b) => timeOf(b.updated_at) - timeOf(a.updated_at))
    .slice(0, MAX_CASES);
}

/**
 * Case status implied by a decision, mirroring the mapping in the monitor
 * service (`POST /v1/cases/:id/decision`): `resolved_*` → resolved,
 * `escalated` → escalated, anything else → in_review. Only used when the
 * frame does not carry the status itself.
 */
function statusForDecision(decision: string): string | null {
  if (!decision) return null;
  if (decision.startsWith("resolved_")) return "resolved";
  if (decision === "escalated") return "escalated";
  if (decision === "in_review") return "in_review";
  return null;
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

function caseHref(caseId: string): string {
  return `/antifraud/monitor/cases/${caseId}`;
}

export function MonitorConsole() {
  const [streamState, setStreamState] =
    React.useState<StreamState>("connecting");
  const [streamNotice, setStreamNotice] = React.useState<string | null>(null);
  const [snapshotNotice, setSnapshotNotice] = React.useState<string | null>(
    null,
  );
  const [sessions, setSessions] = React.useState<MonitorSession[]>([]);
  const [cases, setCases] = React.useState<MonitorCase[]>([]);
  const [events, setEvents] = React.useState<LiveEvent[]>([]);
  const [refreshing, setRefreshing] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());

  // Monotonic request token: only the newest snapshot is allowed to write
  // state, so a slow response can never overwrite fresher stream updates.
  const snapshotToken = React.useRef(0);
  const snapshotAbort = React.useRef<AbortController | null>(null);
  const lastResyncAt = React.useRef(0);
  const resyncTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFrameAt = React.useRef(Date.now());
  const seenFrameIds = React.useRef(new Set<string>());
  const completedSessions = React.useRef(new Map<string, number>());
  // Read-only mirrors so frame handling can LOOK UP a row without doing it
  // inside a state updater (updaters must stay pure — React may run them
  // twice, and their result is not available synchronously).
  const sessionsRef = React.useRef<MonitorSession[]>([]);
  const casesRef = React.useRef<MonitorCase[]>([]);

  const loadSnapshot = React.useCallback(async (manual = false) => {
    const token = ++snapshotToken.current;
    snapshotAbort.current?.abort();
    const controller = new AbortController();
    snapshotAbort.current = controller;
    const requestedAt = Date.now();
    if (manual) setRefreshing(true);

    try {
      const response = await fetch("/api/antifraud/monitor", {
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = (await response
        .json()
        .catch(() => ({}))) as Snapshot;
      if (token !== snapshotToken.current) return;

      if (payload.configured === false) {
        setStreamState("unconfigured");
        setStreamNotice(
          "Add the monitor API URL and token to enable this page.",
        );
        setSnapshotNotice(null);
        return;
      }
      if (response.status === 429) {
        // Rate limited is NOT an outage — the stream keeps working.
        setSnapshotNotice(
          "Snapshot refresh was rate limited. Live events keep arriving.",
        );
        return;
      }
      if (!response.ok) {
        setSnapshotNotice(
          "The last snapshot refresh failed. Live events keep arriving.",
        );
        return;
      }

      const nextSessions = list(payload.live, parseSession).filter((session) => {
        const completedAt = completedSessions.current.get(session.session_id);
        return !completedAt || timeOf(session.started_at) > completedAt;
      });
      const nextCases = list(payload.cases, parseCase);
      setSessions((current) =>
        mergeSessions(current, nextSessions, requestedAt),
      );
      setCases((current) => mergeCases(current, nextCases));
      setSnapshotNotice(null);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (token !== snapshotToken.current) return;
      setSnapshotNotice(
        "The last snapshot refresh failed. Live events keep arriving.",
      );
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  sessionsRef.current = sessions;
  casesRef.current = cases;

  /** At most one stream-triggered resync per cooldown, never overlapping. */
  const requestResync = React.useCallback(() => {
    if (resyncTimer.current) return;
    const elapsed = Date.now() - lastResyncAt.current;
    const wait = Math.max(0, RESYNC_COOLDOWN_MS - elapsed);
    resyncTimer.current = setTimeout(() => {
      resyncTimer.current = null;
      lastResyncAt.current = Date.now();
      void loadSnapshot();
    }, wait);
  }, [loadSnapshot]);

  // One snapshot on mount for the initial paint. Everything after this comes
  // from the stream.
  React.useEffect(() => {
    void loadSnapshot();
    return () => {
      snapshotAbort.current?.abort();
      if (resyncTimer.current) clearTimeout(resyncTimer.current);
    };
  }, [loadSnapshot]);

  // Clock for the countdown bars, plus stall detection: the route heartbeats a
  // transport frame every 15s, so silence means the stream is gone even though
  // the browser has not surfaced an error yet.
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      const stamp = Date.now();
      setNow(stamp);
      if (stamp - lastFrameAt.current > STALE_STREAM_MS) {
        setStreamState((current) =>
          current === "live" ? "connecting" : current,
        );
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const applyFrame = React.useCallback(
    (raw: unknown) => {
      const frame = record(raw);
      if (!frame || typeof frame.type !== "string") return;
      const frameType: string = frame.type;
      const data = record(frame.data) ?? {};
      const at = text(frame.at, new Date().toISOString());
      lastFrameAt.current = Date.now();

      if (frameType === "transport") {
        const state = text(data.state);
        const message =
          typeof data.message === "string" ? data.message : null;
        const terminal = data.terminal === true;

        if (state === "unconfigured") {
          setStreamState("unconfigured");
          setStreamNotice(message ?? "Monitor service is not configured.");
        } else if (terminal) {
          setStreamState("offline");
          setStreamNotice(
            message
              ? `${message} Retrying automatically.`
              : "Offline — retrying automatically.",
          );
        } else if (state === "open") {
          setStreamState("live");
          setStreamNotice(null);
        } else if (state === "connecting") {
          setStreamState("connecting");
          setStreamNotice(message);
        } else {
          setStreamState("offline");
          setStreamNotice(message ?? "Live stream interrupted.");
        }

        return;
      }
      if (frameType === "connected") return;
      const frameId = text(frame.id);
      if (!frameId) {
        setStreamNotice(
          "The monitor service sent an event without a replay id.",
        );
        return;
      }
      if (seenFrameIds.current.has(frameId)) return;
      seenFrameIds.current.add(frameId);
      if (seenFrameIds.current.size > 1_000) {
        const oldest = seenFrameIds.current.values().next().value;
        if (typeof oldest === "string") seenFrameIds.current.delete(oldest);
      }

      const sessionId = text(data.sessionId);
      const caseId = text(data.caseId);
      const frameScore = optionalNumber(data.score);
      const frameSeverity = isSeverity(data.severity)
        ? data.severity
        : frameScore === null
          ? "medium"
          : severityForScore(frameScore);

      setEvents((current) =>
        [
          {
            id: frameId,
            type: frameType,
            at,
            severity: frameSeverity,
            data,
          },
          ...current,
        ].slice(0, MAX_EVENTS),
      );

      if (frameType === "monitor.started" && sessionId) {
        completedSessions.current.delete(sessionId);
        const started = timeOf(at) || Date.now();
        const durationSeconds = number(data.durationSeconds, 180);
        const initialScore = frameScore ?? 0;
        setSessions((current) => [
          {
            session_id: sessionId,
            case_id: caseId,
            user_id: text(data.userId),
            username:
              typeof data.username === "string" ? data.username : null,
            started_at: new Date(started).toISOString(),
            ends_at: new Date(started + durationSeconds * 1_000).toISOString(),
            current_score: initialScore,
            peak_score: initialScore,
            event_count: 0,
            severity: frameSeverity,
            proxycheck_signals: data.signals,
          },
          ...current.filter((session) => session.session_id !== sessionId),
        ]);
        return;
      }

      if (
        (frameType === "monitor.event" || frameType === "rule.matched") &&
        sessionId
      ) {
        setSessions((current) =>
          current.map((session) => {
            if (session.session_id !== sessionId) return session;
            const score = frameScore ?? session.current_score;
            return {
              ...session,
              current_score: score,
              peak_score: Math.max(session.peak_score, score),
              // The score moved, so the badge has to move with it.
              severity: isSeverity(data.severity)
                ? data.severity
                : severityForScore(score),
              event_count:
                frameType === "monitor.event"
                  ? session.event_count + 1
                  : session.event_count,
            };
          }),
        );
        return;
      }

      if (frameType === "monitor.completed" && sessionId) {
        // Apply the frame instead of refetching: the engine expires a whole
        // batch in one statement and publishes one frame per row.
        completedSessions.current.set(
          sessionId,
          timeOf(at) || Date.now(),
        );
        if (completedSessions.current.size > 1_000) {
          const oldest = completedSessions.current.keys().next().value;
          if (oldest) completedSessions.current.delete(oldest);
        }
        const finished = sessionsRef.current.find(
          (session) => session.session_id === sessionId,
        );
        setSessions((current) =>
          current.filter((session) => session.session_id !== sessionId),
        );

        const completedCaseId = caseId || finished?.case_id || "";
        if (!completedCaseId) return;
        setCases((current) => {
          const existing = current.find((item) => item.id === completedCaseId);
          const finalScore =
            frameScore ??
            existing?.score ??
            finished?.current_score ??
            0;
          const finalSeverity = isSeverity(data.severity)
            ? data.severity
            : severityForScore(finalScore);
          const merged: MonitorCase = {
            id: completedCaseId,
            user_id:
              text(data.userId) || existing?.user_id || finished?.user_id || "",
            username:
              typeof data.username === "string"
                ? data.username
                : (existing?.username ?? finished?.username ?? null),
            // The service reopens the case for review when the window ends.
            status: text(data.status) || "open",
            severity: finalSeverity,
            score: finalScore,
            peak_score: Math.max(
              finalScore,
              existing?.peak_score ?? 0,
              finished?.peak_score ?? 0,
            ),
            summary:
              typeof data.summary === "string"
                ? data.summary
                : (existing?.summary ?? null),
            updated_at: at,
            proxycheck_signals:
              existing?.proxycheck_signals
              ?? finished?.proxycheck_signals
              ?? [],
          };
          return mergeCases(
            current.filter((item) => item.id !== completedCaseId),
            [merged],
          );
        });
        return;
      }

      if (frameType === "case.decided" && caseId) {
        const decision = text(data.decision);
        const status = text(data.status) || statusForDecision(decision);
        const known = casesRef.current.some((item) => item.id === caseId);
        // Only a decision on a case we do not hold needs a round trip, and even
        // then at most once per cooldown.
        if (!known) {
          requestResync();
          return;
        }
        setCases((current) =>
          mergeCases(
            current.map((item) =>
              item.id === caseId
                ? {
                    ...item,
                    // A missing field must degrade to the current value, never
                    // blank the row out.
                    status: status ?? item.status,
                    severity: isSeverity(data.severity)
                      ? data.severity
                      : item.severity,
                    score:
                      frameScore ?? item.score,
                    summary:
                      typeof data.summary === "string"
                        ? data.summary
                        : item.summary,
                    updated_at: at,
                  }
                : item,
            ),
            [],
          ),
        );
      }
    },
    [requestResync],
  );

  useSseStream<unknown>(
    "/api/antifraud/monitor/stream",
    {
      // The route never emits `init`; the mount snapshot is the initial paint.
      onInit: () => {},
      onRow: applyFrame,
      onReconnect: () => {
        lastFrameAt.current = Date.now();
        setStreamState((current) =>
          current === "unconfigured" ? current : "connecting",
        );
      },
      onGiveUp: () => {
        setStreamState((current) =>
          current === "unconfigured" ? current : "offline",
        );
        setStreamNotice((current) =>
          current ?? "Offline — automatic reconnect paused. Reload to retry.",
        );
      },
    },
    { resumeParam: "after" },
  );

  const highestScore = sessions.reduce(
    (highest, session) => Math.max(highest, session.current_score),
    0,
  );
  const highRisk = sessions.filter(
    (session) =>
      session.severity === "high" || session.severity === "critical",
  ).length;
  const connectionLabel =
    streamState === "live"
      ? "Live"
      : streamState === "connecting"
        ? "Connecting"
        : streamState === "unconfigured"
          ? "Not set"
          : "Offline";

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div role="status" aria-live="polite">
          <KpiTile
            label="Connection"
            value={connectionLabel}
            sub="Authenticated event stream"
            icon={streamState === "live" ? Radio : WifiOff}
            accent={streamState === "live" ? "emerald" : "rose"}
          />
        </div>
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

      {streamNotice && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{streamNotice}</span>
        </div>
      )}

      {snapshotNotice && (
        <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="flex-1">{snapshotNotice}</span>
          <button
            type="button"
            onClick={() => setSnapshotNotice(null)}
            className="shrink-0 rounded-sm p-0.5 hover:bg-muted"
            aria-label="Dismiss snapshot notice"
          >
            <X className="size-3.5" aria-hidden />
          </button>
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
                aria-hidden
              />
              Refresh
            </Button>
          </div>

          {sessions.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-2 px-4 text-center">
              <UserRoundSearch className="size-6 text-muted-foreground" aria-hidden />
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
                const player = session.username
                  ? `@${session.username}`
                  : session.user_id;
                const body = (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-semibold">
                            {player}
                          </span>
                          <span className={severityBadge(session.severity)}>
                            {session.severity}
                          </span>
                          <NetworkRiskBadges
                            signals={session.proxycheck_signals}
                          />
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {session.user_id} · {session.event_count} actions
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <div className="text-right">
                          <p className="text-xl font-bold tabular-nums">
                            {session.current_score}
                          </p>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            risk score
                          </p>
                        </div>
                        {session.case_id && (
                          <ChevronRight
                            className="size-4 text-muted-foreground"
                            aria-hidden
                          />
                        )}
                      </div>
                    </div>
                    <div className="mt-2.5 flex items-center gap-2">
                      <Clock3
                        className="size-3 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
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
                    <div className="mt-2.5">
                      <RiskScoreBar score={session.current_score} />
                    </div>
                  </>
                );
                return (
                  <li key={session.session_id}>
                    {session.case_id ? (
                      <HostLink
                        href={caseHref(session.case_id)}
                        aria-label={`Open monitor case for ${player}, ${session.severity} severity, score ${session.current_score}`}
                        className="block px-3 py-3 hover:bg-muted/40 sm:px-4"
                      >
                        {body}
                      </HostLink>
                    ) : (
                      <div className="px-3 py-3 sm:px-4">{body}</div>
                    )}
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
                <Radio className="size-6 text-muted-foreground" aria-hidden />
                <p className="text-sm font-semibold">Waiting for events</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  New monitor events will appear here without refreshing.
                </p>
              </div>
            ) : (
              <ul
                role="log"
                aria-live="polite"
                aria-relevant="additions"
                aria-label="Live monitor activity"
                className="divide-y divide-border/60"
              >
                {events.map((event) => {
                  const label = eventLabel(event);
                  return (
                    <li key={event.id} className="flex gap-2.5 px-3 py-3 sm:px-4">
                      <span
                        className={cn(
                          "mt-1.5 size-1.5 shrink-0 rounded-full",
                          SEVERITY_DOT[event.severity] ?? SEVERITY_DOT.medium,
                        )}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold">
                          <span className="sr-only">
                            {event.severity} severity —{" "}
                          </span>
                          {label.title}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {label.detail}
                        </span>
                        {networkRiskLabels(event.data.signals).length > 0 && (
                          <span className="mt-1 flex flex-wrap gap-1">
                            <NetworkRiskBadges signals={event.data.signals} />
                          </span>
                        )}
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
            {cases.slice(0, 20).map((item) => {
              const player = item.username ? `@${item.username}` : item.user_id;
              return (
                <li key={item.id}>
                  <HostLink
                    href={caseHref(item.id)}
                    aria-label={`Open monitor case for ${player}, ${item.severity} severity, status ${item.status}, score ${item.score}`}
                    className="flex flex-col gap-2 px-3 py-3 hover:bg-muted/40 sm:flex-row sm:items-center sm:gap-4 sm:px-4"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-semibold">
                          {player}
                        </span>
                        <span className={severityBadge(item.severity)}>
                          {item.severity}
                        </span>
                        <NetworkRiskBadges signals={item.proxycheck_signals} />
                        <span className="rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                          {item.status}
                        </span>
                      </span>
                      <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                        {item.summary ?? "Behavior monitor case"}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center justify-between gap-5 sm:justify-end">
                      <RiskScoreBar score={item.score} />
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
                      <ChevronRight
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    </span>
                  </HostLink>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
