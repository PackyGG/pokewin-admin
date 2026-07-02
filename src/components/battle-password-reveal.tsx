"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Copy, Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { revealBattlePassword } from "@/lib/actions/battle-password";

/**
 * Inline reveal for the plaintext password an owner set on a private
 * battle. Originally lived under /battles/[id] but lifted into
 * src/components/ so it can be reused on any surface that exposes a
 * private-battle context (transaction detail modal, /transactions/[id]
 * page, future surfaces).
 *
 * The plain value is NEVER embedded in the page payload — it's fetched
 * on demand via the revealBattlePassword server action, which audit-logs
 * the view (`battle_password_viewed`) against the battle owner's
 * user_id. Repeat reveals after the first fetch only flip visibility;
 * they don't re-hit the server, so a single reveal = a single audit row.
 *
 * Gated to role `admin` by every caller (conditional render) AND by the
 * server action itself (defence-in-depth — requireRole(["admin"]) so a
 * non-admin who got hold of the action endpoint can't bypass the UI
 * check).
 */
export function BattlePasswordReveal({ battleId }: { battleId: string }) {
  const [password, setPassword] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleReveal() {
    if (password !== null) {
      // Already fetched — just flip visibility without re-hitting the
      // server (and without writing another audit row).
      setVisible((v) => !v);
      return;
    }
    startTransition(async () => {
      try {
        const value = await revealBattlePassword(battleId);
        setPassword(value);
        setVisible(true);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to reveal password",
        );
      }
    });
  }

  async function handleCopy() {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      toast.success("Password copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — select the value manually");
    }
  }

  if (password === null || !visible) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground">
          <Lock className="size-3" />
          {"•".repeat(8)}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleReveal}
          disabled={isPending}
          className="h-7"
        >
          {isPending ? (
            <>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              Loading
            </>
          ) : (
            <>
              <Eye className="mr-1.5 size-3.5" />
              {password === null ? "Reveal" : "Show"}
            </>
          )}
        </Button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <code className="select-all rounded-md border bg-muted px-2 py-1 font-mono text-xs">
        {password}
      </code>
      <Button
        type="button"
        size="icon"
        variant="outline"
        onClick={() => setVisible(false)}
        aria-label="Hide password"
        className="size-7"
      >
        <EyeOff className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="outline"
        onClick={handleCopy}
        aria-label="Copy password"
        className="size-7"
      >
        {copied ? (
          <Check className="size-3.5 text-emerald-500" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
    </span>
  );
}
