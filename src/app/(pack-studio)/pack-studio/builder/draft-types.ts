export type PackBuilderDraftCard = {
  cardId: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number;
  odds: number;
  color: string | null;
  animation: boolean;
};

export type PackBuilderInitialDraft = {
  id: string;
  revision: number;
  updatedAt: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  price: number;
  cardsPerOpen: number | null;
  difficulty: number;
  cards: PackBuilderDraftCard[];
  targets: {
    targetEdge: number | null;
    targetWinRate: number;
    maxWinCap: number | null;
    floorRatioMin: number | null;
    nearMissMin: number | null;
  };
  history: Array<{
    revision: number;
    changedByUsername: string | null;
    changeKind: string;
    createdAt: string;
  }>;
};
