"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { HostLink } from "@/components/host-link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { hrefForCurrentHost } from "@/lib/use-app-host";

export function ReviewCaseDialog({
  closeHref,
  previousHref,
  nextHref,
  children,
}: {
  closeHref: string;
  previousHref?: string;
  nextHref?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  /**
   * Closing used to be driven purely by the URL: the dialog was hard-mounted
   * `open`, and dismissing it only fired `router.replace`. The overlay
   * therefore stayed up for the whole RSC round-trip of the (heavy) queue page
   * — a click on the X or the backdrop looked like nothing happened, and
   * repeat clicks / Escape did nothing either. Owning `open` locally lets the
   * dismissal animate immediately while the URL catches up behind it.
   */
  const [open, setOpen] = useState(true);

  function close() {
    setOpen(false);
    router.replace(hrefForCurrentHost(closeHref), { scroll: false });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:h-[min(92vh,64rem)] sm:max-h-[92vh] sm:w-[min(88rem,calc(100%-2rem))] sm:max-w-[88rem]"
        showCloseButton
      >
        <DialogHeader className="shrink-0 border-b bg-background px-4 py-2 pr-14 sm:px-5">
          <div className="flex items-center justify-between gap-4">
            <DialogTitle className="text-sm">Account review</DialogTitle>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="icon-sm"
                variant="outline"
                disabled={!previousHref}
                aria-label="Previous case"
                render={
                  previousHref ? (
                    <HostLink href={previousHref} scroll={false} />
                  ) : undefined
                }
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="outline"
                disabled={!nextHref}
                aria-label="Next case"
                render={
                  nextHref ? (
                    <HostLink href={nextHref} scroll={false} />
                  ) : undefined
                }
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
