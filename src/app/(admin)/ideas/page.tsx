import { Lightbulb } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { IdeaBoard } from "./idea-board";
import { getIdeas } from "./queries";

export const metadata = { title: "Ideas" };

export default async function IdeasPage() {
  await requirePageAccess("/ideas");
  const ideas = await getIdeas();

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Lightbulb className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Ideas</h1>
            <p className="text-sm text-muted-foreground">
              Internal idea board — drag to reorder, click the chip to cycle
              neutral → go → kill.
            </p>
          </div>
        </div>
      </PageHero>

      <FadeIn>
        <IdeaBoard initial={ideas} />
      </FadeIn>
    </div>
  );
}
