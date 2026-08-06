export const TARGET_KENO_USER_ID = "Fj6ga9pNFr5BpJL0PEVKobW3xZmhdl9F";

export type KenoNextPreview = {
  targetUserId: string;
  username: string | null;
  nonce: number;
  serverSeedHash: string;
  seedUpdatedAt: string | null;
  snapshotId: string;
  drawnNumbers: number[];
  revealedAt: string;
};

export type RevealKenoNextPreviewResult =
  { ok: true; preview: KenoNextPreview } | { ok: false; error: string };
