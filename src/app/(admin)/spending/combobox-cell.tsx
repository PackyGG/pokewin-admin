"use client";

import { useEffect, useRef, useState } from "react";

type ComboboxCellProps = {
  value: string | null;
  suggestions: readonly { value: string; label: string }[];
  focus: boolean;
  active: boolean;
  onChange: (value: string) => void;
};

export function ComboboxCell({
  value,
  suggestions,
  focus,
  active,
  onChange,
}: ComboboxCellProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState(value ?? "");
  const [showList, setShowList] = useState(false);

  useEffect(() => {
    if (focus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [focus]);

  useEffect(() => {
    setInputValue(value ?? "");
  }, [value]);

  const label = suggestions.find((s) => s.value === value)?.label ?? value ?? "";

  if (!active) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          width: "100%",
          height: "100%",
          padding: "0 8px",
          fontSize: "13px",
          color: "var(--foreground)",
        }}
      >
        {label}
      </div>
    );
  }

  const filtered = suggestions.filter(
    (s) =>
      s.label.toLowerCase().includes(inputValue.toLowerCase()) ||
      s.value.toLowerCase().includes(inputValue.toLowerCase())
  );

  const commit = (val: string) => {
    const match = suggestions.find(
      (s) => s.label.toLowerCase() === val.toLowerCase()
    );
    onChange(match?.value ?? val);
    setShowList(false);
  };

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
          setShowList(true);
        }}
        onFocus={() => setShowList(true)}
        onBlur={() => {
          setTimeout(() => {
            commit(inputValue);
            setShowList(false);
          }, 150);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(inputValue);
          } else if (e.key === "Escape") {
            setShowList(false);
          }
        }}
        style={{
          width: "100%",
          height: "100%",
          padding: "0 8px",
          border: "none",
          background: "transparent",
          color: "var(--foreground)",
          fontSize: "13px",
          outline: "none",
        }}
        placeholder="Type or select..."
      />
      {showList && filtered.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            zIndex: 50,
            maxHeight: "160px",
            overflowY: "auto",
            background: "var(--popover)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        >
          {filtered.map((s) => (
            <button
              key={s.value}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setInputValue(s.label);
                onChange(s.value);
                setShowList(false);
              }}
              style={{
                display: "block",
                width: "100%",
                padding: "6px 10px",
                textAlign: "left",
                fontSize: "13px",
                color: "var(--foreground)",
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                (e.target as HTMLElement).style.background = "var(--accent)";
              }}
              onMouseLeave={(e) => {
                (e.target as HTMLElement).style.background = "transparent";
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
