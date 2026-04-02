"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/dal";
import * as trello from "@/lib/trello";

// ── Boards ─────────────────────────────────────────────────────────────

export async function createBoardAction(data: {
  name: string;
  desc?: string;
}) {
  await requireAdmin();
  const board = await trello.createBoard(data);
  revalidatePath("/trello");
  return board;
}

export async function updateBoardAction(
  id: string,
  data: { name?: string; desc?: string; closed?: boolean }
) {
  await requireAdmin();
  await trello.updateBoard(id, data);
  revalidatePath("/trello");
}

export async function deleteBoardAction(id: string) {
  await requireAdmin();
  await trello.deleteBoard(id);
  revalidatePath("/trello");
}

// ── Lists ──────────────────────────────────────────────────────────────

export async function createListAction(boardId: string, name: string) {
  await requireAdmin();
  await trello.createList(boardId, name);
  revalidatePath("/trello");
}

export async function updateListAction(
  id: string,
  data: { name?: string; pos?: string }
) {
  await requireAdmin();
  await trello.updateList(id, data);
  revalidatePath("/trello");
}

export async function archiveListAction(id: string) {
  await requireAdmin();
  await trello.archiveList(id);
  revalidatePath("/trello");
}

// ── Cards ──────────────────────────────────────────────────────────────

export async function createCardAction(data: {
  idList: string;
  name: string;
  desc?: string;
  due?: string;
  idLabels?: string[];
  idMembers?: string[];
}) {
  await requireAdmin();
  const card = await trello.createCard(data);
  revalidatePath("/trello");
  return card;
}

export async function updateCardAction(
  id: string,
  data: {
    name?: string;
    desc?: string;
    due?: string | null;
    idList?: string;
    closed?: boolean;
  }
) {
  await requireAdmin();
  await trello.updateCard(id, data);
  revalidatePath("/trello");
}

export async function deleteCardAction(id: string) {
  await requireAdmin();
  await trello.deleteCard(id);
  revalidatePath("/trello");
}

export async function moveCardAction(id: string, idList: string) {
  await requireAdmin();
  await trello.moveCard(id, idList);
  revalidatePath("/trello");
}

export async function addAttachmentAction(cardId: string, formData: FormData) {
  await requireAdmin();
  const file = formData.get("file") as File;
  if (!file || file.size === 0) return;
  await trello.addAttachment(cardId, file);
  revalidatePath("/trello");
}

// ── Comments ───────────────────────────────────────────────────────────

export async function getCardCommentsAction(cardId: string) {
  await requireAdmin();
  return trello.getCardComments(cardId);
}

export async function addCardCommentAction(cardId: string, text: string) {
  await requireAdmin();
  await trello.addCardComment(cardId, text);
  revalidatePath("/trello");
}
