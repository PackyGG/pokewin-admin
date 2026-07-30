"use client";

import { useRouter } from "next/navigation";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { hrefForCurrentHost } from "@/lib/use-app-host";

export function QueueReviewDrawer({
  title,
  description,
  closeHref,
  children,
}: {
  title: string;
  description: string;
  closeHref: string;
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
