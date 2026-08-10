"use client";

import { Bell, Copy, ExternalLink, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  previewNotificationText,
  unrenderedPayloadKeys,
} from "@/lib/user-notification-templates";
import type { NotificationPayload } from "@/lib/user-notification";

/**
 * What the recipient actually sees in their notification popover.
 *
 * The point of this panel is the warning, not the mockup: `type` is an i18n
 * key and the site only has templates for a handful of them. Send an unknown
 * key and the row renders as "Notification / <type with underscores stripped>"
 * with the payload dropped on the floor — which reads as a broken feature
 * unless you know that's the contract. Better to see it here than on a real
 * account.
 */
export function NotificationPreview({
  type,
  payload,
}: {
  type: string;
  payload: NotificationPayload | undefined;
}) {
  const preview = previewNotificationText(type, payload);
  const unrendered = unrenderedPayloadKeys(type, payload);
  const previewImages =
    preview.images ?? (preview.image ? [preview.image] : []);

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        What the user sees
      </p>

      <div className="relative flex gap-3 overflow-hidden rounded-md border bg-muted/30 p-3">
        <div className="mt-0.5 shrink-0 rounded-lg bg-primary/10 p-1.5">
          <Bell className="size-3.5 text-primary" />
        </div>
        <div
          className={`relative z-10 min-w-0 flex-1 space-y-0.5 ${previewImages.length > 0 ? "pr-24" : ""}`}
        >
          {preview.packCount && preview.packCount > 1 && (
            <p className="text-[10px] font-semibold uppercase tracking-wide text-primary">
              {preview.packCount} new packs
            </p>
          )}
          <p className="truncate text-sm font-medium">{preview.title}</p>
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {preview.body}
          </p>
          {preview.code && (
            <span className="mt-1.5 flex items-center gap-2 rounded-md border bg-background px-2 py-1">
              <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold tracking-wider">
                {preview.code}
              </span>
              <Copy className="size-3 shrink-0 text-muted-foreground" />
            </span>
          )}
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <Badge
              variant="outline"
              className={
                preview.known
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              }
            >
              {preview.known ? "Template exists" : "Fallback"}
            </Badge>
            {preview.href && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <ExternalLink className="size-3" />
                {preview.packCount && preview.packCount > 1
                  ? "Opens newest packs"
                  : "Opens pack page"}
              </span>
            )}
          </div>
        </div>
        {previewImages.length > 0 && (
          <span className="pointer-events-none absolute inset-y-0 right-0 w-28 overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_35%)]">
            {previewImages.map((image, index) => {
              const count = previewImages.length;
              const positions =
                count === 1
                  ? [{ left: "48%", rotate: "-15deg", zIndex: 1 }]
                  : count === 2
                    ? [
                        { left: "38%", rotate: "-12deg", zIndex: 1 },
                        { left: "65%", rotate: "12deg", zIndex: 2 },
                      ]
                    : [
                        { left: "30%", rotate: "-13deg", zIndex: 1 },
                        { left: "51%", rotate: "0deg", zIndex: 3 },
                        { left: "72%", rotate: "13deg", zIndex: 2 },
                      ];
              const position = positions[index];
              return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={`${image}-${index}`}
                  src={image}
                  alt=""
                  style={position}
                  className="absolute top-1/2 h-[92%] w-[48%] -translate-x-1/2 -translate-y-1/2 object-contain"
                />
              );
            })}
          </span>
        )}
      </div>

      {!preview.known && (
        <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="space-y-1 text-[11px] text-amber-700 dark:text-amber-300">
            <p className="font-medium">
              The site has no template for{" "}
              <code className="font-mono">{type.trim() || "(empty)"}</code>.
            </p>
            <p className="text-amber-700/80 dark:text-amber-300/80">
              The row is written and the API returns your payload, but the
              popover falls back to the generic copy above. Add a case for this
              type in <code className="font-mono">notification-text.ts</code>{" "}
              before using it for customer-facing content.
            </p>
            <p className="text-amber-700/80 dark:text-amber-300/80">
              Sending is still useful for exercising the endpoint — the row, the
              unread count and the websocket event all fire.
            </p>
          </div>
        </div>
      )}

      {preview.known && !preview.code && preview.usedKeys.includes("code") && (
        <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p className="text-[11px] text-amber-700 dark:text-amber-300">
            This template renders a copyable code, but the payload has no{" "}
            <code className="font-mono">code</code> key — recipients would get a
            notification telling them to redeem something they can&apos;t see.
            Add <code className="font-mono">code</code> to the payload.
          </p>
        </div>
      )}

      {preview.known && unrendered.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Delivered but not rendered by this template:{" "}
          <span className="font-mono">{unrendered.join(", ")}</span>
        </p>
      )}
    </div>
  );
}
