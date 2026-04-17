"use client";

import { useState } from "react";
import { Check, Copy, Link as LinkIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getAdLink } from "../ad-link";

/**
 * Displays the shareable /r/{code} URL with a copy-to-clipboard action.
 * Base host is driven by NEXT_PUBLIC_MAIN_SITE_URL so beta.packy.gg and
 * production both work without code changes.
 */
export function CopyShareLink({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const url = getAdLink(code);

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
