import { afterEach, expect, it, vi } from "vitest";
import {
  activateTaskScript,
  bindChatGptAppScript,
  prepareTaskScript,
} from "../../src/apps/desktop/chatgpt-route";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function composer() {
  document.body.innerHTML = `<form><span data-testid="composer-app-chip" aria-label="Farol"></span><textarea id="prompt-textarea"></textarea><input type="file"><button type="button" data-testid="send-button">Send</button></form>`;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 100,
    height: 20,
  } as DOMRect);
  const text = document.querySelector<HTMLTextAreaElement>("textarea")!;
  const file = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const send = document.querySelector<HTMLButtonElement>("button")!;
  const click = vi.spyOn(send, "click");
  return { text, file, send, click };
}

it("does not prepare a manual test over a selected file", () => {
  const { text, file, click } = composer();
  Object.defineProperty(file, "files", {
    configurable: true,
    value: { length: 1 },
  });
  expect(
    window.eval(
      prepareTaskScript("check", location.href, "Farol", undefined, true),
    ),
  ).toEqual({ draftPresent: true });
  expect(text.value).toBe("");
  expect(click).not.toHaveBeenCalled();
});

it("does not touch a draft attachment while binding the app", async () => {
  const { text, file, click } = composer();
  Object.defineProperty(file, "files", {
    configurable: true,
    value: { length: 1 },
  });
  await expect(
    window.eval(bindChatGptAppScript("Farol", location.href, true)),
  ).resolves.toEqual({ state: "blocked", reason: "draft_present" });
  expect(text.value).toBe("");
  expect(click).not.toHaveBeenCalled();
});

it("does not send if an attachment appears after preparation", () => {
  const { text, file, click } = composer();
  text.value = "check";
  Object.defineProperty(file, "files", {
    configurable: true,
    value: { length: 1 },
  });
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  expect(click).not.toHaveBeenCalled();
});

it("does not send a changed composer or visible attachment preview", () => {
  const { text, click } = composer();
  text.value = "other draft";
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  text.value = "check";
  const preview = document.createElement("div");
  preview.dataset.testid = "attachment-preview";
  document.querySelector("form")!.append(preview);
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  expect(click).not.toHaveBeenCalled();
});

it("sends only the unchanged manual prompt with a recognized empty composer", () => {
  const { text, click } = composer();
  text.value = "check";
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ activated: true });
  expect(click).toHaveBeenCalledOnce();
});

it("refuses an unrecognized composer or an unknown visible control", () => {
  const { text, file, click } = composer();
  text.value = "check";
  file.remove();
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  document.querySelector("form")!.append(file);
  const control = document.createElement("button");
  control.setAttribute("aria-label", "Unknown control");
  document.querySelector("form")!.append(control);
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  expect(click).not.toHaveBeenCalled();
});

it("refuses an ambiguous composer or a Send button owned by another form", () => {
  const { text, send, click } = composer();
  text.value = "check";
  const second = document.createElement("textarea");
  second.dataset.testid = "prompt-textarea";
  document.body.append(second);
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  second.remove();
  const other = document.createElement("form");
  document.body.append(other);
  other.append(send);
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  expect(click).not.toHaveBeenCalled();
});

it("accepts the exact prompt beside the selected inline app link", () => {
  document.body.innerHTML = `<form><div id="prompt-textarea" contenteditable="true" data-virtualkeyboard="true"><a href="/plugins/plugin_asdk_app_abcdef">Farol</a>check</div><input type="file"><button type="button" data-testid="send-button">Send</button></form>`;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 100,
    height: 20,
  } as DOMRect);
  const click = vi.spyOn(
    document.querySelector<HTMLButtonElement>("button")!,
    "click",
  );
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ activated: true });
  expect(click).toHaveBeenCalledOnce();
});

it("refuses changed whitespace in a prepared prompt", () => {
  const { text, click } = composer();
  text.value = " check";
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ draftPresent: true });
  expect(click).not.toHaveBeenCalled();
});

// Live ChatGPT has four form-associated pickers even with an empty composer.
// These DOM fixtures prove admission behavior, not live-provider execution.
function multiplePickers() {
  const fixture = composer();
  const form = document.querySelector("form")!;
  form.id = "composer-form";
  for (let i = 0; i < 3; i++) {
    const picker = document.createElement("input");
    picker.type = "file";
    if (i === 2) {
      picker.setAttribute("form", form.id);
      document.body.append(picker);
    } else form.append(picker);
  }
  return fixture;
}

it("binds, prepares and sends with four empty form-associated pickers", async () => {
  const { text, click } = multiplePickers();
  await expect(
    window.eval(bindChatGptAppScript("Farol", location.href, true)),
  ).resolves.toEqual({ state: "bound" });
  expect(
    window.eval(
      prepareTaskScript("check", location.href, "Farol", undefined, true),
    ),
  ).toMatchObject({ ready: true });
  expect(text.value).toBe("check");
  expect(
    window.eval(
      activateTaskScript(location.href, "Farol", false, false, "check"),
    ),
  ).toEqual({ activated: true });
  expect(click).toHaveBeenCalledOnce();
});

it.each([0, 1, 2, 3])(
  "refuses selected files in picker %i of four before binding, typing or Send",
  async (selected) => {
    const { text, click } = multiplePickers();
    const picker = document.querySelectorAll('input[type="file"]')[selected]!;
    Object.defineProperty(picker, "files", {
      configurable: true,
      value: { length: 1 },
    });
    await expect(
      window.eval(bindChatGptAppScript("Farol", location.href, true)),
    ).resolves.toEqual({ state: "blocked", reason: "draft_present" });
    expect(
      window.eval(
        prepareTaskScript("check", location.href, "Farol", undefined, true),
      ),
    ).toEqual({ draftPresent: true });
    expect(text.value).toBe("");
    text.value = "check";
    expect(
      window.eval(
        activateTaskScript(location.href, "Farol", false, false, "check"),
      ),
    ).toEqual({ draftPresent: true });
    expect(click).not.toHaveBeenCalled();
  },
);

