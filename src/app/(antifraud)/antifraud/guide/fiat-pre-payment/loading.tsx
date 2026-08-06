import { GuideLoading } from "../_components/guide-primitives";

/**
 * This route only redirects, but without its own skeleton the redirect frame
 * inherits the Antifraud DASHBOARD skeleton (KPI grid + charts) — the wrong
 * shape for the guide page it is about to land on.
 */
export default function AntifraudFiatPrePaymentGuideLoading() {
  return <GuideLoading panels={7} />;
}
