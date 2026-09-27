import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import {
  savedChatInsertScript,
  savedChatProofScript,
  savedChatReadinessScript,
  savedChatSubmitScript,
} from "../../src/apps/desktop/saved-chat-page-scripts";

const home = "https://chatgpt.com/";
const conversation =
  "https://chatgpt.com/c/12345678-1234-4123-8123-123456789abc";
const digest = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function page() {
  class Element {
    innerText = "";
    textContent = "";
    href = "";
    disabled = false;
    visible = true;
    focus() {}
    dispatchEvent() {}
    querySelectorAll(_selector: string): Element[] {
      return [];
    }
    getBoundingClientRect() {
      return this.visible
        ? { width: 200, height: 40 }
        : { width: 0, height: 0 };
    }
    getAttribute(_name: string) {
      return null;
    }
  }
  class TextArea extends Element {
    private content = "";
    get value() {
      return this.content;
    }
    set value(value: string) {
      this.content = value;
    }
  }
  let clicks = 0;
  const location = { href: home };
  const messages: Element[] = [];
  const links: Element[] = [];
  const unrelatedLinks: Element[] = [];
  const historyRoot = new Element();
  historyRoot.querySelectorAll = () => links;
  const composer = new TextArea();
  class Button extends Element {
    click() {
      clicks += 1;
      location.href = conversation;
      const user = new Element();
      user.innerText = composer.value;
      messages.push(user);
    }
  }
  const send = new Button();
  const document = {
    querySelector(selector: string) {
      if (selector === "#prompt-textarea") return composer;
      if (selector === '[data-testid="send-button"]') return send;
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === "button") return [send];
      if (selector.startsWith('[data-testid="history"]')) return [historyRoot];
      if (selector === "a[href]") return [...links, ...unrelatedLinks];
      if (selector.includes("data-message-author-role")) return messages;
      return [];
    },
    createTextNode(text: string) {
      return { textContent: text };
    },
  };
  const context = {
    location,
    document,
    URL,
    TextEncoder,
    crypto: webcrypto,
    HTMLElement: Element,
    HTMLTextAreaElement: TextArea,
    HTMLButtonElement: Button,
    InputEvent: class {},
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  };
  return {
    context,
    location,
    composer,
    messages,
    links,
    unrelatedLinks,
    historyRoot,
    clicks: () => clicks,
    addHistory(title: string, href = conversation, inHistory = true) {
      const link = new Element();
      link.href = href;
      link.innerText = title;
      (inHistory ? links : unrelatedLinks).push(link);
    },
    run: async (script: string) =>
      vm.runInNewContext(script, context) as Promise<unknown>,
  };
}

describe("saved ChatGPT page scripts on a synthetic normal surface", () => {
  it("inserts exact text, hashes the draft and clicks Send only once", async () => {
    const fixture = page();
    expect(await fixture.run(savedChatReadinessScript(home))).toEqual({
      ready: true,
    });
    expect(
      await fixture.run(savedChatInsertScript(home, "Hello\nworld")),
    ).toEqual({
      inserted: true,
    });
    expect(fixture.composer.value).toBe("Hello\nworld");
    expect(
      await fixture.run(savedChatSubmitScript(home, digest("Hello\nworld"))),
    ).toEqual({
      clicked: true,
    });
    expect(fixture.clicks()).toBe(1);
    expect(
      await fixture.run(savedChatSubmitScript(home, digest("Hello\nworld"))),
    ).toEqual({
      clicked: false,
    });
    expect(fixture.clicks()).toBe(1);
  });

  it("requires the original user message and one exact history link after reopen", async () => {
    const fixture = page();
    await fixture.run(savedChatInsertScript(home, "First"));
    await fixture.run(savedChatSubmitScript(home, digest("First")));
    expect(
      await fixture.run(
        savedChatProofScript(
          conversation,
          digest("First"),
          digest("Title"),
          true,
        ),
      ),
    ).toEqual({ verified: false, titleVerified: false });
    fixture.addHistory(
      "Title",
      "https://other.example/c/12345678-1234-4123-8123-123456789abc",
    );
    expect(
      await fixture.run(
        savedChatProofScript(
          conversation,
          digest("First"),
          digest("Title"),
          true,
        ),
      ),
    ).toEqual({ verified: false, titleVerified: false });
    fixture.links.length = 0;
    fixture.addHistory("Title", conversation, false);
    expect(
      await fixture.run(
        savedChatProofScript(
          conversation,
          digest("First"),
          digest("Title"),
          true,
        ),
      ),
    ).toEqual({ verified: false, titleVerified: false });
    fixture.addHistory("Different title");
    expect(
      await fixture.run(
        savedChatProofScript(
          conversation,
          digest("First"),
          digest("Title"),
          true,
        ),
      ),
    ).toEqual({ verified: true, titleVerified: false });
    fixture.links.length = 0;
    fixture.addHistory("Title");
    expect(
      await fixture.run(
        savedChatProofScript(
          conversation,
          digest("First"),
          digest("Title"),
          true,
        ),
      ),
    ).toEqual({ verified: true, titleVerified: true });
    fixture.messages[0]!.innerText = "Changed";
    expect(
      await fixture.run(
        savedChatProofScript(
          conversation,
          digest("First"),
          digest("Title"),
          true,
        ),
      ),
    ).toEqual({ verified: false, titleVerified: false });
  });

  it("refuses a changed draft, temporary URL, or navigation before the click", async () => {
    const fixture = page();
    await fixture.run(savedChatInsertScript(home, "First"));
    expect(
      await fixture.run(savedChatSubmitScript(home, digest("Other"))),
    ).toEqual({
      clicked: false,
    });
    fixture.location.href = `${home}?temporary-chat=true`;
    expect(
      await fixture.run(savedChatSubmitScript(home, digest("First"))),
    ).toEqual({
      clicked: false,
    });
    fixture.location.href = conversation;
    expect(
      await fixture.run(savedChatSubmitScript(home, digest("First"))),
    ).toEqual({
      clicked: false,
    });
    expect(fixture.clicks()).toBe(0);
  });
});
