"use client";

import { useRouter, useSearchParams } from "next/navigation";

const PRIMARY_LABELS = ["Frontend", "Backend", "Design"];

export function LabelFilter({
  labels,
  current,
}: {
  labels: string[];
  current?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const otherLabels = labels.filter(
    (l) => !PRIMARY_LABELS.some((p) => p.toLowerCase() === l.toLowerCase())
  );

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("label", value);
    } else {
      params.delete("label");
    }
    router.push(`/trello?${params.toString()}`);
  }

  return (
    <select
      value={current ?? ""}
      onChange={(e) => handleChange(e.target.value)}
      className="h-8 rounded-lg border border-input bg-transparent px-3 text-sm focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <option value="">All</option>
      {PRIMARY_LABELS.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
      {otherLabels.length > 0 && (
        <optgroup label="Other">
          {otherLabels.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
