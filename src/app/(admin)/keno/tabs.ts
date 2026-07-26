export const KENO_TABS = ["overview", "configuration", "odds"] as const;

export type KenoTab = (typeof KENO_TABS)[number];

export function parseKenoTab(value: string | undefined): KenoTab {
  return (KENO_TABS as readonly string[]).includes(value ?? "")
    ? (value as KenoTab)
    : "overview";
}
