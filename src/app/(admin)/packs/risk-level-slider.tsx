"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";

function clamp(val: number, min: number, max: number) {
  return Math.min(max, Math.max(min, val));
}

export function RiskLevelSlider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [inputValue, setInputValue] = useState(String(((value / max) * 100).toFixed(1)));

  const ratio = (clamp(value, min, max) - min) / (max - min);
  const pct = (ratio * 100).toFixed(1);

  // Sync input when value changes externally (slider drag)
  useEffect(() => {
    if (!dragging) return;
    setInputValue(pct);
  }, [pct, dragging]);

  const updateFromEvent = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const raw = (clientX - rect.left) / rect.width;
      const clamped = clamp(raw, 0, 1);
      const newVal = min + clamped * (max - min);
      const stepped = Math.round(newVal / step) * step;
      const final = clamp(parseFloat(stepped.toFixed(2)), min, max);
      onChange(final);
      setInputValue(((final / max) * 100).toFixed(1));
    },
    [min, max, step, onChange],
  );

  useEffect(() => {
    if (!dragging) return;

    function onMove(e: MouseEvent) {
      updateFromEvent(e.clientX);
    }
    function onUp() {
      setDragging(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging, updateFromEvent]);

  function handleInputChange(raw: string) {
    setInputValue(raw);
    const parsed = parseFloat(raw);
    if (!isNaN(parsed)) {
      const clamped = clamp(parsed, 0, 100);
      onChange(parseFloat(((clamped / 100) * max).toFixed(2)));
    }
  }

  function handleInputBlur() {
    const parsed = parseFloat(inputValue);
    if (isNaN(parsed)) {
      setInputValue(pct);
    } else {
      const clamped = clamp(parsed, 0, 100);
      setInputValue(clamped.toFixed(1));
      onChange(parseFloat(((clamped / 100) * max).toFixed(2)));
    }
  }

  return (
    <div className="space-y-2">
      <div
        ref={trackRef}
        className="relative flex h-10 cursor-pointer items-center px-3"
        onMouseDown={(e) => {
          setDragging(true);
          updateFromEvent(e.clientX);
        }}
      >
        {/* Track background with gradient */}
        <div
          className="absolute inset-x-3 h-2.5 rounded-full"
          style={{
            background:
              "linear-gradient(to right, #22c55e 0%, #eab308 35%, #f97316 65%, #ef4444 100%)",
          }}
        />

        {/* Thumb */}
        <div
          className="pointer-events-none absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.1),0_2px_4px_rgba(0,0,0,0.2)]"
          style={{
            left: `calc(12px + (100% - 24px) * ${ratio})`,
          }}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          value={inputValue}
          onChange={(e) => handleInputChange(e.target.value)}
          onBlur={handleInputBlur}
          className="h-7 w-20 text-xs"
          min={0}
          max={100}
          step={1}
        />
        <span className="text-xs text-muted-foreground">%</span>
      </div>
    </div>
  );
}
