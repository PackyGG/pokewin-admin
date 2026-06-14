"use client";

import { useEffect, useRef } from "react";
import { bootstrapSetupFromSession } from "./actions";

/**
 * Phase D mandatory-2FA bridge (client trigger). Rendered by the setup-2fa
 * page when an authenticated-but-NOT-enrolled admin arrives WITHOUT a pending
 * cookie (the `verifySession` redirect case). On mount it calls the
 * `bootstrapSetupFromSession` Server Action exactly once, which mints a pending
 * cookie from the live session and redirects back to /setup-2fa so the QR can
 * render. Shows a neutral "Preparing…" message while that round-trip happens.
 *
 * A client trigger is required because cookie writes are forbidden in a Server
 * Component render — only a Server Action (invoked from the client) may set the
 * pending cookie.
 */
export function SetupBootstrap() {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    // The action redirects on success; a thrown redirect surfaces as a promise
    // rejection here in dev — swallow it, the navigation still happens.
    void bootstrapSetupFromSession().catch(() => {});
  }, []);

  return (
    <p className="text-center text-sm text-muted-foreground">
      Preparing two-factor setup…
    </p>
  );
}
