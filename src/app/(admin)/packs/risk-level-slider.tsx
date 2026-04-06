"use client";

import { useRef, useCallback, useEffect, useState } from "react";

function clamp(val: number, min: number, max: number) {
  return Math.min(max, Math.max(min, val));
}

export function RiskLevelSlider({
  value,
  onChange,
  min = 0,
  max = 10,
  step = 0.1,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const ratio = (clamp(value, min, max) - min) / (max - min);

  const updateFromEvent = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return;
      const rect = track.getBoundingClientRect();
      const raw = (clientX - rect.left) / rect.width;
      const clamped = clamp(raw, 0, 1);
      const newVal = min + clamped * (max - min);
      const stepped = Math.round(newVal / step) * step;
      onChange(clamp(parseFloat(stepped.toFixed(2)), min, max));
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

  return (
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
  );
}
