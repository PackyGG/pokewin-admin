"use client";

import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { HostLink } from "@/components/host-link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

  function close() {
    router.replace(hrefForCurrentHost(closeHref), { scroll: false });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:h-[min(92vh,64rem)] sm:max-h-[92vh] sm:w-[min(88rem,calc(100%-2rem))] sm:max-w-[88rem]"
        showCloseButton
      >
        <DialogHeader className="shrink-0 border-b bg-background px-4 py-3 pr-14 sm:px-5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <DialogTitle>Account review</DialogTitle>
              <DialogDescription>
                Inspect, document, and decide without leaving the queue.
              </DialogDescription>
            </div>
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
