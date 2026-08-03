"use client";

/**
 * Browser client for the ONE live antifraud wire.
 *
 *     monitor service ──WS──▶ /api/antifraud/monitor/stream ──SSE──▶ browser
 *
 * The SSE route (`src/app/api/antifraud/monitor/stream/route.ts`) owns the
 * ticket handshake, the allow-listed Origin and the service token; the browser
 * only ever sees the forwarded frames. Persisted frames use the service envelope
 *
 *     { id: Redis stream id, type: string, at: ISO-8601, data: { … } }
 *
 * published by `LiveBus.publish()` in `services/antifraud-monitor/src/live.ts`.
 * The event vocabulary below is the exhaustive list of `publish()` call sites in
 * that service (monitor.ts + server.ts) plus the `connected` handshake frame and
 * the `transport` frames our own proxy injects.
 *
 * NOTHING here is trusted: the service is a separate deployment, so every frame
 * is shape-checked. Unlike the parser this replaced, an unrecognised frame is
 * NOT dropped in silence — it surfaces as `unsupported` so the UI can say the
 * dashboard is behind the service instead of showing a green light over a feed
 * that quietly discards everything.
 *
 * EventSource ownership stays in the shared `useSseStream` hook. This module
 * only validates and normalises the service contract.
 */

import { isNonActionableRewardEnrollmentSignal } from "@/lib/antifraud/signal-display";

/** SSE endpoint our proxy exposes. */
export const MONITOR_STREAM_PATH = "/api/antifraud/monitor/stream";

/** Pipe states our proxy reports (never the service itself). */
export type MonitorTransportState =
  | "connecting"
  | "open"
  | "closed"
  | "unconfigured"
  | "error";

/** Every event type the monitor service publishes. */
export const MONITOR_EVENT_TYPES = [
  "signup.assessed",
  "monitor.started",
  "monitor.event",
  "rule.matched",
  "monitor.completed",
  "case.decided",
  "rule.created",
  "rule.updated",
] as const;
export type MonitorEventType = (typeof MONITOR_EVENT_TYPES)[number];

export type MonitorSeverity = "low" | "medium" | "high" | "critical";

/** One normalised activity frame, ready to render. */
export type MonitorActivityEvent = {
  id: string;
  correlationId: string;
  type: MonitorEventType;
  at: string;
  /** `null` when the frame carries neither a severity nor a score. */
  severity: MonitorSeverity | null;
  title: string;
  detail: string;
  userId: string | null;
  username: string | null;
  score: number | null;
  /** Validated object payload retained for the Live Events state reducers. */
  data: Record<string, unknown>;
};

export type MonitorStreamMessage =
  | {
      kind: "transport";
      state: MonitorTransportState;
      message: string | null;
      terminal: boolean;
    }
  | { kind: "activity"; event: MonitorActivityEvent }
  | { kind: "unsupported"; eventType: string };

// ─── Frame parsing ────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function score(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(100, Math.round(parsed)))
    : null;
}

function isTransportState(value: string): value is MonitorTransportState {
  return (
    value === "connecting" ||
    value === "open" ||
    value === "closed" ||
    value === "unconfigured" ||
    value === "error"
  );
}

