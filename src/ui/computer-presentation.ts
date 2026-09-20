export type SearchMatchDisplay = Readonly<{
  text: string;
  title: string | null;
}>;

// A truncated match is an excerpt of a longer line around the hit, not the
// whole line; show that instead of presenting the excerpt as complete.
export function searchMatchDisplay(
  match: Readonly<{ text: string; truncated: boolean }>,
): SearchMatchDisplay {
  if (!match.truncated) return { text: match.text, title: null };
  return {
    text: `${match.text} …`,
    title: "Excerpt of a longer line around the match",
  };
}

/**
 * Why a workspace search cannot be run yet, or null when it can.
 *
 * Its neighbour "Git status" already names its own first unmet prerequisite;
 * this control was disabled in the same situations and said nothing.
 */
export function workspaceSearchPrerequisite(
  verified: boolean,
  pattern: string,
): string | null {
  if (!verified) return "Verify this workspace again first.";
  if (pattern.trim().length === 0) return "Enter a text pattern to search for.";
  return null;
}

/**
 * Why a prepared guarded edit cannot be applied yet, or null when it can.
 *
 * The note above the fields states the "one exact match" half of the rule.
 * The other half — that the replacement has to differ from what it replaces
 * — was enforced but never stated, so identical text disabled the button
 * with no explanation.
 */
export function guardedEditApplyPrerequisite(
  oldText: string,
  newText: string,
): string | null {
  if (oldText.length === 0) {
    return "Enter the exact text to replace.";
  }
  if (oldText === newText) {
    return "The replacement is identical to the text it replaces. Change one of them.";
  }
  return null;
}
