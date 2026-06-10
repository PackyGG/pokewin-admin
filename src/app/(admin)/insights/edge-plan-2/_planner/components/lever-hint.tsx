"use client";

import * as React from "react";

/**
 * LeverHint — wraps a single <LeverSlider> (or any control) and renders a short,
 * plain-English line directly BELOW it explaining what that one input does.
 *
 * The owner asked for the explanation to live under each individual input rather
 * than as one dense paragraph at the top of a panel. This keeps each control
 * self-documenting without crowding the header. Tone-neutral muted text, House-POV
 * colors stay owned by the panel.
 */
export function LeverHint({
  hint,
  children,
}: {
  hint: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      {children}
      <p className="text-[11px] leading-snug text-muted-foreground/80">{hint}</p>
    </div>
  );
}
