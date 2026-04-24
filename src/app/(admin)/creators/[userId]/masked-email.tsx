"use client";

import { useState } from "react";
import { Eye, EyeOff, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

function mask(email: string) {
  const [local, domain] = email.split("@");
  if (!domain) return "•••••";
  const visible = local.slice(0, 2);
  return `${visible}${"•".repeat(Math.max(3, local.length - 2))}@${domain}`;
}

export function MaskedEmail({ email, className }: { email: string; className?: string }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // noop
    }
  }

  return (
    <div className={cn("inline-flex items-center gap-1.5 text-sm text-muted-foreground", className)}>
      <span className="font-mono tabular-nums">
        {revealed ? email : mask(email)}
      </span>
      <button
        type="button"
        onClick={() => setRevealed((v) => !v)}
        aria-label={revealed ? "Hide email" : "Reveal email"}
        className="inline-flex size-5 items-center justify-center rounded hover:bg-accent hover:text-accent-foreground"
      >
        {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy email"
        className="inline-flex size-5 items-center justify-center rounded hover:bg-accent hover:text-accent-foreground"
      >
        {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}
