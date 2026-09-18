import { describe, expect, it } from "vitest";

import { captureInputDraft, restoreInputDraft } from "../../src/ui/input-draft";

function input(value = "") {
  return {
    value,
    selectionStart: null as number | null,
    selectionEnd: null as number | null,
    focused: false,
    focus() {
      this.focused = true;
    },
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
}

describe("OUX-01 input drafts survive a rebuilding render", () => {
  it("carries the typed value, focus and caret into the rebuilt input", () => {
    const typing = input("tunnel_part");
    typing.selectionStart = 6;
    typing.selectionEnd = 6;
    const draft = captureInputDraft(typing, typing);

    // An unrelated task event rebuilds the form from saved settings.
    const rebuilt = input("");
    restoreInputDraft(rebuilt, draft);

    expect(rebuilt).toMatchObject({
      value: "tunnel_part",
      focused: true,
      selectionStart: 6,
      selectionEnd: 6,
    });
  });

  it("keeps an unfocused draft without stealing focus, and adopts saved state when there is none", () => {
    const other = {};
    const typed = input("tunnel_other");
    const rebuilt = input("");
    restoreInputDraft(rebuilt, captureInputDraft(typed, other));
    expect(rebuilt).toMatchObject({ value: "tunnel_other", focused: false });

    const fresh = input("tunnel_saved");
    restoreInputDraft(fresh, captureInputDraft(null, other));
    expect(fresh).toMatchObject({ value: "tunnel_saved", focused: false });
  });
});
