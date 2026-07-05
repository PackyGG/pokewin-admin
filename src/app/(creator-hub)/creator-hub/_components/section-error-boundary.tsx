"use client";

import * as React from "react";

/**
 * Minimal client-side error boundary for a SINGLE dashboard section.
 *
 * Next.js `<Suspense>` only catches the pending state — it does NOT catch a
 * render throw. Without a boundary of its own, any error thrown while
 * rendering a section (a server child that throws, an unexpected client
 * render error) bubbles to the nearest `error.tsx` — which for the Creator
 * Hub is the GROUP-level boundary that wraps the whole hub, taking the
 * entire dashboard down.
 *
 * Wrapping a section in this boundary contains the blast radius: a throw in
 * the child renders `fallback` (a small degraded card) in place of the
 * section, and the rest of the hub keeps rendering. Server Components can be
 * passed as `children` to this client component (the standard RSC
 * composition), and React error boundaries catch throws in that subtree
 * during render.
 */
export class SectionErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: React.ReactNode; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[creator-hub] section error boundary caught:", error);
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}
