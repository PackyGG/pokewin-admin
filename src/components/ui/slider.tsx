"use client"

import * as React from "react"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

/**
 * Single-value slider built on the base-ui Slider primitive, styled to match
 * the rest of the house kit (`switch.tsx` / `input.tsx`): `rounded-lg` track,
 * `ring-ring/50` focus, dark-mode tokens. Controlled via `value` /
 * `onValueChange` (a single number — the only shape this codebase needs today).
 *
 * Added explicitly per CLAUDE.md (no silent UI-dep installs): `@base-ui/react`
 * already ships a Slider primitive, so no new dependency is introduced.
 */
function Slider({
  className,
  value,
  defaultValue,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  "aria-label": ariaLabel,
  ...props
}: Omit<
  SliderPrimitive.Root.Props<number>,
  "value" | "defaultValue" | "onValueChange"
> & {
  value?: number
  defaultValue?: number
  onValueChange?: (value: number) => void
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      defaultValue={defaultValue}
      onValueChange={(next) => {
        // Single-thumb slider — base-ui hands back a number here.
        onValueChange?.(typeof next === "number" ? next : next[0] ?? 0)
      }}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn(
        "relative flex w-full touch-none items-center select-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Control
        data-slot="slider-control"
        className="flex w-full items-center py-1.5"
      >
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-input dark:bg-input/60"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-indicator"
            className="absolute h-full rounded-full bg-primary"
          />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          aria-label={ariaLabel}
          className="block size-3.5 shrink-0 rounded-full border border-primary bg-background shadow-sm ring-ring/50 transition-[color,box-shadow] outline-none focus-visible:ring-3 disabled:pointer-events-none dark:bg-foreground dark:data-dragging:bg-primary-foreground"
        />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
