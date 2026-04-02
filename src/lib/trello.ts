const API_KEY = process.env.TRELLO_API_KEY!;
const TOKEN = process.env.TRELLO_TOKEN!;
const BASE = "https://api.trello.com/1";

// ── Types ──────────────────────────────────────────────────────────────

export type TrelloBoard = {
  id: string;
  name: string;
  desc: string;
  closed: boolean;
  url: string;
  prefs: { backgroundImage?: string; backgroundColor?: string };
};

export type TrelloList = {
  id: string;
  name: string;
  closed: boolean;
  pos: number;
  idBoard: string;
};

export type TrelloAttachmentPreview = {
  url: string;
  width: number;
  height: number;
};

export type TrelloAttachment = {
  id: string;
  url: string;
  mimeType: string;
  previews: TrelloAttachmentPreview[];
};

export type TrelloCard = {
  id: string;
  name: string;
  desc: string;
  due: string | null;
  closed: boolean;
  pos: number;
  idList: string;
  idBoard: string;
  labels: TrelloLabel[];
  attachments: TrelloAttachment[];
};

export type TrelloLabel = {
  id: string;
  name: string;
  color: string;
  idBoard: string;
};

// ── Fetch helper ───────────────────────────────────────────────────────

async function trelloFetch<T>(
  path: string,
  init?: RequestInit & { params?: Record<string, string> }
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("key", API_KEY);
  url.searchParams.set("token", TOKEN);
  if (init?.params) {
    for (const [k, v] of Object.entries(init.params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    next: { revalidate: 30 },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trello API ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ── Boards ─────────────────────────────────────────────────────────────

export function getBoards() {
  return trelloFetch<TrelloBoard[]>("/members/me/boards", {
    params: { fields: "name,desc,closed,url,prefs", filter: "open" },
  });
}

export function getBoard(id: string) {
  return trelloFetch<TrelloBoard>(`/boards/${id}`, {
    params: { fields: "name,desc,closed,url,prefs" },
  });
}

export function createBoard(data: { name: string; desc?: string }) {
  return trelloFetch<TrelloBoard>("/boards", {
    method: "POST",
    params: { name: data.name, ...(data.desc ? { desc: data.desc } : {}) },
  });
}

export function updateBoard(
  id: string,
  data: { name?: string; desc?: string; closed?: boolean }
) {
  const params: Record<string, string> = {};
  if (data.name !== undefined) params.name = data.name;
  if (data.desc !== undefined) params.desc = data.desc;
  if (data.closed !== undefined) params.closed = String(data.closed);
  return trelloFetch<TrelloBoard>(`/boards/${id}`, {
    method: "PUT",
    params,
  });
}

export function deleteBoard(id: string) {
  return trelloFetch<unknown>(`/boards/${id}`, { method: "DELETE" });
}

// ── Lists ──────────────────────────────────────────────────────────────

export function getBoardLists(boardId: string) {
  return trelloFetch<TrelloList[]>(`/boards/${boardId}/lists`, {
    params: { fields: "name,closed,pos,idBoard", filter: "open" },
  });
}

export function createList(boardId: string, name: string) {
  return trelloFetch<TrelloList>("/lists", {
    method: "POST",
    params: { name, idBoard: boardId },
  });
}

export function updateList(
  id: string,
  data: { name?: string; pos?: string }
) {
  const params: Record<string, string> = {};
  if (data.name !== undefined) params.name = data.name;
  if (data.pos !== undefined) params.pos = data.pos;
  return trelloFetch<TrelloList>(`/lists/${id}`, { method: "PUT", params });
}

export function archiveList(id: string) {
  return trelloFetch<TrelloList>(`/lists/${id}`, {
    method: "PUT",
    params: { closed: "true" },
  });
}

// ── Cards ──────────────────────────────────────────────────────────────

export function getBoardCards(boardId: string) {
  return trelloFetch<TrelloCard[]>(`/boards/${boardId}/cards`, {
    params: {
      fields: "name,desc,due,closed,pos,idList,idBoard,labels",
      attachments: "true",
      attachment_fields: "url,mimeType,previews",
    },
  });
}

export function createCard(data: {
  idList: string;
  name: string;
  desc?: string;
  due?: string;
  idLabels?: string[];
  idMembers?: string[];
}) {
  const params: Record<string, string> = {
    idList: data.idList,
    name: data.name,
  };
  if (data.desc) params.desc = data.desc;
  if (data.idLabels?.length) params.idLabels = data.idLabels.join(",");
  if (data.idMembers?.length) params.idMembers = data.idMembers.join(",");
  if (data.due) params.due = data.due;
  return trelloFetch<TrelloCard>("/cards", { method: "POST", params });
}

export function updateCard(
  id: string,
  data: {
    name?: string;
    desc?: string;
    due?: string | null;
    idList?: string;
    closed?: boolean;
  }
) {
  const params: Record<string, string> = {};
  if (data.name !== undefined) params.name = data.name;
  if (data.desc !== undefined) params.desc = data.desc;
  if (data.due !== undefined) params.due = data.due ?? "";
  if (data.idList !== undefined) params.idList = data.idList;
  if (data.closed !== undefined) params.closed = String(data.closed);
  return trelloFetch<TrelloCard>(`/cards/${id}`, { method: "PUT", params });
}

export function deleteCard(id: string) {
  return trelloFetch<unknown>(`/cards/${id}`, { method: "DELETE" });
}

export function moveCard(id: string, idList: string) {
  return trelloFetch<TrelloCard>(`/cards/${id}`, {
    method: "PUT",
    params: { idList },
  });
}

export async function addAttachment(
  cardId: string,
  file: File,
  setCover = true
) {
  const url = new URL(`${BASE}/cards/${cardId}/attachments`);
  url.searchParams.set("key", API_KEY);
  url.searchParams.set("token", TOKEN);
  if (setCover) url.searchParams.set("setCover", "true");

  const body = new FormData();
  body.append("file", file);

  const res = await fetch(url.toString(), {
    method: "POST",
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trello API ${res.status}: ${text}`);
  }

  return res.json() as Promise<TrelloAttachment>;
}

// ── Members ───────────────────────────────────────────────────────────

export type TrelloMember = {
  id: string;
  fullName: string;
  initials: string;
  avatarUrl: string | null;
};

export function getBoardMembers(boardId: string) {
  return trelloFetch<TrelloMember[]>(`/boards/${boardId}/members`, {
    params: { fields: "id,fullName,initials,avatarUrl" },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Add auth params to a Trello preview URL so it can be loaded client-side */
export function signPreviewUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("key", API_KEY);
  u.searchParams.set("token", TOKEN);
  return u.toString();
}

// ── Comments (Actions) ─────────────────────────────────────────────────

export type TrelloComment = {
  id: string;
  date: string;
  memberCreator: {
    id: string;
    fullName: string;
    initials: string;
  };
  data: {
    text: string;
  };
};

export function getCardComments(cardId: string) {
  return trelloFetch<TrelloComment[]>(`/cards/${cardId}/actions`, {
    params: { filter: "commentCard" },
  });
}

export function addCardComment(cardId: string, text: string) {
  return trelloFetch<TrelloComment>(`/cards/${cardId}/actions/comments`, {
    method: "POST",
    params: { text },
  });
}

// ── Labels ─────────────────────────────────────────────────────────────

export function getBoardLabels(boardId: string) {
  return trelloFetch<TrelloLabel[]>(`/boards/${boardId}/labels`);
}
