"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { clientActionError } from "@/lib/errors/client-action-error";

import { HostLink } from "@/components/host-link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { hrefForCurrentHost } from "@/lib/use-app-host";

type DismissHandler = (() => Promise<void>) | null;

const ReviewCaseDismissalContext = createContext<{
  completeAction: () => void;
  registerDismissHandler: (handler: DismissHandler) => () => void;
} | null>(null);

export function useReviewCaseDismissal() {
  return useContext(ReviewCaseDismissalContext);
}

export function ReviewCaseDialog({
  closeHref,
  previousHref,
  nextHref,
  navigation,
  children,
}: {
  closeHref: string;
  previousHref?: string;
  nextHref?: string;
  navigation?: React.ReactNode;
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
  const closingRef = useRef(false);
  const actionCompletedRef = useRef(false);
  const dismissHandlerRef = useRef<DismissHandler>(null);

  const leaveQueueCase = useCallback(
    () => router.replace(hrefForCurrentHost(closeHref), { scroll: false }),
    [closeHref, router],
  );

  const completeAction = useCallback(() => {
    actionCompletedRef.current = true;
    if (closingRef.current) return;
    closingRef.current = true;
    setOpen(false);
    leaveQueueCase();
  }, [leaveQueueCase]);

  const registerDismissHandler = useCallback((handler: DismissHandler) => {
    dismissHandlerRef.current = handler;
    return () => {
      if (dismissHandlerRef.current === handler) {
        dismissHandlerRef.current = null;
      }
    };
  }, []);
  const dismissalContext = useMemo(
    () => ({ completeAction, registerDismissHandler }),
    [completeAction, registerDismissHandler],
  );

  function close() {
    if (closingRef.current) return;
    closingRef.current = true;
    setOpen(false);

    const dismissHandler = dismissHandlerRef.current;
    if (actionCompletedRef.current || !dismissHandler) {
      leaveQueueCase();
      return;
    }

    void dismissHandler()
      .then(() => toast.success("Review postponed for 2 hours"))
      .catch((error) =>
        toast.error(
          clientActionError(error, "The review could not be postponed"),
        ),
      )
      .finally(leaveQueueCase);
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
            {navigation ?? (
              <ReviewCaseNavigation
                previousHref={previousHref}
                nextHref={nextHref}
              />
            )}
          </div>
        </DialogHeader>
        <ReviewCaseDismissalContext.Provider
          value={dismissalContext}
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
            {children}
          </div>
        </ReviewCaseDismissalContext.Provider>
      </DialogContent>
    </Dialog>
  );
}

export function ReviewCaseNavigation({
  previousHref,
  nextHref,
}: {
  previousHref?: string;
  nextHref?: string;
}) {
  return (
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
  );
}
