// Serialized with the physical page adapter; only public composer DOM is read.
export function physicalComposerDraft(composer: HTMLElement): string {
  if (composer instanceof HTMLTextAreaElement) return composer.value;
  const chipSelector =
    '[data-testid="composer-app-chip"],[data-testid*="app-mention"],[data-testid*="connector-chip"],[data-prompt-link-href^="app://asdk_app_"],a[href*="/plugins/plugin_asdk_app_"]';
  // Chromium inserts DIV/BR line blocks; paragraph editors use P. innerText
  // doubles empty-block breaks, while detached textContent loses all breaks.
  // Read these explicit editor shapes without changing the live DOM or chips.
  let nodes = 0;
  const read = (parent: HTMLElement, depth: number): string => {
    if (depth > 32) throw new Error("PHYSICAL_DRAFT_UNQUALIFIED");
    let text = "";
    let previousBlock = false;
    const children = [...parent.childNodes].filter(
      (node) => !(node instanceof HTMLElement && node.matches(chipSelector)),
    );
    for (const node of children) {
      if (++nodes > 8192) throw new Error("PHYSICAL_DRAFT_UNQUALIFIED");
      if (node.nodeType === 3) {
        if (!node.nodeValue) continue;
        if (previousBlock) text += "\n";
        text += node.nodeValue;
        previousBlock = false;
        continue;
      }
      if (!(node instanceof HTMLElement))
        throw new Error("PHYSICAL_DRAFT_UNQUALIFIED");
      const block = node.tagName === "DIV" || node.tagName === "P";
      if (
        !block &&
        !["BR", "SPAN", "B", "STRONG", "I", "EM", "CODE", "A"].includes(
          node.tagName,
        )
      )
        throw new Error("PHYSICAL_DRAFT_UNQUALIFIED");
      // A sole BR keeps an empty editor line selectable; it is not another line.
      const value =
        node.tagName === "BR"
          ? children.length === 1 &&
            (parent === composer ||
              parent.tagName === "DIV" ||
              parent.tagName === "P")
            ? ""
            : "\n"
          : read(node, depth + 1);
      if (
        (block && (text.length > 0 || previousBlock)) ||
        (!block && previousBlock)
      )
        text += "\n";
      text += value;
      previousBlock = block;
    }
    return text;
  };
  return read(composer, 0);
}
