"use client";

import { useEffect, useState } from "react";

import {
  crossAppHrefs,
  hrefFrom,
  resolveAppHost,
  type AppHostConfig,
  type CrossAppHrefs,
} from "@/lib/app-hosts";

/**
 * Client-side view of which dashboard host we're on, and the hrefs that follow
 * from it.
 *
 * WHY A HOOK AND NOT A SERVER PROP: the sidebars are Client Components, and
 * threading the host down would mean editing all four route-group layouts —
 * hotspot files — plus making the root layout read `headers()`, which opts the
 * whole tree out of static rendering for a value only the nav needs. The host
 * is already in `window.location`, so the client can resolve it itself.
 *
 * HYDRATION CONTRACT: the first render (server AND client) returns the plain
 * canonical paths — byte-identical to the single-domain behaviour — and the
 * effect upgrades them afterwards. So there is no mismatch, and on a
 * deployment with no custom domain nothing ever changes. Links are only
 * followed after hydration, so the brief plain-path window is not reachable.
 */

const FALLBACK: CrossAppHrefs = {
  admin: "/dashboard",
  packStudio: "/pack-studio",
  antifraud: "/antifraud",
  creatorHub: "/creator-hub",
};

/** The resolved host config, or null before mount / on an unknown host. */
export function useAppHost(): AppHostConfig | null {
  const [config, setConfig] = useState<AppHostConfig | null>(null);
  useEffect(() => {
    setConfig(resolveAppHost(window.location.host));
  }, []);
  return config;
}

/**
 * Absolute-or-relative hrefs for the sub-app portals. On a segment host the
 * cross-app entries become fully-qualified URLs, because a bare `/dashboard`
 * there would be rewritten into that host's own segment and 404.
 */
export function useCrossAppHrefs(): CrossAppHrefs {
  const config = useAppHost();
  const [hrefs, setHrefs] = useState<CrossAppHrefs>(FALLBACK);
  useEffect(() => {
    setHrefs(config ? crossAppHrefs(config) : FALLBACK);
  }, [config]);
  return hrefs;
}

/**
 * Map a canonical in-app path to the href to use on the current host.
 *
 * On the host that OWNS the path this strips the redundant base segment
 * (`/antifraud/reviews` → `/reviews` on fraud.packydash.com), which is what
 * keeps the visible URL clean AND keeps `usePathname()`-based active-state
 * checks agreeing with the rendered hrefs — the browser URL after a middleware
 * rewrite is the short form, so comparing against the long form would silently
 * break every "is this nav item active?" test.
 */
export function useHostHref(path: string): string {
  const config = useAppHost();
  return config ? hrefFrom(config, path) : path;
}

/** Batch variant of {@link useHostHref} for a whole nav list. */
export function useHostHrefs(paths: readonly string[]): string[] {
  const config = useAppHost();
  return paths.map((path) => (config ? hrefFrom(config, path) : path));
}
