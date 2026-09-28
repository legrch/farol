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
  it.each([
    ["strong", "**"],
    ["b", "**"],
    ["em", "*"],
    ["i", "*"],
    ["del", "~~"],
    ["s", "~~"],
  ])("keeps %s edge whitespace outside generated delimiters", (tag, marker) => {
    expect(
      render(
        element("p", [
          "before",
          element(tag!, [
            element("span", [" "]),
            "formatted",
            element("span", [" "]),
          ]),
          "after",
        ]),
      ),
    ).toBe(`before ${marker}formatted${marker} after`);
    expect(
      render(element("p", ["before", element(tag!, ["  "]), "after"])),
    ).toBe("before after");
  });
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
      "\\[fake\\](x\\) \\*text\\* \\<tag\\>",
    );
    expect(render(element("p", ["# title"]))).toBe("\\# title");
    expect(render(element("p", ["1. literal"]))).toBe("1\\. literal");
    expect(render(element("p", ["- literal"]))).toBe("\\- literal");
  });
  // No production Markdown renderer is available in this checkout. These
  // assertions cover serialization, not a renderer or native DOM round-trip.
  it.each([
    ["---", "\\-\\-\\-"],
    ["- - -", "\\- \\- \\-"],
    ["***", "\\*\\*\\*"],
    ["___", "\\_\\_\\_"],
    ["===", "\\=\\=\\="],
    ["- item", "\\- item"],
    ["+ item", "\\+ item"],
    ["* item", "\\* item"],
    ["1. item", "1\\. item"],
    ["42) item", "42\\) item"],
    ["# title", "\\# title"],
    ["> quote", "\\> quote"],
    ["&copy;", "\\&copy;"],
    ["&#169;", "\\&\\#169;"],
    ["&#xA9;", "\\&\\#xA9;"],
    ["&amp;copy;", "\\&amp;copy;"],
    ["&lt;script&gt;", "\\&lt;script\\&gt;"],
    ["\\&copy;", "\\\\\\&copy;"],
    ["[fake](x)", "\\[fake\\](x\\)"],
    ["© 👋", "© 👋"],
  ])(
    "keeps literal %s safe across adjacent text and span nodes",
    (value, expected) => {
      expect(render(element("p", [value]))).toBe(expected);
      for (let split = 0; split <= value.length; split++) {
        const left = value.slice(0, split);
        const right = value.slice(split);
        expect(render(element("p", [text(left), text(right)]))).toBe(expected);
        expect(render(element("p", [left, element("span", [right])]))).toBe(
          expected,
        );
        expect(render(element("p", [element("span", [left]), right]))).toBe(
          expected,
        );
      }
      expect(
        render(
          element(
            "p",
            [...value].map((character) =>
              element("span", [element("span", [character])]),
            ),
          ),
        ),
      ).toBe(expected);
    },
  );
  it("escapes literal markers after generated line and block boundaries", () => {
    expect(
      render(
        element("p", [
          "Heading",
          element("br", []),
          element("span", ["="]),
          "==",
          element("br", []),
          "1",
          element("span", ["."]),
          " item",
          element("br", []),
          "-",
          element("span", ["--"]),
        ]),
      ),
    ).toBe("Heading  \n\\=\\=\\=  \n1\\. item  \n\\-\\-\\-");
    expect(
      render(
        element("div", [element("p", ["Heading"]), element("p", ["---"])]),
      ),
    ).toBe("Heading\n\n\\-\\-\\-");
  });
  it("escapes text without escaping generated semantic syntax", () => {
    expect(render(element("hr", []))).toBe("---");
    expect(
      render(
        element("ul", [
          element("li", ["-", element("span", [" item &copy;"])]),
        ]),
      ),
    ).toBe("- \\- item \\&copy;");
    expect(
      render(
        element("ol", [element("li", ["1", element("span", ["."]), " item"])], {
          start: "2",
        }),
      ),
    ).toBe("2. 1\\. item");
    expect(render(element("blockquote", [element("p", ["---"])]))).toBe(
      "> \\-\\-\\-",
    );
    expect(render(element("h2", ["--- &copy;"]))).toBe("## \\-\\-\\- \\&copy;");
    expect(
      render(
        element("p", [
          element("strong", ["---"]),
          " ",
          element("em", ["&copy;"]),
          " ",
          element("del", ["1. item"]),
        ]),
      ),
    ).toBe("**\\-\\-\\-** *\\&copy;* ~~1\\. item~~");
    expect(
      render(
        element("a", ["&", element("span", ["copy; ---"])], {
          href: "https://example.test/a-b?q=1&b=2",
        }),
      ),
    ).toBe("[\\&copy; \\-\\-\\-](<https://example.test/a-b?q=1&b=2>)");
    expect(render(element("code", ["--- &copy; 1. item + ="]))).toBe(
      "`--- &copy; 1. item + =`",
    );
    expect(
      render(element("pre", [element("code", ["--- &copy;\n1. item\n+ ="])])),
    ).toBe("```\n--- &copy;\n1. item\n+ =\n```");
    expect(
      render(
        element("table", [
          element("tr", [element("th", ["---"]), element("th", ["&copy;"])]),
          element("tr", [
            element("td", ["1", element("span", ["."]), " item|value"]),
            element("td", [element("code", ["--- &copy; x|y"])]),
          ]),
        ]),
      ),
    ).toBe(
      "| \\-\\-\\- | \\&copy; |\n| --- | --- |\n| 1\\. item\\|value | `--- &copy; x\\|y` |",
    );
  });
  it("keeps a literal exclamation before a semantic link from creating an image", () => {
    for (const prefix of ["!", element("span", ["!"])]) {
      expect(
        render(
          element("p", [
            prefix,
            element("a", ["diagram"], {
              href: "https://example.test/image.png",
            }),
          ]),
        ),
      ).toBe("\\![diagram](<https://example.test/image.png>)");
    }
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
  it.each(["Copy code", "Копировать код", "Copiar código"])(
    "normalizes one qualified DIV code block independently of toolbar %s",
    (label) => {
      const code = element("code", ["  const x = `a`;\n\n\treturn x;\n"], {
        class: "language-ts",
      });
      const wrapper = (toolbar: boolean) =>
        element(
          "div",
          [
            ...(toolbar
              ? [
                  element("div", [
                    element("span", ["TypeScript"]),
                    element("button", [label]),
                  ]),
                ]
              : []),
            element("div", [element("pre", [code])]),
          ],
          { "data-markdown-copy": "code-block" },
        );
      const expected = "```ts\n  const x = `a`;\n\n\treturn x;\n```";
      expect(render(wrapper(true))).toBe(expected);
      expect(render(wrapper(false))).toBe(expected);
      expect(
        render(element("section", [element("div", [wrapper(true)])])),
      ).toBe(expected);
    },
  );
  it("keeps unqualified DIV CODE inline and refuses ambiguous qualified shapes", () => {
    expect(render(element("div", [element("code", ["a\nb"])]))).toBe("`a b`");
    for (const children of [
      [element("code", ["one"]), element("code", ["two"])],
      [element("code", [element("code", ["nested"])])],
      [element("code", ["one"]), element("p", ["outside prose"])],
      [
        element("div", [element("code", ["nested wrapper"])], {
          "data-markdown-copy": "code-block",
        }),
      ],
      [element("code", [element("div", ["unknown literal"])])],
    ]) {
      expect(() =>
        render(
          element("div", children, { "data-markdown-copy": "code-block" }),
        ),
      ).toThrow("CHATGPT_MARKDOWN_CODE_WRAPPER_UNSUPPORTED");
    }
  });
  it("does not traverse hidden or control descendants in a qualified code wrapper", () => {
    const hidden = element("div", [], { hidden: "" });
    const button = element("button", []);
    for (const node of [hidden, button])
      Object.defineProperty(node, "childNodes", {
        get() {
          throw new Error("EXCLUDED_READ");
        },
      });
    expect(
      render(
        element("div", [hidden, button, element("code", ["visible\ncode"])], {
          "data-markdown-copy": "code-block",
        }),
      ),
    ).toBe("```\nvisible\ncode\n```");
  });
  it("buffers a qualified wrapper without a mounted CODE and preserves empty CODE", () => {
    expect(() =>
      render(element("div", [], { "data-markdown-copy": "code-block" })),
    ).toThrow("CHATGPT_MARKDOWN_PENDING_CODE");
    expect(
      render(
        element("div", [element("code", [])], {
          "data-markdown-copy": "code-block",
        }),
      ),
    ).toBe("```\n\n```");
  });
  it("keeps shared depth, traversal and code character limits in qualified wrappers", () => {
    const marked = (child: Element) =>
      element("div", [child], { "data-markdown-copy": "code-block" });
    expect(() =>
      render(marked(element("code", ["x".repeat(256 * 1_024 + 1)]))),
    ).toThrow("CHATGPT_MARKDOWN_LIMIT");
    let deep = element("code", ["bounded"]);
    for (let index = 0; index < 65; index++) deep = element("div", [deep]);
    expect(() => render(marked(deep))).toThrow("CHATGPT_MARKDOWN_LIMIT");
    expect(() =>
      render(
        marked(
          element(
            "code",
            Array.from({ length: 8_192 }, () => element("span", ["x"])),
          ),
        ),
      ),
    ).toThrow("CHATGPT_MARKDOWN_LIMIT");
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
