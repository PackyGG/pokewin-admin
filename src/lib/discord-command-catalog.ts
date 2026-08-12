export const DISCORD_SURFACES = Object.freeze([
  { id: "main", label: "PackyGG", guildId: "1438216946318442683" },
  { id: "creator", label: "Creator", guildId: "1402743122789929022" },
  { id: "vip", label: "VIP", guildId: "1505650386894327919" },
  { id: "admin", label: "Admin", guildId: "1483064422778798112" },
  { id: "dm", label: "Bot DMs", guildId: null },
] as const);

export type DiscordSurfaceId = (typeof DISCORD_SURFACES)[number]["id"];

export type DiscordCommandCatalogEntry = {
  name: string;
  description: string;
  surfaces: readonly DiscordSurfaceId[];
  access: "everyone" | "linked" | "section" | "staff";
  restriction: string;
};

const ALL_SERVERS_AND_DMS: readonly DiscordSurfaceId[] = ["main", "creator", "vip", "admin", "dm"];
const CREATOR_VIP_ADMIN: readonly DiscordSurfaceId[] = ["creator", "vip", "admin"];
const CREATOR_VIP: readonly DiscordSurfaceId[] = ["creator", "vip"];

export const DISCORD_COMMAND_CATALOG: readonly DiscordCommandCatalogEntry[] = Object.freeze([
  { name: "check", description: "Show claimable rewards and current progress.", surfaces: ALL_SERVERS_AND_DMS, access: "linked", restriction: "Linked Packy account; self only." },
  { name: "info", description: "Show the linked account’s reward-program information.", surfaces: ALL_SERVERS_AND_DMS, access: "linked", restriction: "Linked Packy account; self only." },
  { name: "status", description: "Show reward and claim status for the linked account.", surfaces: ALL_SERVERS_AND_DMS, access: "linked", restriction: "Linked Packy account; self only." },
  { name: "profile", description: "Render the caller’s community XP profile card.", surfaces: ["main"], access: "everyone", restriction: "Everyone; self only. No member lookup option." },
  { name: "ranks", description: "Show the nine-level community rank ladder.", surfaces: ["main"], access: "everyone", restriction: "Everyone in the PackyGG server; no DMs." },
  { name: "lb", description: "Show the active timed XP competition, or the lifetime community leaderboard between events.", surfaces: ["main"], access: "everyone", restriction: "Everyone in the PackyGG server; no DMs. Up to 30 users, ten per page." },
  { name: "giveaway", description: "Create or reroll durable giveaways.", surfaces: ["main"], access: "staff", restriction: "Manage Server permission; no DMs." },
  { name: "commands", description: "Post the command directory for the current server.", surfaces: CREATOR_VIP_ADMIN, access: "everyone", restriction: "Everyone in the listed server; no DMs." },
  { name: "dash", description: "Open the linked creator or VIP account in PackyDash.", surfaces: CREATOR_VIP, access: "staff", restriction: "Only approved users 660132586630414338, 934854938641715240, and 188051599099297802; linked section required." },
  { name: "link", description: "Link a Creator section or VIP channel to a Packy account.", surfaces: CREATOR_VIP, access: "staff", restriction: "Only approved users 660132586630414338, 934854938641715240, and 188051599099297802." },
  { name: "remind", description: "Schedule a one-hour reminder for the current section.", surfaces: CREATOR_VIP, access: "staff", restriction: "Only approved users 660132586630414338, 934854938641715240, and 188051599099297802." },
  { name: "deal", description: "Show the active creator deal.", surfaces: ["creator"], access: "section", restriction: "Must be used inside a linked Creator section." },
  { name: "lastdeals", description: "Show the creator’s recent deal history.", surfaces: ["creator"], access: "section", restriction: "Must be used inside a linked Creator section." },
  { name: "leaderboard", description: "Show the creator-section leaderboard.", surfaces: ["creator"], access: "section", restriction: "Must be used inside a linked Creator section." },
  { name: "rewards", description: "Show creator-facing reward programs.", surfaces: ["creator"], access: "section", restriction: "Must be used inside a linked Creator section." },
  { name: "settings", description: "View or change creator activity notifications.", surfaces: ["creator"], access: "section", restriction: "Must be used inside a linked Creator section." },
  { name: "stats", description: "Show creator-section performance statistics.", surfaces: ["creator"], access: "section", restriction: "Must be used inside a linked Creator section." },
  { name: "userstats", description: "Show one public user’s creator-section statistics.", surfaces: ["creator"], access: "section", restriction: "Must be used inside a linked Creator section." },
  { name: "setup", description: "Create a private Discord section for a creator.", surfaces: ["creator"], access: "staff", restriction: "Only approved users 660132586630414338, 934854938641715240, and 188051599099297802." },
  { name: "delete", description: "Delete and unlink a creator section with a transcript.", surfaces: ["creator"], access: "staff", restriction: "Only approved users 660132586630414338, 934854938641715240, and 188051599099297802." },
  { name: "checkwallets", description: "Show current PackyGG hot-wallet balances.", surfaces: ["admin"], access: "staff", restriction: "Wallet staff roles 1483073067860234283 or 1483064422778798118; superusers 660132586630414338 or 934854938641715240." },
]);
