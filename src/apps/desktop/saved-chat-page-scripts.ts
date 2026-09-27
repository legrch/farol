// These scripts run only in the isolated Next ChatGPT partition. They return
// content-free observations; page probes return no prompt or account text.

const visible = `const visible = (element) => {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
};`;

const composer = `const composer = [
  document.querySelector("#prompt-textarea"),
  document.querySelector('[data-testid="prompt-textarea"]'),
  document.querySelector('[contenteditable="true"][data-virtualkeyboard="true"]')
].find(visible);
const composerText = () => composer instanceof HTMLTextAreaElement
  ? composer.value : (composer?.innerText ?? composer?.textContent ?? "");`;

const emptyNormal = `const normalEmpty = () =>
  location.href === expectedHref &&
  new URL(location.href).searchParams.get("temporary-chat") !== "true" &&
  ![...document.querySelectorAll("button")].some((button) =>
    visible(button) && button.getAttribute("aria-label") === "Turn off temporary chat") &&
  document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]').length === 0 &&
  composer instanceof HTMLElement && composerText() === "";`;

const digest = `const sha256 = async (value) => {
  const bytes = new TextEncoder().encode(value.replace(/\\r\\n?/g, "\\n"));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};`;

export function savedChatReadinessScript(expectedHref: string): string {
  return `(() => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    ${visible}
    ${composer}
    ${emptyNormal}
    return { ready: normalEmpty() };
  })()`;
}

export function savedChatInsertScript(
  expectedHref: string,
  message: string,
): string {
  return `(() => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    const message = ${JSON.stringify(message)};
    ${visible}
    ${composer}
    ${emptyNormal}
    if (!normalEmpty()) return { inserted: false };
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) return { inserted: false };
      setter.call(composer, message);
    } else {
      composer.replaceChildren(document.createTextNode(message));
    }
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true, data: message, inputType: "insertText"
    }));
    return { inserted: true };
  })()`;
}

/** Hash check and single click are one page operation; an unknown answer is never retried. */
export function savedChatSubmitScript(
  expectedHref: string,
  expectedDigest: string,
): string {
  return `(async () => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    const expectedDigest = ${JSON.stringify(expectedDigest)};
    ${visible}
    ${composer}
    ${digest}
    const safe = () => location.href === expectedHref &&
      new URL(location.href).searchParams.get("temporary-chat") !== "true" &&
      ![...document.querySelectorAll("button")].some((button) =>
        visible(button) && button.getAttribute("aria-label") === "Turn off temporary chat") &&
      document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]').length === 0 &&
      composer instanceof HTMLElement;
    if (!safe()) return { clicked: false };
    const text = composerText();
    if (await sha256(text) !== expectedDigest || !safe() || composerText() !== text)
      return { clicked: false };
    if (location.href !== expectedHref ||
        new URL(location.href).searchParams.get("temporary-chat") === "true" ||
        [...document.querySelectorAll("button")].some((button) =>
          visible(button) && button.getAttribute("aria-label") === "Turn off temporary chat") ||
        document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]').length !== 0 ||
        !(composer instanceof HTMLElement))
      return { clicked: false };
    const send = [
      document.querySelector('[data-testid="send-button"]'),
      document.querySelector('button[aria-label="Send prompt"]'),
      document.querySelector('button[aria-label="Send message"]'),
      document.querySelector('button[aria-label="Send"]')
    ].find((element) => visible(element) && element instanceof HTMLButtonElement && !element.disabled);
    if (!(send instanceof HTMLButtonElement)) return { clicked: false };
    send.click();
    return { clicked: true };
  })()`;
}

/** A fresh helper must also prove an exact visible history entry. */
export function savedChatProofScript(
  expectedHref: string,
  firstMessageDigest: string,
  titleDigest: string,
  requireHistory: boolean,
): string {
  return `(async () => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    const firstMessageDigest = ${JSON.stringify(firstMessageDigest)};
    const titleDigest = ${JSON.stringify(titleDigest)};
    const requireHistory = ${JSON.stringify(requireHistory)};
    ${visible}
    ${digest}
    if (location.href !== expectedHref) return { verified: false, titleVerified: false };
    const messages = [...document.querySelectorAll('[data-message-author-role="user"]')].filter(visible);
    if (messages.length !== 1 || await sha256(messages[0].innerText ?? messages[0].textContent ?? "") !== firstMessageDigest)
      return { verified: false, titleVerified: false };
    const expectedPath = new URL(expectedHref).pathname;
    const historyRoots = [...document.querySelectorAll('[data-testid="history"],nav[aria-label="Chat history"],nav[aria-label="History"]')].filter(visible);
    const history = [...new Set(historyRoots.flatMap((root) => [...root.querySelectorAll('a[href]')]))].filter((link) => {
      if (!visible(link)) return false;
      try {
        const target = new URL(link.href, location.href);
        return target.origin === new URL(expectedHref).origin &&
          target.pathname === expectedPath && !target.search && !target.hash;
      }
      catch { return false; }
    });
    if (requireHistory && history.length !== 1)
      return { verified: false, titleVerified: false };
    return {
      verified: true,
      titleVerified: history.length === 1 &&
        await sha256(history[0].innerText ?? history[0].textContent ?? "") === titleDigest
    };
  })()`;
}
