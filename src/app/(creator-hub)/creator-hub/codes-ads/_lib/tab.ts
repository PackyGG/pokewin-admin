export type CodesAdsTab = "codes" | "ads";

const VALID: CodesAdsTab[] = ["codes", "ads"];

export function parseCodesAdsTab(raw: string | undefined): CodesAdsTab {
  if (raw && VALID.includes(raw as CodesAdsTab)) {
    return raw as CodesAdsTab;
  }
  return "codes";
}

export const HUB_CODES_ADS_PATH = "/creator-hub/codes-ads";

/** Hub-native ad code detail — nested under codes-ads for clean IA. */
export function hubAdDetailPath(code: string): string {
  return `${HUB_CODES_ADS_PATH}/ads/${encodeURIComponent(code)}`;
}

export const HUB_CODES_ADS_ADS_TAB = `${HUB_CODES_ADS_PATH}?tab=ads`;
