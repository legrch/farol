/** The change-detection body of a status view, blind to its revision. */
export function statusBody(view: object): string {
  return JSON.stringify({ ...view, revision: 0 });
}
