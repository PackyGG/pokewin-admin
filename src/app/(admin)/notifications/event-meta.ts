import { ArrowDownToLine, ArrowUpFromLine, UserPlus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { NotificationEvent } from "@/lib/queries/notifications";
import type { AccentColor } from "@/components/modern-panels";

/**
 * Shared metadata for each notification event type. Lives in its own
 * module (no "use client" directive) so both the Server Component page
 * and the Client form can import the helpers without tripping Next.js's
 * client-reference machinery — exports from a `"use client"` file are
 * treated as client references on the server, which crashes at runtime
 * when the server tries to call one of them.
 */

type EventMeta = {
  label: string;
  description: string;
  icon: LucideIcon;
  accent: AccentColor;
};

export const EVENT_META: Record<NotificationEvent, EventMeta> = {
  deposit: {
    label: "Deposits",
    description: "Notify when a user completes a deposit.",
    icon: ArrowDownToLine,
    accent: "emerald",
  },
  withdrawal: {
    label: "Withdrawals",
    description: "Notify when a new withdrawal is requested.",
    icon: ArrowUpFromLine,
    accent: "rose",
  },
  signup: {
    label: "Signups",
    description: "Notify when a new user registers.",
    icon: UserPlus,
    accent: "blue",
  },
};

export function getEventIcon(event: NotificationEvent): LucideIcon {
  return EVENT_META[event].icon;
}

export function getEventAccent(event: NotificationEvent): AccentColor {
  return EVENT_META[event].accent;
}

export function getEventLabel(event: NotificationEvent): string {
  return EVENT_META[event].label;
}

export function getEventDescription(event: NotificationEvent): string {
  return EVENT_META[event].description;
}
