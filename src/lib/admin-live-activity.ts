import "server-only";

import { drizzleForEnv } from "@/lib/db";
import type { DbEnv } from "@/lib/db-env";
import { queryRows } from "@/lib/drizzle-query";

export type AdminLiveTopic =
  | "deposits"
  | "card_payments"
  | "withdrawals"
  | "balance"
  | "gaming";

export type AdminLiveActivity = {
  type: "admin.activity";
  payload: {
    user_id: string | null;
    topics: AdminLiveTopic[];
    action: string;
    entity_id: string;
  };
  timestamp: string;
};

type ActivityRow = {
  id: string;
  user_id: string | null;
  kind: string;
  status: string;
  updated_at: Date | string;
};

type Source = "ledger" | "card_payments" | "withdrawals";

type Listener = {
  topics: ReadonlySet<AdminLiveTopic>;
  receive: (event: AdminLiveActivity) => void;
};

type Feed = {
  env: DbEnv;
  listeners: Set<Listener>;
  snapshots: Map<Source, Map<string, string>>;
  timer: ReturnType<typeof setInterval> | null;
  polling: boolean;
  loggedError: boolean;
};

const POLL_INTERVAL_MS = 3_000;
const SNAPSHOT_LIMIT = 128;

const GAME_LEDGER_TYPES = new Set([
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "battle_refund",
  "upgrader_bet",
  "upgrader_payout",
  "keno_bet",
  "keno_payout",
]);

const globalForAdminLive = globalThis as unknown as {
  adminLiveFeeds?: Map<DbEnv, Feed>;
};

const feeds = globalForAdminLive.adminLiveFeeds ?? new Map<DbEnv, Feed>();
globalForAdminLive.adminLiveFeeds = feeds;

function signature(row: ActivityRow): string {
  return `${row.kind}\u0000${row.status}\u0000${new Date(row.updated_at).toISOString()}`;
}

function requiredSources(listeners: ReadonlySet<Listener>): Set<Source> {
  const sources = new Set<Source>();
  for (const listener of listeners) {
    for (const topic of listener.topics) {
      if (topic === "card_payments") sources.add("card_payments");
      else if (topic === "withdrawals") sources.add("withdrawals");
      else sources.add("ledger");
    }
  }
  return sources;
}

async function readSource(env: DbEnv, source: Source): Promise<ActivityRow[]> {
  const db = drizzleForEnv(env);
  if (source === "card_payments") {
    return queryRows<ActivityRow[]>(
      db,
      `SELECT id::text AS id, user_id::text AS user_id,
              'card_payment'::text AS kind, status::text AS status, updated_at
         FROM fiat_deposit_intents
        ORDER BY updated_at DESC, id DESC
        LIMIT $1`,
      SNAPSHOT_LIMIT,
    );
  }
  if (source === "withdrawals") {
    return queryRows<ActivityRow[]>(
      db,
      `SELECT id::text AS id, user_id::text AS user_id,
              method::text AS kind, status::text AS status, updated_at
         FROM card_withdrawal_requests
        ORDER BY updated_at DESC, id DESC
        LIMIT $1`,
      SNAPSHOT_LIMIT,
    );
  }
  return queryRows<ActivityRow[]>(
    db,
    `SELECT id::text AS id, user_id::text AS user_id,
            type::text AS kind, status::text AS status, updated_at
       FROM ledger_transactions
      ORDER BY created_at DESC, id DESC
      LIMIT $1`,
    SNAPSHOT_LIMIT,
  );
}

function topicsFor(source: Source, row: ActivityRow): AdminLiveTopic[] {
  if (source === "card_payments") {
    return ["card_payments", "balance"];
  }
  if (source === "withdrawals") {
    return ["withdrawals", "balance"];
  }
  if (row.kind === "deposit") {
    return ["deposits", "balance"];
  }
  if (GAME_LEDGER_TYPES.has(row.kind)) {
    return ["gaming", "balance"];
  }
  return ["balance"];
}

function changedRows(
  previous: ReadonlyMap<string, string> | undefined,
  current: readonly ActivityRow[],
): ActivityRow[] {
  if (!previous) return [];
  return current.filter((row) => previous.get(row.id) !== signature(row));
}

function deliver(feed: Feed, source: Source, row: ActivityRow): void {
  const eventTopics = topicsFor(source, row);
  const event: AdminLiveActivity = {
    type: "admin.activity",
    payload: {
      user_id: row.user_id,
      topics: eventTopics,
      action: `${source}.${row.kind}.${row.status}`,
      entity_id: row.id,
    },
    timestamp: new Date().toISOString(),
  };
  for (const listener of feed.listeners) {
    if (!eventTopics.some((topic) => listener.topics.has(topic))) continue;
    listener.receive(event);
  }
}

async function poll(feed: Feed): Promise<void> {
  if (feed.polling || feed.listeners.size === 0) return;
  feed.polling = true;
  try {
    const sources = [...requiredSources(feed.listeners)];
    const results = await Promise.all(
      sources.map(async (source) => ({
        source,
        rows: await readSource(feed.env, source),
      })),
    );
    for (const { source, rows } of results) {
      const previous = feed.snapshots.get(source);
      feed.snapshots.set(
        source,
        new Map(rows.map((row) => [row.id, signature(row)])),
      );
      for (const row of changedRows(previous, rows)) {
        deliver(feed, source, row);
      }
    }
    feed.loggedError = false;
  } catch (error) {
    if (!feed.loggedError) {
      feed.loggedError = true;
      console.error("[admin-live] read-only activity poll failed", error);
    }
  } finally {
    feed.polling = false;
  }
}

function getFeed(env: DbEnv): Feed {
  const existing = feeds.get(env);
  if (existing) return existing;
  const feed: Feed = {
    env,
    listeners: new Set(),
    snapshots: new Map(),
    timer: null,
    polling: false,
    loggedError: false,
  };
  feeds.set(env, feed);
  return feed;
}

export function subscribeAdminLiveActivity(
  env: DbEnv,
  topics: ReadonlySet<AdminLiveTopic>,
  receive: (event: AdminLiveActivity) => void,
): () => void {
  const feed = getFeed(env);
  const listener: Listener = { topics, receive };
  feed.listeners.add(listener);

  if (!feed.timer) {
    void poll(feed);
    feed.timer = setInterval(() => void poll(feed), POLL_INTERVAL_MS);
    feed.timer.unref?.();
  } else {
    // A new listener may introduce a source the existing feed did not poll.
    void poll(feed);
  }

  return () => {
    feed.listeners.delete(listener);
    if (feed.listeners.size > 0) return;
    if (feed.timer) clearInterval(feed.timer);
    feed.timer = null;
    feed.snapshots.clear();
    feeds.delete(env);
  };
}
