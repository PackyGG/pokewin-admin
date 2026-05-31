"use client";

import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Summary block for a changelog card. When the summary is long
 * (> COLLAPSE_THRESHOLD_LINES estimated rendered lines) the body is
 * clamped to ~5 lines via line-clamp and a "Show more" disclosure
 * expands it in place.
 *
 * Estimation is intentionally string-based (line count via newline
 * splits) instead of measuring rendered height, so SSR + first paint
 * pick the right state without an effect / layout pass.
 *
 * Server Component callers pass the already-cleaned summary text
 * (Co-Authored-By and other trailers already stripped server-side
 * in `normalizeCommitBody`). This component only does presentation —
 * no parsing, no trimming, no markdown.
 */
const COLLAPSE_THRESHOLD_LINES = 5;

export function ChangelogSummary({ text }: { text: string }) {
  // Cheap heuristic for "is this long enough to collapse?": count
  // newlines AND estimate visual wraps for paragraphs longer than
  // ~100 chars (the card width fits roughly 80-90 chars/line on
  // desktop, so 100 is a conservative wrap threshold).
  const estimatedLines = React.useMemo(() => {
    let count = 0;
    for (const line of text.split("\n")) {
      // Empty lines (paragraph breaks) still take one rendered line.
      count += Math.max(1, Math.ceil(line.length / 100));
    }
    return count;
  }, [text]);

  const collapsible = estimatedLines > COLLAPSE_THRESHOLD_LINES;
  const [expanded, setExpanded] = React.useState(false);

  if (!collapsible) {
    return (
      <p className="whitespace-pre-line text-sm text-muted-foreground">
        {text}
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      <p
        className={cn(
          "whitespace-pre-line text-sm text-muted-foreground",
          // line-clamp-5 caps the collapsed view; lifted on expand.
          !expanded && "line-clamp-5",
        )}
      >
        {text}
      </p>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={expanded}
      >
        {expanded ? (
          <>
            <ChevronUp className="size-3" />
            Show less
          </>
        ) : (
          <>
            <ChevronDown className="size-3" />
            Show more
          </>
        )}
      </button>
    </div>
  );
}
