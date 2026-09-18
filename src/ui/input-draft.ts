// What an input the owner is typing in carries across a re-render that
// rebuilds it: its text, whether it had focus, and the caret or selection.
export type InputDraft = Readonly<{
  value: string;
  focused: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
}>;

type DraftInput = {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
};

export function captureInputDraft(
  input: DraftInput | null,
  activeElement: unknown,
): InputDraft | null {
  if (!input) return null;
  return {
    value: input.value,
    focused: activeElement === input,
    selectionStart: input.selectionStart,
    selectionEnd: input.selectionEnd,
  };
}

// A rebuilt input takes the owner's draft over the saved value, and gets its
// focus and caret back, so an unrelated event never costs typed text.
export function restoreInputDraft(
  input: DraftInput,
  draft: InputDraft | null,
): void {
  if (!draft) return;
  input.value = draft.value;
  if (!draft.focused) return;
  input.focus();
  if (draft.selectionStart !== null && draft.selectionEnd !== null) {
    input.setSelectionRange(draft.selectionStart, draft.selectionEnd);
  }
}
