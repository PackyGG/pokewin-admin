import { TrendingUp } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getLevelUpRewards } from "@/lib/queries/rewards";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { CreateRewardButton } from "../create-reward-button";
import { EditRewardButton } from "../edit-reward-button";
import { DeleteRewardButton } from "../delete-reward-button";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Level Up" };

export default async function LevelUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards/level-up");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const rewards = await getLevelUpRewards({ page, perPage });

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <TrendingUp className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Level Up Rewards</h1>
              <p className="text-sm text-muted-foreground">
                Rewards users unlock when they reach specific levels.
              </p>
            </div>
          </div>
          <CreateRewardButton />
        </div>
      </PageHero>

      <div className="space-y-4">
        <FadeIn>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Level</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Cash Amount</TableHead>
                  <TableHead>Packs</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rewards.data.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Badge variant="outline">Lv. {r.levelRequired}</Badge>
                    </TableCell>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">{r.type.replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell>{r.cashAmount != null ? formatCurrency(r.cashAmount) : "—"}</TableCell>
                    <TableCell>
                      {r.packs.length > 0 ? (
                        <div className="flex flex-col gap-1">
                          {r.packs.map((p) => (
                            <div key={p.id} className="flex items-center gap-1.5">
                              {p.imageUrl && (
                                <img src={p.imageUrl} alt="" className="size-5 rounded object-contain" />
                              )}
                              <span className="text-xs">{p.name}</span>
                              <span className="text-xs text-muted-foreground">{formatCurrency(p.priceUsd)}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <EditRewardButton reward={r} />
                        <DeleteRewardButton rewardId={r.id} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {rewards.data.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No level-up rewards found.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </FadeIn>
        <DataTablePagination
          page={rewards.page}
          totalPages={rewards.totalPages}
          total={rewards.total}
          perPage={rewards.perPage}
        />
      </div>
    </div>
  );
}
