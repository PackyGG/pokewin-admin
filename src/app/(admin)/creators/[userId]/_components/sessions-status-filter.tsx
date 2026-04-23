"use client";

import { useRouter, useSearchParams } from "next/navigation";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { StreamSessionStatus } from "@/lib/backend-api";

const ALL_VALUE = "__all__";

type Option = {
  value: StreamSessionStatus | typeof ALL_VALUE;
  label: string;
};

const options: Option[] = [
  { value: ALL_VALUE, label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "ended", label: "Ended" },
  { value: "converted", label: "Converted" },
];

const labelFor = (value: string): string =>
  options.find((o) => o.value === value)?.label ?? value;

type Props = {
  value: StreamSessionStatus | undefined;
};

export function SessionsStatusFilter({ value }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function onChange(next: string | null) {
    if (next === null) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === ALL_VALUE) {
      params.delete("sessionsStatus");
    } else {
      params.set("sessionsStatus", next);
    }
    // reset to page 1 when filter changes — otherwise a narrower result
    // set can land us on a page that no longer exists
    params.set("sessionsPage", "1");
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  return (
    <Select value={value ?? ALL_VALUE} onValueChange={onChange}>
      <SelectTrigger className="h-7 w-[150px] text-xs">
        <SelectValue>{(v: string) => labelFor(v)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
