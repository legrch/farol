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
