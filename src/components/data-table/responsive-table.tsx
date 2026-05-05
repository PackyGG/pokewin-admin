"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Outer chrome for any data-table that should:
 *   - on phone (<lg): hide the table entirely (caller renders a MobileCardList instead)
 *   - on desktop (>=lg): show the table inside a rounded border, with overflow-x scrolling
 *     so a column overflow doesn't break the page layout (the parent can be tight).
 *
 * Usage:
 *
 *   <ResponsiveTableShell
 *     mobile={<MobileCardList ... />}
 *   >
 *     <Table>...</Table>
 *   </ResponsiveTableShell>
 *
 * The mobile node is rendered always but only visible <lg, and the desktop
 * table is rendered always but only visible >=lg. This avoids hydration
 * mismatches and lets server components return everything in one render.
 */
export function ResponsiveTableShell({
  mobile,
  children,
  className,
  /** Set to false to skip the desktop border (caller already wraps in card). */
  bordered = true,
}: {
  mobile: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bordered?: boolean;
}) {
  return (
    <>
      <div className={cn("lg:hidden", className)}>{mobile}</div>
      <div
        className={cn(
          "hidden overflow-x-auto lg:block",
          bordered && "rounded-md border",
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}
