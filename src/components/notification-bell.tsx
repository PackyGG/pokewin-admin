"use client";

import * as React from "react";
import { HostLink } from "@/components/host-link";
import { Bell, CheckCheck, Inbox } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/utils/format";
import {
  fetchBellNotifications,
  fetchBellUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  type BellNotification,
} from "./notification-bell-actions";

/**
 * Header notification bell — sits directly to the LEFT of the profile card in
 * `AdminHeader`, so it renders in every shell (main admin, Creator Hub, Pack
 * Studio, Antifraud) from one place.
 *
 * Data comes from the staff notification inbox (`staff_notifications`). An
 * admin who has never entered the staff workspace simply has none, and the bell
 * renders with no badge.
 *
 * POLLING CONTRACT — deliberately cheap:
 *   • one count query on mount,
 *   • one count query every 60s, and ONLY while the tab is visible (the
 *     interval is torn down on `visibilitychange` and re-armed with an
 *     immediate refresh when the tab comes back), and
 *   • one full list read when the dropdown is opened.
 * Both queries are single-table admin-DB reads served by the
 * (admin_user_id, created_at DESC) / partial-unread indexes.
 */

const POLL_MS = 60_000;

export function NotificationBell() {
  const [open, setOpen] = React.useState(false);
  const [unread, setUnread] = React.useState(0);
  const [items, setItems] = React.useState<BellNotification[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  // Guards a stale in-flight response from overwriting newer state after the
  // component unmounts or a faster request lands.
  const requestId = React.useRef(0);

  const refreshCount = React.useCallback(async () => {
    try {
      const next = await fetchBellUnreadCount();
      setUnread(next);
    } catch {
      // A blip must never surface as an error toast in the chrome.
    }
  }, []);

  const refreshList = React.useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const snapshot = await fetchBellNotifications();
      if (id !== requestId.current) return;
      setUnread(snapshot.unread);
      setItems(snapshot.items);
    } catch {
      if (id === requestId.current) setItems([]);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  // Mount + visible-tab polling.
  React.useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const arm = () => {
      if (timer) return;
      timer = setInterval(refreshCount, POLL_MS);
    };
    const disarm = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refreshCount();
        arm();
      } else {
        disarm();
      }
    };

    void refreshCount();
    if (document.visibilityState === "visible") arm();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disarm();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshCount]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) void refreshList();
  }

  async function handleItemClick(item: BellNotification) {
    if (item.read) return;
    // Optimistic — the row is already in the user's own inbox, so the only
    // failure mode is a stale badge, which the next poll corrects.
    setItems((prev) =>
      prev
        ? prev.map((n) => (n.id === item.id ? { ...n, read: true } : n))
        : prev,
    );
    setUnread((prev) => Math.max(0, prev - 1));
    try {
      await markNotificationRead(item.id);
    } catch {
      void refreshCount();
    }
  }

  async function handleMarkAll() {
    const previousUnread = unread;
    setItems((prev) => (prev ? prev.map((n) => ({ ...n, read: true })) : prev));
    setUnread(0);
    try {
      await markAllNotificationsRead();
    } catch {
      setUnread(previousUnread);
      toast.error("Could not mark notifications as read");
    }
  }

  const badge = unread > 99 ? "99+" : String(unread);

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        aria-label={
          unread > 0 ? `Notifications, ${unread} unread` : "Notifications"
        }
        title="Notifications"
        className={cn(
          // Pixel-matched to the profile card beside it: same 40px box, same
          // border/tint treatment, so the header reads as one control cluster.
          "group relative flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <Bell className="size-5 text-muted-foreground transition-colors group-hover:text-foreground" />
        {unread > 0 && (
          <span
            className={cn(
              "absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan-500 px-1 text-[9px] font-bold leading-none text-white ring-2 ring-background",
            )}
          >
            {badge}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[320px] max-w-[calc(100vw-1.5rem)] rounded-md p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <button
              type="button"
              onClick={handleMarkAll}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CheckCheck className="size-3.5" />
              Mark all read
            </button>
          )}
        </div>

        <div className="max-h-[min(24rem,60vh)] overflow-y-auto">
          {loading && items === null && (
            <div className="space-y-2 p-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-12 animate-pulse rounded-md bg-muted/60"
                />
              ))}
            </div>
          )}

          {items !== null && items.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
              <Inbox className="size-5 text-muted-foreground" />
              <span className="text-sm font-medium">You&apos;re all caught up</span>
              <span className="text-xs text-muted-foreground">
                Team messages, assignments, and system alerts land here.
              </span>
            </div>
          )}

          {items?.map((item) => {
            const inner = (
              <>
                <span className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      item.read ? "bg-transparent" : "bg-cyan-500",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-xs",
                        item.read ? "font-medium" : "font-semibold",
                      )}
                    >
                      {item.title}
                    </span>
                    {item.body && (
                      <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">
                        {item.body}
                      </span>
                    )}
                    <span className="mt-1 block text-[10px] uppercase tracking-wide text-muted-foreground">
                      {formatRelative(new Date(item.createdAt))}
                    </span>
                  </span>
                </span>
              </>
            );

            const className = cn(
              "block w-full px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60",
              !item.read && "bg-cyan-500/[0.06]",
            );

            return item.href ? (
              <HostLink
                key={item.id}
                href={item.href}
                className={className}
                onClick={() => {
                  setOpen(false);
                  void handleItemClick(item);
                }}
              >
                {inner}
              </HostLink>
            ) : (
              <button
                key={item.id}
                type="button"
                className={className}
                onClick={() => void handleItemClick(item)}
              >
                {inner}
              </button>
            );
          })}
        </div>

        <div className="border-t border-border/60 px-3 py-2">
          <HostLink
            href="/system/staff-notifications"
            onClick={() => setOpen(false)}
            className="block rounded-md px-1 py-0.5 text-center text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            View all notifications
          </HostLink>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