// This fixture models the observed chip scaffold, not ChatGPT's live editor.
function richComposer() {
  document.body.innerHTML = `<form id="composer-form"><div id="prompt-textarea" contenteditable="true" data-virtualkeyboard="true">\n<span data-prompt-link-href="app://asdk_app_abcdef">Farol</span> </div><input type="file"><input type="file"><input type="file"><button type="button" data-testid="send-button">Send</button></form><input type="file" form="composer-form">`;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 100,
    height: 20,
  } as DOMRect);
  const editor = document.querySelector<HTMLElement>("#prompt-textarea")!;
  const click = vi.spyOn(
    document.querySelector<HTMLButtonElement>("button")!,
    "click",
  );
  const insert = vi.fn((_command: string, _ui: boolean, value: string) => {
    editor.append(document.createTextNode(value));
    return true;
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: insert,
  });
  return { editor, click, insert };
}

it("prepares the exact prompt after a selected chip scaffold and sends its unchanged snapshot", async () => {
  const { click } = richComposer();
  await expect(
    window.eval(bindChatGptAppScript("Farol", location.href, true)),
  ).resolves.toEqual({ state: "bound" });
  const prepared = window.eval(
    prepareTaskScript("check", location.href, "Farol", undefined, true),
  );
  expect(prepared).toMatchObject({
    ready: true,
    preparedComposerText: "\n check",
  });
  expect(
    window.eval(
      activateTaskScript(
        location.href,
        "Farol",
        false,
        false,
        prepared.preparedComposerText,
      ),
    ),
  ).toEqual({ activated: true });
  expect(click).toHaveBeenCalledOnce();
});

it.each([0, 1, 2, 3])(
  "refuses rich editor picker %i when a file is selected",
  async (index) => {
    const { click, insert } = richComposer();
    Object.defineProperty(
      document.querySelectorAll('input[type="file"]')[index]!,
      "files",
      {
        configurable: true,
        value: { length: 1 },
      },
    );
    await expect(
      window.eval(bindChatGptAppScript("Farol", location.href, true)),
    ).resolves.toEqual({ state: "blocked", reason: "draft_present" });
    expect(
      window.eval(
        prepareTaskScript("check", location.href, "Farol", undefined, true),
      ),
    ).toEqual({ draftPresent: true });
    expect(
      window.eval(
        activateTaskScript(location.href, "Farol", false, false, "\n check"),
      ),
    ).toEqual({ draftPresent: true });
    expect(insert).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  },
);

it("refuses owner text before preparation and exact changes after preparation", () => {
  const { editor, click, insert } = richComposer();
  editor.append("owner draft");
  expect(
    window.eval(
      prepareTaskScript("check", location.href, "Farol", undefined, true),
    ),
  ).toEqual({ draftPresent: true });
  expect(insert).not.toHaveBeenCalled();
  editor.lastChild!.remove();
  const prepared = window.eval(
    prepareTaskScript("check", location.href, "Farol", undefined, true),
  );
  expect(prepared.ready).toBe(true);
  editor.append(" ");
  expect(
    window.eval(
      activateTaskScript(
        location.href,
        "Farol",
        false,
        false,
        prepared.preparedComposerText,
      ),
    ),
  ).toEqual({ draftPresent: true });
  editor.lastChild!.remove();
  editor.append("owner edit");
  expect(
    window.eval(
      activateTaskScript(
        location.href,
        "Farol",
        false,
        false,
        prepared.preparedComposerText,
      ),
    ),
  ).toEqual({ draftPresent: true });
  expect(click).not.toHaveBeenCalled();
});

it("refuses an unexpected edit during native insertion", () => {
  const { editor, click } = richComposer();
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: () => {
      editor.append("check extra");
      return true;
    },
  });
  expect(
    window.eval(
      prepareTaskScript("check", location.href, "Farol", undefined, true),
    ),
  ).toEqual({ draftPresent: true });
  expect(click).not.toHaveBeenCalled();
});

it("preserves the exact scaffold around an inline plugin link", () => {
  const { editor, click } = richComposer();
  editor.innerHTML = '\n<a href="/plugins/plugin_asdk_app_abcdef">Farol</a> ';
  const prepared = window.eval(
    prepareTaskScript("check", location.href, "Farol", undefined, true),
  );
  expect(prepared).toMatchObject({
    ready: true,
    preparedComposerText: "\n check",
  });
  expect(
    window.eval(
      activateTaskScript(
        location.href,
        "Farol",
        false,
        false,
        prepared.preparedComposerText,
      ),
    ),
  ).toEqual({ activated: true });
  expect(click).toHaveBeenCalledOnce();
});

it("does not treat whitespace in a textarea as a selected-chip scaffold", () => {
  const { text, click } = composer();
  text.value = " ";
  expect(
    window.eval(
      prepareTaskScript("check", location.href, "Farol", undefined, true),
    ),
  ).toEqual({ draftPresent: true });
  expect(text.value).toBe(" ");
  expect(click).not.toHaveBeenCalled();
});

it("refuses an oversized prepared snapshot before native insertion", () => {
  const { editor, insert, click } = richComposer();
  editor.append(" ".repeat(128 * 1024));
  expect(
    window.eval(
      prepareTaskScript("check", location.href, "Farol", undefined, true),
    ),
  ).toEqual({ draftPresent: true });
  expect(insert).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
});
