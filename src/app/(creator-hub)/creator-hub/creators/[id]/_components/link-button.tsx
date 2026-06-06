import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Server-safe link styled as a small outline button.
 *
 * The shadcn `buttonVariants` helper lives in a `"use client"` module
 * (`src/components/ui/button.tsx`), so it CANNOT be called from a Server
 * Component (Next.js throws "Attempted to call buttonVariants() from the
 * server"). These cards are Server Components, so we render a plain `<Link>`
 * carrying the same outline-button Tailwind classes instead — no client
 * function invoked on the server, identical look.
 *
 * Classes mirror `buttonVariants({ variant: "outline", size: "sm" })`.
 */
export function LinkButton({
  href,
  children,
  className,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        // base (from buttonVariants base)
        "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap cursor-pointer outline-none select-none motion-safe:transition-all motion-safe:duration-150 motion-safe:ease-out motion-safe:active:translate-y-px focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        // variant: outline
        "border-border bg-background hover:bg-muted hover:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        // size: sm
        "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem]",
        className,
      )}
    >
      {children}
    </Link>
  );
}
