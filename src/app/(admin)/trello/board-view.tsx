"use client";

import { useState } from "react";
import type { TrelloBoard, TrelloList, TrelloCard, TrelloLabel, TrelloMember } from "@/lib/trello";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Plus, Archive, Trash2, ArrowRight, Calendar } from "lucide-react";
import {
  archiveListAction,
  deleteCardAction,
  moveCardAction,
} from "./actions";
import { CreateListDialog } from "./create-list-dialog";
import { CreateCardDialog } from "./create-card-dialog";
import { CardDetailSheet } from "./card-detail-sheet";

const LABEL_COLORS: Record<string, string> = {
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  orange: "bg-orange-500",
  red: "bg-red-500",
  purple: "bg-purple-500",
  blue: "bg-blue-500",
  sky: "bg-sky-400",
  lime: "bg-lime-500",
  pink: "bg-pink-500",
  black: "bg-neutral-800",
};

export function BoardView({
  board,
  lists,
  cardsByList,
  labels,
  members,
}: {
  board: TrelloBoard;
  lists: TrelloList[];
  cardsByList: Record<string, TrelloCard[]>;
  labels: TrelloLabel[];
  members: TrelloMember[];
}) {
  const [selectedCard, setSelectedCard] = useState<TrelloCard | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  function openCard(card: TrelloCard) {
    setSelectedCard(card);
    setSheetOpen(true);
  }

  async function handleArchiveList(listId: string) {
    await archiveListAction(listId);
  }

  async function handleDeleteCard(cardId: string) {
    await deleteCardAction(cardId);
  }

  async function handleMoveCard(cardId: string, targetListId: string) {
    await moveCardAction(cardId, targetListId);
  }

  return (
    <>
      <div className="flex gap-4 h-full pb-4">
        {lists.map((list) => (
          <div
            key={list.id}
            className="bg-muted/50 rounded-lg p-3 min-w-[280px] max-w-[280px] flex flex-col max-h-full"
          >
            {/* List header */}
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm truncate">{list.name}</h3>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="h-6 w-6" />}>
                  <MoreHorizontal className="h-4 w-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={() => handleArchiveList(list.id)}
                    className="text-destructive"
                  >
                    <Archive className="mr-2 h-4 w-4" />
                    Archive List
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Add card button */}
            <CreateCardDialog listId={list.id} labels={labels} lists={lists} members={members} />

            {/* Cards */}
            <div className="space-y-2 flex-1 overflow-y-auto">
              {(cardsByList[list.id] || []).map((card) => (
                <div
                  key={card.id}
                  className="bg-background rounded-md border cursor-pointer hover:border-primary/50 transition-colors overflow-hidden"
                >
                  {/* Attachment image */}
                  {(() => {
                    const img = card.attachments?.find((a) => a.mimeType?.startsWith("image/"));
                    const preview = img?.previews?.[img.previews.length - 1];
                    return preview ? (
                      <img
                        src={preview.url}
                        alt=""
                        className="w-full h-32 object-cover"
                        onClick={() => openCard(card)}
                      />
                    ) : null;
                  })()}
                  <div className="p-2.5">
                  {/* Labels */}
                  {card.labels.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {card.labels.map((label) => (
                        <span
                          key={label.id}
                          className={`h-2 w-8 rounded-full ${LABEL_COLORS[label.color] || "bg-gray-400"}`}
                          title={label.name}
                        />
                      ))}
                    </div>
                  )}

                  <div className="flex items-start justify-between gap-1">
                    <span
                      className="text-sm flex-1 break-words min-w-0"
                      onClick={() => openCard(card)}
                    >
                      {card.name}
                    </span>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" />}>
                        <MoreHorizontal className="h-3 w-3" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger>
                            <ArrowRight className="mr-2 h-4 w-4" />
                            Move to...
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent>
                            {lists
                              .filter((l) => l.id !== list.id)
                              .map((targetList) => (
                                <DropdownMenuItem
                                  key={targetList.id}
                                  onClick={() =>
                                    handleMoveCard(card.id, targetList.id)
                                  }
                                >
                                  {targetList.name}
                                </DropdownMenuItem>
                              ))}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuItem
                          onClick={() => handleDeleteCard(card.id)}
                          className="text-destructive"
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {/* Due date */}
                  {card.due && (
                    <div className="mt-1.5">
                      <Badge variant="outline" className="text-xs gap-1">
                        <Calendar className="h-3 w-3" />
                        {new Date(card.due).toLocaleDateString()}
                      </Badge>
                    </div>
                  )}
                  </div>
                </div>
              ))}
            </div>

          </div>
        ))}

        {/* Add list column */}
        <div className="min-w-[280px]">
          <CreateListDialog boardId={board.id} />
        </div>
      </div>

      {/* Card detail sheet */}
      <CardDetailSheet
        card={selectedCard}
        lists={lists}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
    </>
  );
}
