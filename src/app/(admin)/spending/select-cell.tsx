"use client";

import { useEffect, useRef } from "react";

type SelectCellProps = {
  value: string | null;
  choices: readonly { value: string; label: string }[];
  focus: boolean;
  active: boolean;
  onChange: (value: string) => void;
};

export function SelectCell({
  value,
  choices,
  focus,
  onChange,
}: SelectCellProps) {
  const ref = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (focus && ref.current) {
      ref.current.focus();
    }
  }, [focus]);

  return (
    <select
      ref={ref}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: "100%",
        height: "100%",
        padding: "0 8px",
        border: "none",
        background: "transparent",
        color: "var(--foreground)",
        fontSize: "13px",
        outline: "none",
        cursor: "pointer",
        appearance: "auto",
      }}
    >
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
}
