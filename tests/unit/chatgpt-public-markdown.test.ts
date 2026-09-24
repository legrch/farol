import { describe, expect, it } from "vitest";
import { publicMarkdownBlock } from "../../src/apps/desktop/chatgpt-public-markdown";

// Structural DOM fixtures only. These do not qualify ChatGPT selectors,
// visibility/layout, source identities, or native browser behavior.
function text(value: string): Node {
  return { nodeType: 3, nodeValue: value } as Node;
}
function element(
  tag: string,
  children: (Node | string)[],
  attributes: Record<string, string> = {},
): Element {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: children.map((child) =>
      typeof child === "string" ? text(child) : child,
    ),
    getAttribute: (name: string) => attributes[name] ?? null,
  } as unknown as Element;
}
const visible = (node: Element) => node.getAttribute("hidden") === null;
const render = (node: Element) => publicMarkdownBlock(node, visible);

describe("public Markdown block conversion (synthetic DOM)", () => {
  it("preserves Unicode, emphasis and a hydrated link", () => {
    expect(
      render(
        element("p", [
          "Привет 👋 ",
          element("strong", ["world"]),
          " ",
          element("a", ["source"], { href: "https://example.test/a?q=1&b=2" }),
        ]),
      ),
    ).toBe("Привет 👋 **world** [source](<https://example.test/a?q=1&b=2>)");
  });
  it("preserves literal Markdown punctuation as text", () => {
    expect(render(element("p", ["[fake](x) *text* <tag>"]))).toBe(
      "\\[fake\\](x) \\*text\\* \\<tag\\>",
    );
    expect(render(element("p", ["# title"]))).toBe("\\# title");
    expect(render(element("p", ["1. literal"]))).toBe("1\\. literal");
    expect(render(element("p", ["- literal"]))).toBe("\\- literal");
  });
  it("uses a longer code fence than any literal fence in the code", () => {
    expect(
      render(
        element("pre", [
          element("code", ["const s = `x`;\n```\n"], { class: "language-ts" }),
        ]),
      ),
    ).toBe("````ts\nconst s = `x`;\n```\n````");
  });
  it("preserves multiline nested lists and ordered start numbers", () => {
    expect(
      render(
        element(
          "ol",
          [
            element("li", [
              "first",
              element("ul", [element("li", ["nested"])]),
            ]),
            element("li", ["second"]),
          ],
          { start: "3" },
        ),
      ),
    ).toBe("3. first\n   - nested\n4. second");
  });
  it("renders tables and escapes pipes without losing columns", () => {
    expect(
      render(
        element("table", [
          element("thead", [
            element("tr", [element("th", ["A"]), element("th", ["B"])]),
          ]),
          element("tbody", [
            element("tr", [element("td", ["x|y"]), element("td", ["✓"])]),
          ]),
        ]),
      ),
    ).toBe("| A | B |\n| --- | --- |\n| x\\|y | ✓ |");
  });
  it("omits invisible descendants and controls without reading their content", () => {
    const unreadable = element("span", [], { hidden: "" });
    Object.defineProperty(unreadable, "childNodes", {
      get: () => {
        throw new Error("PRIVATE_CONTENT_READ");
      },
    });
    expect(
      render(
        element("p", ["Visible", unreadable, element("button", ["Copy"])]),
      ),
    ).toBe("Visible");
  });
  it("buffers an unhydrated link instead of committing incomplete Markdown", () => {
    expect(() => render(element("p", [element("a", ["citation"])]))).toThrow(
      "CHATGPT_MARKDOWN_PENDING_LINK",
    );
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "https://user:password@example.test/",
    "/relative",
    "https://example.test/<bad>",
  ])("refuses an unqualified destination %s", (href) => {
    expect(() => render(element("a", ["link"], { href }))).toThrow(
      "CHATGPT_MARKDOWN_LINK_UNSUPPORTED",
    );
  });
  it("reports unsupported rich output and table spans explicitly", () => {
    expect(() =>
      render(element("img", [], { src: "https://example.test/x.png" })),
    ).toThrow("CHATGPT_MARKDOWN_RICH_OUTPUT_UNSUPPORTED");
    expect(() =>
      render(
        element("table", [
          element("tr", [element("th", ["A"], { colspan: "2" })]),
        ]),
      ),
    ).toThrow("CHATGPT_MARKDOWN_TABLE_UNSUPPORTED");
  });
  it("bounds traversal before copying an oversized block", () => {
    expect(() => render(element("p", ["x".repeat(262_145)]))).toThrow(
      "CHATGPT_MARKDOWN_LIMIT",
    );
    let deep = element("span", ["x"]);
    for (let i = 0; i < 70; i++) deep = element("span", [deep]);
    expect(() => render(deep)).toThrow("CHATGPT_MARKDOWN_LIMIT");
  });
});
