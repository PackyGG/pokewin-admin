export type GiftCardListItem = {
  id: string;
  value: number;
  region: string;
  code: string | null;
  status: "available" | "redeemed" | "cancelled" | "expired";
  createdByAdminId: string | null;
  createdByUsername: string | null;
  redeemedByUsername: string | null;
  cancelledAt: string | null;
  cancelledByAdminId: string | null;
  cancelledByUsername: string | null;
  redeemedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export type GiftCardsListStats = {
  totalCards: number;
  availableCount: number;
  redeemedCount: number;
  totalValueUsd: number;
};
