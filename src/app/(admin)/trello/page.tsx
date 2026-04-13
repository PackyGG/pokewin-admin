import { requirePageAccess } from "@/lib/dal";
import {
  getBoards,
  getBoardLists,
  getBoardCards,
  getBoardLabels,
  getBoardMembers,
} from "@/lib/trello";
import { BoardView } from "./board-view";
import { LabelFilter } from "./label-filter";

export default async function TrelloPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/trello");
  const params = await searchParams;
  const labelFilter = params.label;

  // Find the Packy.gg board
  const boards = await getBoards();
  const board = boards.find((b) => b.name.toLowerCase().includes("packy"));

  if (!board) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Trello</h1>
        <p className="text-muted-foreground">No boards found.</p>
      </div>
    );
  }

  const [lists, allCards, labels, members] = await Promise.all([
    getBoardLists(board.id),
    getBoardCards(board.id),
    getBoardLabels(board.id),
    getBoardMembers(board.id),
  ]);

  // Filter cards by label if selected
  const filterLabel = labelFilter
    ? labels.find((l) => l.name.toLowerCase() === labelFilter.toLowerCase())
    : null;
  const cards = filterLabel
    ? allCards.filter((c) => c.labels.some((l) => l.id === filterLabel.id))
    : allCards;

  // Group cards by list
  const cardsByList: Record<string, typeof cards> = {};
  for (const list of lists) {
    cardsByList[list.id] = [];
  }
  for (const card of cards) {
    if (cardsByList[card.idList]) {
      cardsByList[card.idList].push(card);
    }
  }
  for (const listId of Object.keys(cardsByList)) {
    cardsByList[listId].sort((a, b) => a.pos - b.pos);
  }

  // Proxy attachment URLs through our API route so credentials stay
  // server-side and S3/CDN URLs aren't broken by appended auth params.
  const proxyUrl = (u: string) =>
    `/api/trello-image?url=${encodeURIComponent(u)}`;
  for (const card of cards) {
    for (const att of card.attachments || []) {
      att.url = proxyUrl(att.url);
      att.previews = att.previews.map((p) => ({
        ...p,
        url: proxyUrl(p.url),
      }));
    }
  }

  // Unique label names for the filter dropdown
  const labelNames = labels
    .filter((l) => l.name)
    .map((l) => l.name)
    .sort();

  return (
    <>
      <div className="shrink-0 px-6 pt-4 pb-3 flex items-center gap-4">
        <h1 className="text-2xl font-bold">{board.name}</h1>
        <LabelFilter labels={labelNames} current={labelFilter} />
      </div>
      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden px-6 pb-6">
        <BoardView board={board} lists={lists} cardsByList={cardsByList} labels={labels} members={members} />
      </div>
    </>
  );
}
