import { notFound } from "next/navigation";
import {
  Rocket,
  CalendarRange,
  FileText,
  ListChecks,
  Link2,
  GitBranch,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { isOwner } from "@/lib/owners";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { getRoadmapItem } from "../queries";
import { ROADMAP_STATUS_META } from "../types";
import { NotesEditor } from "./notes-editor";
import { DetailFieldsEditor } from "./detail-fields-editor";
import { LinksEditor } from "./links-editor";
import { LinearPanel } from "./linear-panel";

export const metadata = { title: "Roadmap feature" };

export default async function RoadmapItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePageAccess("/roadmap");
  const { id } = await params;
  const item = await getRoadmapItem(id);
  if (!item) notFound();

  const canCreateLinear = isOwner(session);
  const status = ROADMAP_STATUS_META[item.status];
  const range =
    item.startDate && item.endDate
      ? `${formatDate(new Date(item.startDate))} – ${formatDate(
          new Date(item.endDate),
        )}`
      : "Not scheduled";

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Rocket}
          title={item.title}
          subtitle={item.description ?? undefined}
          backHref="/roadmap"
          badges={
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                status.badge,
              )}
            >
              {status.label}
            </span>
          }
        />
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarRange className="size-3.5" aria-hidden />
          <span>{range}</span>
        </div>
      </PageHero>

      <FadeIn>
        <div className="space-y-6">
          <section className="space-y-3">
            <SectionHeading icon={FileText} title="Notes" />
            <NotesEditor itemId={item.id} body={item.body} />
          </section>

          <section className="space-y-3">
            <SectionHeading icon={ListChecks} title="Details" />
            <DetailFieldsEditor itemId={item.id} fields={item.detailFields} />
          </section>

          <section className="space-y-3">
            <SectionHeading icon={Link2} title="Links" />
            <LinksEditor itemId={item.id} links={item.links} />
          </section>

          <section className="space-y-3">
            <SectionHeading icon={GitBranch} title="Linear tasks" />
            <LinearPanel
              itemId={item.id}
              links={item.linearLinks}
              canCreateLinear={canCreateLinear}
            />
          </section>
        </div>
      </FadeIn>
    </div>
  );
}
