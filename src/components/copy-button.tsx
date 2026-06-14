"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * Small reusable copy-to-clipboard icon button. Copies `value` to the
 * clipboard, shows a transient ✓ + a success toast, and reverts after a
 * short delay. Purely a client affordance — no server interaction.
 *
 * Used next to copyable identifiers (user id, email, etc.). Keeps the
 * footprint tiny so it can sit inline in dense rows without disturbing
 * layout. `label` is what the toast announces ("ID copied"); `srLabel`
 * is the accessible name on the button itself.
 */
export function CopyButton({
  value,
  label = "Copied",
  srLabel,
  className,
}: {
  value: string;
  /** Human label for the success toast, e.g. "User ID". */
  label?: string;
  /** Accessible button label; defaults to `Copy ${label}`. */
  srLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy(e: React.MouseEvent) {
    // Stop the click from bubbling to a parent button/row (the id chip
    // can live inside other interactive containers).
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} copied`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard");
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={srLabel ?? `Copy ${label}`}
      title={srLabel ?? `Copy ${label}`}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {copied ? (
        <Check className="size-3 text-emerald-500" />
      ) : (
        <Copy className="size-3" />
      )}
    </button>
  );
}
