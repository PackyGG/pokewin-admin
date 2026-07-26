"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

import {
  subscribePackyWs,
  subscribePackyWsConnection,
  type PackyEvent,
} from "@/lib/packy-ws";

type LiveTopic =
  | "deposits"
  | "card_payments"
  | "withdrawals"
  | "balance"
  | "gaming";

type AdminActivityEvent = Extract<PackyEvent, { type: "admin.activity" }>;

export function LiveDataRefresh({
  topics,
  userId,
  debounceMs = 750,
  minIntervalMs = 1_500,
  fallbackIntervalMs = 300_000,
}: {
  topics: LiveTopic[];
  userId?: string;
  debounceMs?: number;
  minIntervalMs?: number;
  fallbackIntervalMs?: number;
}) {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefreshRef = useRef(0);
  const topicsRef = useRef(new Set(topics));
  topicsRef.current = new Set(topics);

  const refresh = useCallback(() => {
    if (document.visibilityState === "hidden") return;
    lastRefreshRef.current = Date.now();
    router.refresh();
  }, [router]);

  const scheduleRefresh = useCallback(() => {
    if (document.visibilityState === "hidden") return;
    if (timerRef.current) clearTimeout(timerRef.current);
    const sinceLast = Date.now() - lastRefreshRef.current;
    const wait = Math.max(debounceMs, minIntervalMs - sinceLast);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      refresh();
    }, wait);
  }, [debounceMs, minIntervalMs, refresh]);

  useEffect(() => {
    const unsubscribeActivity = subscribePackyWs<AdminActivityEvent>(
      "admin.activity",
      (event) => {
        if (userId && event.payload.user_id !== userId) return;
        if (
          !event.payload.topics.some((topic) => topicsRef.current.has(topic))
        ) {
          return;
        }
        scheduleRefresh();
      },
    );
    const unsubscribeConnection = subscribePackyWsConnection((reconnected) => {
      if (reconnected) scheduleRefresh();
    });
    const fallback = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, fallbackIntervalMs);

    return () => {
      unsubscribeActivity();
      unsubscribeConnection();
      clearInterval(fallback);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [fallbackIntervalMs, refresh, scheduleRefresh, userId]);

  return null;
}
