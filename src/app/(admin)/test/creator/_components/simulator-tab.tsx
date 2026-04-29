"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { forceEndSessionAction } from "../actions";

/**
 * Stream-session control surface. force-end on the backend already
 * triggers the full end-and-convert flow (settles fill, applies
 * conversion rate, posts ledger entries), so a single button covers
 * both "stop the session" and "see the conversion happen" needs.
 *
 * IDs come from /creators/:userId — paste them here. We don't list
 * active sessions globally because there's no aggregated endpoint and
 * QA usually targets a specific creator they're already inspecting.
 */
export function SimulatorTab() {
  const [userId, setUserId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const forceEnd = () => {
    setError(null);
    setSuccess(null);
    if (!userId.trim() || !sessionId.trim()) {
      setError("user id and session id are required");
      return;
    }
    startTransition(async () => {
      const res = await forceEndSessionAction({
        user_id: userId.trim(),
        session_id: sessionId.trim(),
      });
      if (!res.success) {
        setError(res.error);
        return;
      }
      setSuccess(`Force-ended session ${sessionId.trim()}`);
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
          Force-end an active stream session
        </Label>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 max-w-2xl">
          <Input
            placeholder="creator user id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
          <Input
            placeholder="session id (uuid)"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
          />
        </div>
        <Button disabled={pending} onClick={forceEnd}>
          {pending ? "Ending..." : "Force end + convert"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Runs the same path as the user-initiated end stream: settles fill,
          applies the deal&apos;s conversion rate, and posts the conversion ledger
          entry. The session must currently be in <span className="font-mono">active</span> status.
          IDs can be copied from <span className="font-mono">/creators/:userId</span> &gt; Sessions tab.
        </p>
      </div>

      {success && <p className="text-sm text-emerald-600">{success}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
