"use client";

import { useState } from "react";
import { Check, Copy, Link as LinkIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Displays the shareable packy.gg/r/{code} URL with a copy-to-clipboard
 * action. Pure client-side — the URL is a deterministic format the
 * website already supports for affiliate attribution, so we don't need
 * to round-trip through a server action.
 */
export function CopyShareLink({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const url = `https://packy.gg/r/${code}`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border bg-card/60 px-3 py-2">
      <LinkIcon className="size-4 shrink-0 text-muted-foreground" />
      <code className="flex-1 truncate text-xs text-muted-foreground">
        {url}
      </code>
      <Button
        size="sm"
        variant="outline"
        onClick={handleCopy}
        className="shrink-0"
      >
        {copied ? (
          <>
            <Check className="mr-1 size-3.5" />
            Copied
          </>
        ) : (
          <>
            <Copy className="mr-1 size-3.5" />
            Copy
          </>
        )}
      </Button>
    </div>
  );
}
