"use client";

import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils/format";
import type { AnnouncementPackOption } from "./composer-actions";
import { NotificationPackPicker } from "./notification-pack-picker";

export const MAX_NOTIFICATION_PACKS = 3;

/** Shared pack UI for both personal sends and broadcast announcements. */
export function PackNotificationComposer({
  packs,
  scope,
  disabled,
  onChange,
}: {
  packs: AnnouncementPackOption[];
  scope: "announcement" | "direct";
  disabled: boolean;
  onChange: (packs: AnnouncementPackOption[]) => void;
}) {
  return (
    <div className="space-y-3">
      <NotificationPackPicker
        selectedValues={packs}
        onSelectionChange={onChange}
        maxSelected={MAX_NOTIFICATION_PACKS}
        scope={scope}
        placeholder="Select up to three packs…"
        disabled={disabled}
      />
      {packs.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Pack names, prices, images, and links are added automatically.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          {packs.map((pack) => (
            <div
              key={pack.id}
              className="relative rounded-md border bg-background p-2"
            >
              {pack.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={pack.imageUrl}
                  alt=""
                  className="mb-2 h-16 w-full object-contain"
                />
              ) : null}
              <p className="truncate pr-5 text-xs font-medium">{pack.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {formatCurrency(pack.priceUsd)} per open
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute right-1 top-1"
                aria-label={`Remove ${pack.name}`}
                disabled={disabled}
                onClick={() =>
                  onChange(packs.filter((item) => item.id !== pack.id))
                }
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
