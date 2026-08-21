import type { ReviewCard } from "./types";

export const REVIEW_ROUND_SIZE = 5;

export function startReviewRound(
  dueCards: readonly ReviewCard[],
): string[] {
  return dueCards
    .slice(0, REVIEW_ROUND_SIZE)
    .map((card) => card.id);
}

export function resolveReviewRound(
  dueCards: readonly ReviewCard[],
  roundIds: readonly string[],
): ReviewCard[] {
  const dueById = new Map(dueCards.map((card) => [card.id, card]));
  return roundIds.flatMap((id) => {
    const card = dueById.get(id);
    return card ? [card] : [];
  });
}

export function restoreUndoneCardToRound(
  roundIds: readonly string[],
  cardId: string,
): string[] {
  if (roundIds.includes(cardId)) return [...roundIds];
  return [cardId, ...roundIds].slice(0, REVIEW_ROUND_SIZE);
}
