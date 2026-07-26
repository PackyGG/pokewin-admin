export const QUESTION_KINDS = ["yes_no", "single", "multi"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export function isQuestionKind(value: string): value is QuestionKind {
  return (QUESTION_KINDS as readonly string[]).includes(value);
}

export const QUESTION_KIND_LABELS: Record<QuestionKind, string> = {
  yes_no: "Yes / No",
  single: "Single choice",
  multi: "Multiple choice",
};

export const QUIZ_STATUSES = ["draft", "published", "archived"] as const;
export type QuizStatus = (typeof QUIZ_STATUSES)[number];

export function isQuizStatus(value: string): value is QuizStatus {
  return (QUIZ_STATUSES as readonly string[]).includes(value);
}

export function stableShuffle<T extends { id: string }>(
  items: readonly T[],
  seed: string,
): T[] {
  const keyed = items.map((item) => ({ item, key: fnv1a(seed + item.id) }));
  keyed.sort((a, b) => (a.key === b.key ? 0 : a.key < b.key ? -1 : 1));
  return keyed.map((entry) => entry.item);
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
