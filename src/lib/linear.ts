import "server-only";
import { unstable_cache } from "next/cache";

// Linear GraphQL integration. Raw fetch (no SDK dependency) against the
// public GraphQL endpoint, authenticated with a workspace API key in the
// Authorization header (NOT a Bearer token — Linear expects the raw key).
// The key is server-only (never shipped to the client). All reads are cheap
// and either user-driven (search) or cached; writes are owner-gated at the
// action layer, never here.

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

function getApiKey(): string {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY is not configured");
  return key;
}

export function isLinearConfigured(): boolean {
  return Boolean(process.env.LINEAR_API_KEY);
}

type GraphQLResponse<T> = {
  data?: T;
  errors?: { message: string }[];
};

async function linearRequest<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(LINEAR_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: getApiKey(),
    },
    body: JSON.stringify({ query, variables }),
    // Caching is handled per-call-site via unstable_cache; the raw POST
    // itself must never be cached by the fetch layer.
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Linear API request failed (${res.status})`);
  }
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  if (!json.data) throw new Error("Linear API returned no data");
  return json.data;
}

export type LinearTeam = { id: string; key: string; name: string };

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  stateName: string | null;
  stateType: string | null;
  stateColor: string | null;
  assigneeName: string | null;
  teamKey: string | null;
};

type IssueNode = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state?: { name: string; type: string; color: string } | null;
  assignee?: { name: string } | null;
  team?: { key: string } | null;
};

const ISSUE_FIELDS = `id identifier title url state { name type color } assignee { name } team { key }`;

function mapIssue(n: IssueNode): LinearIssue {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    url: n.url,
    stateName: n.state?.name ?? null,
    stateType: n.state?.type ?? null,
    stateColor: n.state?.color ?? null,
    assigneeName: n.assignee?.name ?? null,
    teamKey: n.team?.key ?? null,
  };
}

/** Workspace teams (used to populate the create-task team picker). Cached
 *  5 min — teams change rarely. */
export const listLinearTeams = unstable_cache(
  async (): Promise<LinearTeam[]> => {
    const data = await linearRequest<{ teams: { nodes: LinearTeam[] } }>(
      `{ teams { nodes { id key name } } }`,
    );
    return [...data.teams.nodes].sort((a, b) => a.key.localeCompare(b.key));
  },
  ["linear-teams"],
  { revalidate: 300 },
);

/** Fulltext issue search (title / description / identifier). Live (not
 *  cached) since it's keystroke-driven; optionally narrowed to one team. */
export async function searchLinearIssues(
  term: string,
  teamKey?: string,
): Promise<LinearIssue[]> {
  const trimmed = term.trim();
  if (!trimmed) return [];
  const data = await linearRequest<{ searchIssues: { nodes: IssueNode[] } }>(
    `query Search($term: String!) {
       searchIssues(term: $term, first: 25) { nodes { ${ISSUE_FIELDS} } }
     }`,
    { term: trimmed },
  );
  const issues = data.searchIssues.nodes.map(mapIssue);
  return teamKey ? issues.filter((i) => i.teamKey === teamKey) : issues;
}

/** Fetch live status for a set of issue ids (used to refresh cached
 *  snapshots). Returns a map keyed by Linear issue id. */
export async function getLinearIssues(
  ids: string[],
): Promise<Map<string, LinearIssue>> {
  if (ids.length === 0) return new Map();
  const data = await linearRequest<{ issues: { nodes: IssueNode[] } }>(
    `query Issues($ids: [ID!]) {
       issues(filter: { id: { in: $ids } }, first: 100) { nodes { ${ISSUE_FIELDS} } }
     }`,
    { ids },
  );
  const map = new Map<string, LinearIssue>();
  for (const node of data.issues.nodes) map.set(node.id, mapIssue(node));
  return map;
}

/** Create a new Linear issue. WRITE — callers MUST gate on requireOwner()
 *  before invoking this. */
export async function createLinearIssue(input: {
  teamId: string;
  title: string;
  description?: string;
}): Promise<LinearIssue> {
  const data = await linearRequest<{
    issueCreate: { success: boolean; issue: IssueNode | null };
  }>(
    `mutation Create($input: IssueCreateInput!) {
       issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
     }`,
    {
      input: {
        teamId: input.teamId,
        title: input.title,
        description: input.description || undefined,
      },
    },
  );
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error("Linear rejected the issue creation");
  }
  return mapIssue(data.issueCreate.issue);
}
