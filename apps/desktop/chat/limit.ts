// The two size limits of a context summary: how many characters the prompt may
// carry, and how many bytes the checkpoint content may hold. Both are fixed
// rules; the prompt budget can be overridden only by a valid whole number.

export const DEFAULT_MAXIMUM_PROMPT_CHARACTERS = 128 * 1_024;
export const MAXIMUM_CHECKPOINT_CONTENT_BYTES = 256 * 1_024;

export function promptBudgetValid(budget: number): boolean {
  return Number.isSafeInteger(budget) && budget >= 1;
}

export function promptWithinBudget(prompt: string, budget: number): boolean {
  return prompt.length <= budget;
}
