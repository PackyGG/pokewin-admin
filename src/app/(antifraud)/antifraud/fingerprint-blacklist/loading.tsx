import {
  IdentifierBlocklistFallback,
} from "../_components/identifier-blocklist-page";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";

export default function Loading() {
  return (
    <div className="space-y-6">
      <PageHero><PageHeroIdentity /></PageHero>
      <IdentifierBlocklistFallback />
    </div>
  );
}