function isEventType(value: string): value is MonitorEventType {
  return (MONITOR_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Severity from a score, mirroring `SEVERITY_BANDS` in
 * `services/antifraud-monitor/src/score-catalog.ts` (low 0-20, medium 21-49,
 * high 50-69, critical 70-100). Used only when the frame does not state one.
 */
function severityFromScore(value: number): MonitorSeverity {
  if (value >= 70) return "critical";
  if (value >= 50) return "high";
  if (value >= 21) return "medium";
  return "low";
}

function severityOf(data: Record<string, unknown>): MonitorSeverity | null {
  const stated = text(data.severity);
  if (
    stated === "low" ||
    stated === "medium" ||
    stated === "high" ||
    stated === "critical"
  ) {
    return stated;
  }
  const value = score(data.score);
  return value === null ? null : severityFromScore(value);
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

function describe(
  type: MonitorEventType,
  data: Record<string, unknown>,
): { title: string; detail: string } {
  const username = text(data.username);
  const player = username ? `@${username}` : text(data.userId, "player");
  const delta = score(data.scoreDelta);
  const current = score(data.score);

  switch (type) {
    case "signup.assessed":
      return {
        title: `Signup assessed · ${player}`,
        detail: `Initial risk score ${current ?? 0}`,
      };
    case "monitor.started":
      return {
        title: `Monitor started · ${player}`,
        detail: `${score(data.durationSeconds) ?? 180}s behaviour window · score ${current ?? 0}`,
      };
    case "monitor.event":
      return {
        title: text(data.title, text(data.eventType, "Player action")),
        detail: `${text(data.detail, player)}${
          delta === null ? "" : ` · ${signed(delta)} points`
        }`,
      };
    case "rule.matched":
      return {
        title: `Rule matched · ${text(data.ruleName, "Configured rule")}`,
        detail: `${delta === null ? "" : `${signed(delta)} points · `}score ${current ?? 0}`,
      };
    case "monitor.completed":
      return {
        title: `Monitor completed · ${player}`,
        detail: `Final risk score ${current ?? 0}`,
      };
    case "case.decided":
      return {
        title: `Case decision recorded · ${player}`,
        detail: text(data.decision, "Updated by staff"),
      };
    case "rule.created":
      return {
        title: "Monitor flow created",
        detail: "A new scoring configuration is available",
      };
    case "rule.updated":
      return {
        title: "Monitor flow updated",
        detail: "The scoring configuration changed",
      };
  }
}

/**
 * Turn one raw SSE payload into a message. Returns `null` for frames that are
 * known-and-uninteresting (the service's `connected` handshake).
 */
export function parseMonitorFrame(raw: unknown): MonitorStreamMessage | null {
  const frame = record(raw);
  if (!frame || typeof frame.type !== "string") {
    return {
      kind: "transport",
      state: "error",
      message: "The monitor service sent a frame this dashboard cannot read",
      terminal: false,
    };
  }

  const data = record(frame.data) ?? {};
  const at = text(frame.at, new Date().toISOString());

  if (frame.type === "transport") {
    const state = text(data.state);
    return {
      kind: "transport",
      state: isTransportState(state) ? state : "error",
      message: typeof data.message === "string" ? data.message : null,
      terminal: data.terminal === true,
    };
  }

  // Known-and-uninteresting service frames: the handshake, and config-change
  // notifications consumed by the cache-invalidation layer, not the UI.
  if (
    frame.type === "connected" ||
    frame.type === "score_weight.updated" ||
    frame.type.startsWith("fiat_perk.run.")
  ) {
    return null;
  }

  if (!isEventType(frame.type)) {
    return { kind: "unsupported", eventType: frame.type };
  }
  if (
    frame.type === "monitor.event" &&
    isNonActionableRewardEnrollmentSignal(text(data.eventType))
  ) {
    return null;
  }
  if (
    frame.schemaVersion !== 1 ||
    typeof frame.correlationId !== "string" ||
    frame.correlationId.length === 0 ||
    typeof frame.id !== "string" ||
    frame.id.length === 0
  ) {
    return {
      kind: "transport",
      state: "error",
      message: "The monitor service sent an event without a replay id",
      terminal: false,
    };
  }

  const described = describe(frame.type, data);
  return {
    kind: "activity",
    event: {
      id: frame.id,
      correlationId: frame.correlationId,
      type: frame.type,
      at,
      severity: severityOf(data),
      title: described.title,
      detail: described.detail,
      userId: typeof data.userId === "string" ? data.userId : null,
      username: typeof data.username === "string" ? data.username : null,
      score: score(data.score),
      data,
    },
  };
}
