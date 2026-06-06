export type CodesAdsTab = "codes" | "ads";

const VALID: CodesAdsTab[] = ["codes", "ads"];

export function parseCodesAdsTab(raw: string | undefined): CodesAdsTab {
  if (raw && VALID.includes(raw as CodesAdsTab)) {
    return raw as CodesAdsTab;
  }
  return "codes";
}

export const HUB_CODES_ADS_PATH = "/creator-hub/codes-ads";
