import { Suspense } from "react";
import Link from "next/link";
import { getChatMessages, getMutes } from "@/lib/queries/chat";
import { requirePageAccess } from "@/lib/dal";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ChatContent } from "./chat-content";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/chat");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const tab = params.tab || "messages";

  const [messages, mutes] = await Promise.all([
    tab === "messages" ? getChatMessages({ page, perPage, search: params.search }) : null,
    tab === "mutes" ? getMutes({ page, perPage }) : null,
  ]);

  const result = tab === "messages" ? messages! : mutes!;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Chat Moderation</h1>
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {[
          { value: "messages", label: "Messages" },
          { value: "mutes", label: "Mutes" },
        ].map((t) => (
          <Link
            key={t.value}
            href={`/chat?tab=${t.value}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === t.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>
      {tab === "messages" && (
        <Suspense fallback={<Skeleton className="h-10 w-full" />}>
          <DataTableToolbar searchPlaceholder="Search messages or username..." />
        </Suspense>
      )}
      <ChatContent tab={tab} messages={messages?.data ?? []} mutes={mutes?.data ?? []} role={session.role} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
