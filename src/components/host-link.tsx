"use client";

import type { ComponentProps } from "react";
import Link from "next/link";

import { useHostHref } from "@/lib/use-app-host";

type HostLinkProps = Omit<ComponentProps<typeof Link>, "href"> & {
  /** Canonical internal path. The owning subdomain prefix is removed. */
  href: string;
};

/**
 * Next Link that maps an internal route to its clean, host-owned public URL.
 * This keeps local/preview single-host routing working while production links
 * go directly to the dedicated subdomain without an obsolete prefix.
 */
export function HostLink({ href, ...props }: HostLinkProps) {
  return <Link href={useHostHref(href)} {...props} />;
}
