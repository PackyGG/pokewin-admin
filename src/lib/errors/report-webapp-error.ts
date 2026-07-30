"use client";

type WebappErrorSource =
  | "react-boundary"
  | "react-component"
  | "window-error"
  | "unhandled-rejection";

export type WebappErrorReport = {
  source: WebappErrorSource;
  boundary: string;
  error?: unknown;
  digest?: string;
  componentStack?: string | null;
};

const COMPONENT_NAME = /(?:^|\n)\s*at\s+([A-Za-z0-9_.$-]+)/g;

function errorName(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name)) {
    return error.name;
  }
  return "Error";
}

function componentNames(stack: string | null | undefined): string[] {
  if (!stack) return [];
  const names = new Set<string>();
  for (const match of stack.matchAll(COMPONENT_NAME)) {
    const name = match[1];
    if (name) names.add(name.slice(0, 80));
    if (names.size >= 12) break;
  }
  return [...names];
}

/**
 * Sends only bounded diagnostic metadata. Raw messages, stack traces, query
 * text, URLs with query strings, and user data never leave the browser.
 */
export function reportWebappError(input: WebappErrorReport): void {
  if (typeof window === "undefined") return;
  const body = {
    source: input.source,
    boundary: input.boundary.slice(0, 80),
    route: window.location.pathname.slice(0, 300),
    errorName: errorName(input.error),
    ...(input.digest ? { digest: input.digest.slice(0, 128) } : {}),
    componentNames: componentNames(input.componentStack),
  };

  void fetch("/api/antifraud/webapp-errors", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {
    // Error reporting must never create a second user-visible failure.
  });
}

export function registerWebappErrorListeners(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("error", (event) => {
    reportWebappError({
      source: "window-error",
      boundary: "window",
      error: event.error,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportWebappError({
      source: "unhandled-rejection",
      boundary: "window",
      error: event.reason,
    });
  });
}
