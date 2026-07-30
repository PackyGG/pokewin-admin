"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

export function ScanPoller() {
  const router = useRouter();

  React.useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [router]);

  return null;
}
