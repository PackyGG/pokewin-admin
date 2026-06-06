import { PeriodChips } from "@/components/ux/period-chips";
import {
  CREATOR_ACTIVITY_PERIODS,
  DEFAULT_CREATOR_ACTIVITY_PERIOD,
  type CreatorActivityPeriod,
} from "@/lib/creator-hub/creator-activity-series";

/**
 * Overview activity chart window selector — 7d / 30d / 90d per the creator
 * detail mockup. URL-driven via `?activityPeriod=`; default = 30d (selecting
 * it clears the param). Active-timeframe-only: the Overview tab keys its
 * activity-chart Suspense boundary on this value so switching lazily loads
 * just the picked window.
 */

const ACTIVITY_PERIOD_ITEMS = CREATOR_ACTIVITY_PERIODS.map((value) => ({
  value,
  label: value,
}));

export function ActivityPeriodControl({
  current,
}: {
  current: CreatorActivityPeriod;
}) {
  return (
    <PeriodChips
      items={ACTIVITY_PERIOD_ITEMS}
      current={current}
      paramKey="activityPeriod"
      defaultValue={DEFAULT_CREATOR_ACTIVITY_PERIOD}
      ariaNoun="activity window"
      spinnerSize={12}
    />
  );
}
