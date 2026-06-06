import { PeriodChips } from "@/components/ux";
import {
  TOP_CREATORS_PERIOD_LABELS,
  TOP_CREATORS_PERIODS,
  type TopCreatorsPeriod,
} from "../_lib/top-creators-period";

const ITEMS = TOP_CREATORS_PERIODS.map((value) => ({
  value,
  label: TOP_CREATORS_PERIOD_LABELS[value],
}));

export function HubTopCreatorsPeriodSelector({
  current,
}: {
  current: TopCreatorsPeriod;
}) {
  return (
    <PeriodChips
      items={ITEMS}
      current={current}
      paramKey="topPeriod"
      defaultValue="3d"
      ariaNoun="ranking window"
    />
  );
}
