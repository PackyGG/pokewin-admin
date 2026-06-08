import { formatCurrency } from "@/lib/utils/format";

export function multLabel(m: number): string {
  return `${m.toFixed(2)}×`;
}

export function formatEvUsd(n: number): string {
  if (n >= 100) return formatCurrency(n);
  return `$${n.toFixed(2)}`;
}

export function shardsPerDollarLabel(n: number): string {
  return `${n.toFixed(2)} / $1`;
}

export const EMERALD = "text-emerald-600 dark:text-emerald-400";
export const ROSE = "text-rose-600 dark:text-rose-400";
