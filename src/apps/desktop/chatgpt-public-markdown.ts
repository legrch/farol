/**
 * Converts one already-correlated public DOM block, never a whole page or
 * conversation. The browser source must supply qualified visibility, stable
 * range identity, channel and completion evidence before feeding the semantic
 * reducer. This converter is not yet enabled in the live text-delta producer.
 */
export function publicMarkdownBlock(
  root: Element,
  visible: (element: Element) => boolean,
): string {
  const maximumCharacters = 256 * 1_024;
  let visited = 0;
  let characters = 0;
  const fail = (code: string): never => {
    throw new Error(code);
  };
  const bounded = (value: string): string => {
    if (value.length > maximumCharacters) fail("CHATGPT_MARKDOWN_LIMIT");
    return value;
  };
  const escape = (value: string) =>
    value
      .replace(/[\\`*_[\]<>#~]/gu, "\\$&")
      .replace(
        /^(\s*)([-+]|\d+[.)])(?=\s)/u,
        (_match, space: string, marker: string) =>
          `${space}${marker.slice(0, -1)}\\${marker.slice(-1)}`,
      );
  const omitted = new Set([
    "SCRIPT",
    "STYLE",
    "TEMPLATE",
    "NOSCRIPT",
    "BUTTON",
    "SVG",
    "INPUT",
    "TEXTAREA",
    "SELECT",
  ]);
  const rich = new Set([
    "IMG",
    "VIDEO",
    "AUDIO",
    "CANVAS",
    "IFRAME",
    "OBJECT",
    "EMBED",
  ]);
  const containers = new Set(["DIV", "SPAN", "SECTION"]);
  const blocks = new Set([
    "P",
    "DIV",
    "SECTION",
    "BLOCKQUOTE",
    "PRE",
    "UL",
    "OL",
    "TABLE",
    "HR",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
  ]);

  function children(element: Element, depth: number, literal: boolean): string {
    let result = "";
    for (const child of element.childNodes) {
      const part = render(child, depth + 1, literal);
      if (!part) continue;
      const block =
        !literal &&
        child.nodeType === 1 &&
        blocks.has((child as Element).tagName);
      if (block && result && !result.endsWith("\n\n")) result += "\n\n";
      result = bounded(result + part + (block ? "\n\n" : ""));
    }
    return result;
  }

  function table(element: Element, depth: number): string {
    const rows: string[][] = [];
    function collect(parent: Element, level: number): void {
      if (level > 64) fail("CHATGPT_MARKDOWN_LIMIT");
      for (const node of parent.childNodes) {
        if (++visited > 8_192) fail("CHATGPT_MARKDOWN_LIMIT");
        if (node.nodeType === 3 && !(node.nodeValue ?? "").trim()) continue;
        if (node.nodeType !== 1) fail("CHATGPT_MARKDOWN_TABLE_UNSUPPORTED");
        const child = node as Element;
        if (!visible(child)) continue;
        if (["THEAD", "TBODY", "TFOOT"].includes(child.tagName)) {
          collect(child, level + 1);
          continue;
        }
        if (child.tagName !== "TR") fail("CHATGPT_MARKDOWN_TABLE_UNSUPPORTED");
        const cells: string[] = [];
        for (const cellNode of child.childNodes) {
          if (++visited > 8_192) fail("CHATGPT_MARKDOWN_LIMIT");
          if (cellNode.nodeType === 3 && !(cellNode.nodeValue ?? "").trim())
            continue;
          if (cellNode.nodeType !== 1)
            fail("CHATGPT_MARKDOWN_TABLE_UNSUPPORTED");
          const cell = cellNode as Element;
          if (
            !visible(cell) ||
            !["TH", "TD"].includes(cell.tagName) ||
            (rows.length === 0 && cell.tagName !== "TH") ||
            ["colspan", "rowspan"].some(
              (attr) => ![null, "1"].includes(cell.getAttribute(attr)),
            )
          ) {
            fail("CHATGPT_MARKDOWN_TABLE_UNSUPPORTED");
          }
          cells.push(
            children(cell, level + 2, false)
              .trim()
              .replace(/\|/gu, "\\|")
              .replace(/\n/gu, "<br>"),
          );
        }
        if (
          !cells.length ||
          (rows.length > 0 && cells.length !== rows[0]!.length)
        )
          fail("CHATGPT_MARKDOWN_TABLE_UNSUPPORTED");
        rows.push(cells);
      }
    }
    collect(element, depth);
    if (!rows.length) fail("CHATGPT_MARKDOWN_TABLE_UNSUPPORTED");
    const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
    return bounded(
      [
        row(rows[0]!),
        row(rows[0]!.map(() => "---")),
        ...rows.slice(1).map(row),
      ].join("\n"),
    );
  }

  function render(node: Node, depth: number, literal = false): string {
    if (++visited > 8_192 || depth > 64) fail("CHATGPT_MARKDOWN_LIMIT");
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? "";
      characters += value.length;
      if (characters > maximumCharacters) fail("CHATGPT_MARKDOWN_LIMIT");
      return literal ? value : escape(value.replace(/\s+/gu, " "));
    }
    if (node.nodeType === 8) return "";
    if (node.nodeType !== 1)
      return fail("CHATGPT_MARKDOWN_STRUCTURE_UNSUPPORTED");
    const element = node as Element;
    const tag = element.tagName;
    // Do not read descendants of a hidden node or a control.
    if (omitted.has(tag) || !visible(element)) return "";
    if (rich.has(tag)) return fail("CHATGPT_MARKDOWN_RICH_OUTPUT_UNSUPPORTED");
    if (tag === "BR") return literal ? "\n" : "  \n";
    if (literal) {
      if (!["CODE", "SPAN"].includes(tag))
        return fail("CHATGPT_MARKDOWN_STRUCTURE_UNSUPPORTED");
      return children(element, depth, true);
    }
    if (tag === "PRE") {
      const code = children(element, depth, true);
      const runs = code.match(/`+/gu) ?? [];
      const fence = "`".repeat(
        Math.max(3, ...runs.map((run) => run.length + 1)),
      );
      const codeNode = [...element.childNodes].find(
        (child) =>
          child.nodeType === 1 &&
          (child as Element).tagName === "CODE" &&
          visible(child as Element),
      ) as Element | undefined;
      const language =
        codeNode
          ?.getAttribute("class")
          ?.match(/(?:^|\s)language-([A-Za-z0-9_+-]+)(?:\s|$)/u)?.[1] ?? "";
      return bounded(
        `${fence}${language}\n${code}${code.endsWith("\n") ? "" : "\n"}${fence}`,
      );
    }
    if (tag === "TABLE") return table(element, depth);
    if (tag === "HR") return "---";
    if (tag === "UL" || tag === "OL") {
      const start = element.getAttribute("start");
      let number = start === null ? 1 : Number(start);
      if (!Number.isSafeInteger(number) || number < 0 || number > 1_000_000)
        return fail("CHATGPT_MARKDOWN_STRUCTURE_UNSUPPORTED");
      const items: string[] = [];
      for (const child of element.childNodes) {
        if (++visited > 8_192) fail("CHATGPT_MARKDOWN_LIMIT");
        if (child.nodeType === 3 && !(child.nodeValue ?? "").trim()) continue;
        if (child.nodeType !== 1 || (child as Element).tagName !== "LI")
          return fail("CHATGPT_MARKDOWN_STRUCTURE_UNSUPPORTED");
        if (!visible(child as Element)) continue;
        if ((child as Element).getAttribute("value") !== null)
          return fail("CHATGPT_MARKDOWN_STRUCTURE_UNSUPPORTED");
        const content = children(child as Element, depth + 1, false)
          .trim()
          .replace(/\n\n(?=[-0-9])/gu, "\n");
        const marker = tag === "OL" ? `${number++}. ` : "- ";
        items.push(
          marker + content.replace(/\n/gu, `\n${" ".repeat(marker.length)}`),
        );
      }
      return bounded(items.join("\n"));
    }
    if (tag === "CODE") {
      const code = children(element, depth, true).replace(/\n/gu, " ");
      const fence = "`".repeat(
        Math.max(1, ...(code.match(/`+/gu) ?? []).map((run) => run.length + 1)),
      );
      const padding =
        code.startsWith("`") ||
        code.endsWith("`") ||
        (/^ .* $/u.test(code) && /\S/u.test(code))
          ? " "
          : "";
      return bounded(`${fence}${padding}${code}${padding}${fence}`);
    }
    if (
      !["A", "STRONG", "B", "EM", "I", "DEL", "S", "BLOCKQUOTE", "P"].includes(
        tag,
      ) &&
      !/^H[1-6]$/u.test(tag) &&
      !containers.has(tag)
    )
      return fail("CHATGPT_MARKDOWN_STRUCTURE_UNSUPPORTED");
    const content = children(element, depth, false);
    if (tag === "A") {
      const href = element.getAttribute("href");
      if (!href) return fail("CHATGPT_MARKDOWN_PENDING_LINK");
      if (href.length > 8_192 || /[\s<>\\]/u.test(href))
        return fail("CHATGPT_MARKDOWN_LINK_UNSUPPORTED");
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return fail("CHATGPT_MARKDOWN_LINK_UNSUPPORTED");
      }
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return fail("CHATGPT_MARKDOWN_LINK_UNSUPPORTED");
      return bounded(`[${content}](<${href}>)`);
    }
    if (tag === "STRONG" || tag === "B") return `**${content}**`;
    if (tag === "EM" || tag === "I") return `*${content}*`;
    if (tag === "DEL" || tag === "S") return `~~${content}~~`;
    if (/^H[1-6]$/u.test(tag))
      return `${"#".repeat(Number(tag[1]))} ${content.trim()}`;
    if (tag === "BLOCKQUOTE")
      return content
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    if (tag === "P" || containers.has(tag)) return content;
    return fail("CHATGPT_MARKDOWN_STRUCTURE_UNSUPPORTED");
  }
  return bounded(render(root, 0)).trim();
}
