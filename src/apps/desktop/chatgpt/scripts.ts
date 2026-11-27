// Page scripts injected into the ChatGPT page as source text. Pure string
// builders: no Electron, no state. Moved verbatim from chatgpt-route.ts.
import { publicMarkdownBlock } from "../chatgpt-public-markdown";
import {
  readPublicAssistantMessages,
  publicContentVisible,
} from "../chatgpt-public-turn";

export const MAX_PREPARED_COMPOSER_CHARACTERS = 128 * 1_024;

export const chatGptUsageLimitPattern =
  /(?:usage|message|rate)\s+limit|limit\s+(?:has\s+been\s+)?reached|reached\s+(?:your|the)\s+(?:usage|message|rate)?\s*limit|too\s+many\s+requests/iu;

export const SIGN_IN_RETURN_SENTINEL = "farol-sign-in-return-to-farol";

const SIGN_IN_BANNER_ID = "farol-sign-in-banner";

// Injected on every finish-load of the sign-in surface's main frame only
// (never a popup, and CSP does not apply to code injected this way — it
// runs directly in the page's V8 context via the same channel DevTools
// uses, not as a parsed <script> or inline-style attribute). Idempotent:
// a reload or SPA navigation calls this again and it leaves an existing
// banner alone.
export function signInBannerScript(title: string): string {
  const bannerId = JSON.stringify(SIGN_IN_BANNER_ID);
  const titleText = JSON.stringify(title);
  const sentinel = JSON.stringify(SIGN_IN_RETURN_SENTINEL);
  return `(() => {
    if (document.getElementById(${bannerId})) return;
    const bar = document.createElement("div");
    bar.id = ${bannerId};
    bar.setAttribute("role", "banner");
    bar.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 32px);padding:6px 6px 6px 12px;background:#111216;color:#f7f7f8;font:12px -apple-system,BlinkMacSystemFont,sans-serif;border:1px solid #333;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.35);box-sizing:border-box;";
    const label = document.createElement("span");
    label.textContent = ${titleText};
    label.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const returnButton = document.createElement("button");
    returnButton.type = "button";
    returnButton.textContent = "Return to Farol";
    returnButton.style.cssText = "flex:none;border:1px solid #4a4a52;border-radius:6px;padding:5px 12px;background:#1d1c21;color:#f7f7f8;font:inherit;cursor:pointer;";
    returnButton.addEventListener("click", () => {
      console.log(${sentinel});
    });
    bar.append(label, returnButton);
    document.documentElement.appendChild(bar);
  })()`;
}

// Idempotent removal, used when the same window transitions out of the
// sign-in surface (e.g. straight into a task) without ever closing.
export function signInBannerRemovalScript(): string {
  const bannerId = JSON.stringify(SIGN_IN_BANNER_ID);
  return `(() => {
    const bar = document.getElementById(${bannerId});
    if (bar) bar.remove();
  })()`;
}

// ChatGPT owns its sidebar. Ask its own visible control to collapse once per
// document; never hide provider content or keep toggling after the owner opens it.
export function collapseChatGptSidebarScript(): string {
  return `(() => {
    if (globalThis.__farolDefaultSidebarInitialized) return;
    globalThis.__farolDefaultSidebarInitialized = true;
    const labels = new Set(["Close sidebar", "Collapse sidebar", "Hide sidebar"]);
    const openLabels = new Set(["Open sidebar", "Show sidebar", "Expand sidebar"]);
    const cancelKey = "__farolDefaultSidebarCollapse";
    const previous = globalThis[cancelKey];
    if (typeof previous === "function") previous();
    const deadline = Date.now() + 12000;
    let lastAttempt = 0;
    let stopped = false;
    let timer;
    const ownerInputKinds = ["pointerdown", "pointerover", "pointermove", "keydown"];
    const ownerInput = (event) => { if (event.isTrusted) stop(); };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const kind of ownerInputKinds) document.removeEventListener(kind, ownerInput, true);
      if (globalThis[cancelKey] === stop) delete globalThis[cancelKey];
    };
    globalThis[cancelKey] = stop;
    for (const kind of ownerInputKinds) document.addEventListener(kind, ownerInput, true);
    timer = setInterval(() => {
      if (stopped) return;
      if (Date.now() > deadline) { stop(); return; }
      const close = [...document.querySelectorAll("button[aria-label]")].find(
        (candidate) => (labels.has(candidate.getAttribute("aria-label")) ||
            (candidate.getAttribute("aria-label") === "Toggle sidebar" &&
              (candidate.getAttribute("aria-expanded") === "true" ||
                candidate.closest?.('aside,nav,[data-testid="sidebar"],#stage-sidebar,#stage-slideover-sidebar')))) &&
          candidate.getAttribute("aria-expanded") !== "false" &&
          candidate.getClientRects().length > 0 &&
          !candidate.disabled
      );
      if (!close) {
        // ChatGPT currently calls this control "Show sidebar" and omits
        // aria-expanded. Stop after the first successful collapse; otherwise
        // a human's next click is immediately undone by this timer.
        const open = [...document.querySelectorAll("button[aria-label]")].some(
          (candidate) => openLabels.has(candidate.getAttribute("aria-label")) &&
            candidate.getClientRects().length > 0
        );
        if (open || lastAttempt > 0) stop();
        return;
      }
      // The first click can happen before ChatGPT hydrates its handler. Only
      // stop once its own controls confirm that the sidebar actually closed.
      if (Date.now() - lastAttempt < 500) return;
      lastAttempt = Date.now();
      close.click();
      // A synchronous provider update ends this timer immediately. Hydration
      // may still need a later tick, but any owner input cancels that retry.
      const collapsed = [...document.querySelectorAll("button[aria-label]")].some(
        (candidate) => openLabels.has(candidate.getAttribute("aria-label")) &&
          candidate.getClientRects().length > 0
      );
      if (collapsed) stop();
    }, 250);
  })()`;
}

export const toggleChatGptSidebarScript = `(() => {
  const cancel = globalThis.__farolDefaultSidebarCollapse;
  if (typeof cancel === "function") cancel();
  const labels = new Set(["Close sidebar", "Collapse sidebar", "Hide sidebar",
    "Open sidebar", "Show sidebar", "Expand sidebar", "Toggle sidebar"]);
  const button = [...document.querySelectorAll("button[aria-label]")].find(
    (candidate) => labels.has(candidate.getAttribute("aria-label")) &&
      candidate.getClientRects().length > 0 && !candidate.disabled);
  if (!button) return false;
  button.click();
  return true;
})()`;

// Connector checks must not inherit the owner's current conversation or model.
// These probes intentionally inspect provider controls instead of trusting a
// URL parameter or a saved ChatGPT preference as proof of the active mode.
// The provider includes its generation in the selected model label. Match
// only the whole Instant label, never a menu option or a Pro/Thinking label.
// The selected control can prefix that label with its "Thinking effort" heading.
export const instantModelLabelPattern =
  /^(?:(?:Thinking\s+effort|Reasoning\s+effort|Уровень\s+рассуждения|Уровень\s+усилий\s+рассуждения)\s+)?(?:(?:GPT[- ]?)?\d+(?:\.\d+)?\s+)?Instant$/iu;

// ChatGPT localizes accessibility labels and visible text, and its layout
// changes without notice (the header now offers a "Personalization" dropdown
// instead of Personalized/Unpersonalized buttons). A French or any other UI
// must work, so nothing below may be the only test of a safety property:
//   - Temporary chat is decided by the address (`temporary-chat=true`); the
//     badge or its label is never required.
//   - Personalization is optional. The legacy buttons are matched by their
//     text as a last resort, only to choose "Personalized" when they exist;
//     when they are absent or unrecognized the preparation goes on and says so.
//   - The model control is found by `data-testid`, its accessible name or a
//     menu button that shows a model name, and what it shows is read from its
//     selected value. "Instant" is a product name, not translated text.
// The label lists below are the last-resort fallback for those controls.
export const chatgptTemporaryToggleLabels = [
  "Turn off temporary chat",
  "Отключить временный чат",
  "Выключить временный чат",
  "Выйти из режима временного чата",
] as const;
const temporaryToggleLabels = chatgptTemporaryToggleLabels;
const personalizedLabels = [
  "Personalized",
  "С персонализацией",
  "Персонализированный",
] as const;
const unpersonalizedLabels = ["Unpersonalized", "Без персонализации"] as const;
// ChatGPT's home composer is still one visible text box, but it is no longer
// always #prompt-textarea inside a <form> that owns input[type=file].
const composerSelectors = [
  "#prompt-textarea",
  '[data-testid="prompt-textarea"]',
  '[contenteditable="true"][data-virtualkeyboard="true"]',
  '[contenteditable="true"][role="textbox"]',
] as const;
const composerSelectorList = composerSelectors.join(",");
const sendControlSelectors = [
  '[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[aria-label="Send"]',
  'button[aria-label="Отправить"]',
  'button[aria-label="Отправить сообщение"]',
  'button[aria-label="Отправить запрос"]',
] as const;
const stopControlSelectors = [
  '[data-testid="stop-button"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop"]',
  'button[aria-label="Остановить генерацию"]',
  'button[aria-label="Остановить"]',
] as const;
const labelledSignInPattern =
  /^(log in|sign in|sign up|войти|войти в аккаунт|регистрация)$/iu;
const pluginSectionLabels = ["Plugins", "Плагины"] as const;
const filesSectionLabels = ["Files", "Файлы"] as const;
const stopControlSelectorList = stopControlSelectors.join(",");
const selectedModelControlPredicate = `((button) => {
  const label = (button.innerText || "").trim();
  const aria = button.getAttribute("aria-label");
  return aria === "Select ChatGPT model" || aria === "Выбрать модель ChatGPT" ||
    aria === "Thinking effort" || aria === "Reasoning effort" ||
    aria === "Уровень рассуждения" || aria === "Уровень усилий рассуждения" ||
    button.getAttribute("data-testid") === "model-switcher-dropdown-button" ||
    (button.getAttribute("aria-haspopup") === "menu" &&
      /^(?:(?:Thinking\\s+effort|Reasoning\\s+effort|Уровень\\s+рассуждения|Уровень\\s+усилий\\s+рассуждения)\\s+)?(?:(?:GPT[- ]?)?\\d+(?:\\.\\d+)?\\s+)?(?:Instant|Thinking|Medium|High|Extra High|Pro(?: Standard| Extended)?)$/iu.test(label));
})`;

export const temporaryInstantProfileProbe = `(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  };
  const composer = [
    ${composerSelectors.map((selector) => `document.querySelector(${JSON.stringify(selector)})`).join(",\n    ")}
  ].find(visible);
  const draft = composer instanceof HTMLTextAreaElement
    ? composer.value
    : composer?.textContent || "";
  const controls = [...document.querySelectorAll("button")].filter(visible);
  // The address is the authority. A missing or renamed badge never decides it.
  const temporary = new URL(location.href).searchParams.get("temporary-chat") === "true";
  const personalized = controls.some((button) =>
    ${JSON.stringify(personalizedLabels)}.includes((button.textContent || "").trim()));
  const personalizationReady = controls.some((button) =>
    ${JSON.stringify([...personalizedLabels, ...unpersonalizedLabels])}.includes((button.textContent || "").trim()));
  const modelButtons = controls.filter((button) =>
    ${selectedModelControlPredicate}(button));
  const modelButton = modelButtons[0];
  const modelReady = modelButtons.length === 1 && !modelButton.disabled && modelButton.getAttribute("aria-disabled") !== "true";
  const instant = modelReady && new RegExp(${JSON.stringify(instantModelLabelPattern.source)}, "iu").test((modelButton.innerText || "").trim());
  // This is the selected public model control only. Retain a bounded label
  // solely when every token belongs to the known model vocabulary; redact
  // unrecognized text instead of emitting arbitrary provider content.
  const label = (modelButton?.innerText || "").trim();
  const visibleModelLabel = label.length <= 80 &&
    /(?:Instant|Thinking|Pro|Auto)/u.test(label) &&
    /^(?:(?:ChatGPT|GPT|Instant|Thinking|effort|Уровень|рассуждения|Pro|Auto|Fast)|[0-9.\\s\\p{Cf} -])+$/u.test(label) ? label : null;
  return { composerReady: !!composer, draftPresent: draft.trim().length > 0,
    temporary, personalized, personalizationReady, instant: !!instant, modelReady: !!modelReady, visibleModelLabel,
    modelControlCount: Math.min(modelButtons.length, 100),
    labelHasInstant: /Instant/u.test(label),
    labelHasThinkingEffort: /Thinking\\s*effort/iu.test(label),
    labelHasFormatMarks: /\\p{Cf}/u.test(label) };
})()`;

export const openInstantPowerPickerScript = `(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  };
  const buttons = [...document.querySelectorAll("button")].filter((button) =>
    ${selectedModelControlPredicate}(button) && visible(button));
  if (buttons.length !== 1 || buttons[0].disabled || buttons[0].getAttribute("aria-disabled") === "true") return false;
  buttons[0].click();
  return true;
})()`;

export const openTemporaryPersonalizationScript = `(() => {
  const buttons = [...document.querySelectorAll("button")].filter((candidate) =>
    ${JSON.stringify(unpersonalizedLabels)}.includes((candidate.textContent || "").trim()) &&
    candidate.getClientRects().length > 0 && !candidate.disabled);
  if (buttons.length !== 1) return false;
  buttons[0].click();
  return true;
})()`;

export const selectTemporaryPersonalizationScript = `(() => {
  const options = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"],[role="option"]')]
    .filter((candidate) => ${JSON.stringify(personalizedLabels)}.some((label) =>
      (candidate.textContent || "").trim().startsWith(label)) &&
      candidate.getClientRects().length > 0);
  if (options.length !== 1) return false;
  options[0].click();
  return true;
})()`;

export const focusInstantPowerSliderScript = `(() => {
  const slider = [...document.querySelectorAll('[role="slider"],input[type="range"]')]
    .find((element) => element.getClientRects().length > 0);
  if (!(slider instanceof HTMLElement)) return { ready: false };
  const minimum = Number(slider.getAttribute("aria-valuemin") ?? (slider instanceof HTMLInputElement ? slider.min : ""));
  const current = Number(slider.getAttribute("aria-valuenow") ?? (slider instanceof HTMLInputElement ? slider.value : ""));
  if (!Number.isFinite(minimum) || !Number.isFinite(current)) return { ready: false };
  slider.focus();
  return { ready: true, atMinimum: current === minimum };
})()`;

// Native sendInputEvent requires an active BrowserWindow. Connection checks
// also run in background views, so address the page's own keyboard handlers.
// Neither acknowledgement is model proof: the caller rereads the slider and
// visible Instant label on the original document before preparing any message.
export const lowerInstantPowerSliderScript = `(() => {
  const sliders = [...document.querySelectorAll('[role="slider"],input[type="range"]')]
    .filter((element) => element.getClientRects().length > 0);
  if (sliders.length !== 1) return false;
  const slider = sliders[0];
  if (!(slider instanceof HTMLElement)) return false;
  slider.focus();
  slider.dispatchEvent(new KeyboardEvent("keydown", {
    key: "ArrowLeft", code: "ArrowLeft", bubbles: true, cancelable: true
  }));
  slider.dispatchEvent(new KeyboardEvent("keyup", {
    key: "ArrowLeft", code: "ArrowLeft", bubbles: true, cancelable: true
  }));
  return true;
})()`;

export const dismissInstantPowerPickerScript = `(() => {
  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", code: "Escape", bubbles: true, cancelable: true
  }));
  return true;
})()`;

// Read-only. "held" when the current composer holds anything the owner could
// lose by leaving the page (typed text, a staged attachment or file), or cannot
// be read as empty; "clean" otherwise. The connection check asks this before
// it navigates anywhere, and never again types over or clears what it finds.
export function composerHoldsContentProbe(appName: string): string {
  return `(() => {
    ${appSelectionPrelude(appName)}
    ${manualDeepTestDraftGuard("", "return 'held';", "initial", undefined, true)}
    return 'clean';
  })()`;
}

export const activityProbe = `(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  };
  const running = ${JSON.stringify([...stopControlSelectors])}
    .map((selector) => document.querySelector(selector)).some(visible);
  return { running };
})()`;

// A cancellation is bound to one document and one main-frame path. The path
// is the whole address of the page (origin and path, no query or fragment), not
// the canonical conversation address: that one is null for a custom GPT, a
// project conversation, the home page and a new chat, which would then all
// "match" one another. The first script reads the path and stamps the window
// in one step, out of sight on `window`; every later script requires both, so
// a single-page navigation (the path moves) and a reload (the stamp is gone)
// each leave a script refusing instead of acting on another page.
const cancelDocumentKey = 'Symbol.for("farol.cancel.document")';
const cancelSpentKey = 'Symbol.for("farol.cancel.spent")';
// The page-turn epoch of this window: a counter that only increases. Every
// Route B turn advances the route's counter when it is admitted and stamps the
// new value here before its first effect on the page; nothing clears it, so
// "no turn" is never a value of its own. A window that never saw a stamp (a
// new document, a Browser task) reads 0. The click script cannot see the main
// process's idea of the turn, so it reads this one.
const cancelTurnKey = 'Symbol.for("farol.cancel.turn")';
const pageTurnExpression = `(Object.prototype.hasOwnProperty.call(window, ${cancelTurnKey}) ? window[${cancelTurnKey}] : 0)`;

/** Marks this window with the page-turn epoch `epoch`; it never moves back. */
export function stampTurnScript(epoch: number): string {
  return `(() => {
  if (${pageTurnExpression} < ${JSON.stringify(epoch)}) Object.defineProperty(window, ${cancelTurnKey}, { value: ${JSON.stringify(epoch)}, configurable: true });
  return true;
})()`;
}
const cancelPathExpression =
  '(location.origin + location.pathname).replace(/\\/+$/u, "")';

/** The path a cancellation binds: the page's origin and path, no trailing slash. */
export function cancelBindingPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/u, "");
  } catch {
    return null;
  }
}

// Stamps the window with `token` and answers the path it is on, but only
// while the page is still on `expectedPath`: the path the caller captured when
// the Cancel started, or the one the turn in flight relies on. A page on any
// other path is refused untouched (`navigated`), before any stamp. The path is
// never read from the page here, so a navigation between the start of the
// Cancel and this script cannot become the binding.
//
// The page-turn epoch is bound the same way: a page already marked with a
// later epoch than the Cancel started on belongs to a later turn and is
// refused untouched. A page marked with an earlier epoch, or never marked (a
// new document), is marked with the Cancel's: the epoch only moves up, and
// every later script requires the page to read exactly that value.
export function cancelBindScript(
  expectedPath: string,
  token: string,
  epoch: number,
): string {
  return `(() => {
  const path = ${cancelPathExpression};
  if (path !== ${JSON.stringify(expectedPath)}) return { navigated: true };
  const pageEpoch = ${pageTurnExpression};
  if (pageEpoch > ${JSON.stringify(epoch)}) return { navigated: true };
  if (pageEpoch < ${JSON.stringify(epoch)}) Object.defineProperty(window, ${cancelTurnKey}, { value: ${JSON.stringify(epoch)}, configurable: true });
  Object.defineProperty(window, ${cancelDocumentKey}, { value: ${JSON.stringify(token)}, configurable: true });
  return { bound: true, path };
})()`;
}

// The page's own refusal: the path, the stamp or the page-turn epoch differs,
// so this is not the document and turn the cancellation was bound to. Nothing
// is touched.
const cancelDocumentGuard = (
  path: string,
  documentToken: string,
  epoch: number,
): string =>
  `${cancelPathExpression} !== ${JSON.stringify(path)} || window[${cancelDocumentKey}] !== ${JSON.stringify(documentToken)} || ${pageTurnExpression} !== ${JSON.stringify(epoch)}`;

// Clicks the stop control only while the page is still the bound document,
// still carries the page-turn epoch the Cancel started on (`epoch`; a Cancel
// that started with no turn in flight holds the epoch of the last one, so a
// successor that came and went is a different epoch), this attempt has not
// been used and `expiresAt` (wall-clock ms) has not passed. The checks run inside the renderer, immediately before the click:
// the main process cannot see a navigation, a reload or a delay that happens
// after it sent the script. The attempt is spent before anything is looked
// for, so a script that runs a second time never clicks. An expired script
// answers `{ expired: true }` and a page that moved `{ navigated: true }`;
// either way nothing is touched.
export function cancelTaskScript(
  path: string,
  documentToken: string,
  attemptToken: string,
  epoch: number,
  expiresAt: number,
): string {
  return `(() => {
  if (Date.now() > ${JSON.stringify(expiresAt)}) return { expired: true };
  if (${cancelDocumentGuard(path, documentToken, epoch)}) return { navigated: true };
  if (!Object.prototype.hasOwnProperty.call(window, ${cancelSpentKey})) Object.defineProperty(window, ${cancelSpentKey}, { value: {}, configurable: true });
  const spent = window[${cancelSpentKey}];
  if (spent[${JSON.stringify(attemptToken)}] === true) return { navigated: true };
  spent[${JSON.stringify(attemptToken)}] = true;
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  };
  const stop = ${JSON.stringify([...stopControlSelectors])}
    .map((selector) => document.querySelector(selector))
    .find((element) => visible(element) && element instanceof HTMLButtonElement && !element.disabled);
  if (!(stop instanceof HTMLButtonElement)) return { activated: false };
  stop.click();
  return { activated: true };
})()`;
}

// The activity probe, for confirming a stop: another document is never an
// answer about the task that was stopped, so it says `{ navigated: true }`.
export function cancelConfirmationProbe(
  path: string,
  documentToken: string,
  epoch: number,
): string {
  return `(() => {
  if (${cancelDocumentGuard(path, documentToken, epoch)}) return { navigated: true };
  return ${activityProbe};
})()`;
}

export const readinessProbe = `(() => {
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  };
  const composer = [...document.querySelectorAll(${JSON.stringify(composerSelectorList)})].some(visible);
  const explicitSignIn = [
    document.querySelector('[data-testid="login-button"]'),
    document.querySelector('a[href*="/auth/login"]'),
    document.querySelector('button[name="login"]')
  ].some(visible);
  const labelledSignIn = [...document.querySelectorAll("a,button")]
    .some((element) => visible(element) && ${labelledSignInPattern}.test((element.textContent || "").trim()));
  return { composerVisible: composer, signInVisible: explicitSignIn || labelledSignIn };
})()`;

function appSelectionPrelude(appName: string): string {
  return `
    const requiredAppName = ${JSON.stringify(appName)};
    const appElementVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const findComposer = () => [
      ${composerSelectors.map((selector) => `document.querySelector(${JSON.stringify(selector)})`).join(",\n      ")}
    ].find(appElementVisible);
    const selectedSelector = [
      '[data-testid="composer-app-chip"]',
      '[data-testid*="app-mention"]',
      '[data-testid*="connector-chip"]',
      '[data-prompt-link-href^="app://asdk_app_"]'
    ].join(",");
    const normalizedLabel = (element) => {
      const raw = (
        element.getAttribute("data-app-name") ||
        element.getAttribute("aria-label") ||
        element.textContent ||
        ""
      ).trim();
      return raw
        .replace(/^(?:remove|удалить)\\s+/iu, "")
        .replace(/^app:\\s*/iu, "")
        .replace(/^@/u, "")
        .replace(/\\s+button$/iu, "")
        .trim();
    };
    const exactPickerOption = (option) => {
      if (!(option instanceof HTMLElement) || !appElementVisible(option)) return false;
      if (normalizedLabel(option) === requiredAppName) return true;
      // ChatGPT's picker puts the app description in the option's text.
      // Require a separately rendered exact title, never a text prefix.
      return [...option.querySelectorAll("[data-app-name],[aria-label],span,div,strong")]
        .some((part) => appElementVisible(part) && normalizedLabel(part) === requiredAppName);
    };
    const appSelectionFor = (input) => {
      if (!(input instanceof HTMLElement)) return { state: "missing" };
      const root = input.closest("form") || input.parentElement || input;
      const pluginIdentity = (element) => {
        const promptLink = element.getAttribute("data-prompt-link-href") || "";
        const promptMatch = /^app:\\/\\/(asdk_app_[A-Za-z0-9]+)$/u.exec(promptLink);
        if (promptMatch) return "plugin_" + promptMatch[1];
        const marked = element.getAttribute("data-plugin-id") ||
          element.getAttribute("data-app-id");
        if (marked && /^plugin_asdk_app_[A-Za-z0-9]+$/u.test(marked)) return marked;
        const href = element.getAttribute("href") || "";
        // ChatGPT can change the chip's origin query after the picker closes.
        // Its exact plugin path inside the composer is the durable identity;
        // the query describes how the details page was opened, not selection.
        const match = /^\\/plugins\\/(plugin_asdk_app_[A-Za-z0-9]+)(?:[?#]|$)/u.exec(href);
        return match?.[1] ?? null;
      };
      const selectedLinks = [...input.querySelectorAll('a[href*="/plugins/plugin_asdk_app_"]')]
        .filter((link) => pluginIdentity(link) !== null && appElementVisible(link));
      const markerCandidates = [...root.querySelectorAll(selectedSelector)]
        .filter((element) => appElementVisible(element) &&
          (element.getAttribute("data-prompt-link-href") === null ||
            pluginIdentity(element) !== null));
      const raw = [...new Set([...markerCandidates, ...selectedLinks])];
      const markers = raw.filter((candidate, index) =>
        !raw.some((other, otherIndex) => {
          if (other === candidate) return false;
          if (other.contains(candidate)) return true;
          const crossRepresentation =
            (markerCandidates.includes(candidate) && selectedLinks.includes(other)) ||
            (selectedLinks.includes(candidate) && markerCandidates.includes(other));
          const identity = pluginIdentity(candidate);
          return otherIndex < index && crossRepresentation && identity !== null &&
            identity === pluginIdentity(other);
        })
      );
      const labels = markers.map(normalizedLabel).filter(Boolean);
      const targetCount = labels.filter((label) => label === requiredAppName).length;
      if (targetCount === 1 && labels.length === 1) return { state: "bound" };
      if (targetCount > 1 || labels.length > 1) return { state: "ambiguous" };
      if (labels.length === 1) return { state: "conflict" };
      return { state: "missing" };
    };
    const appSelection = () => appSelectionFor(findComposer());
    const composerDraftText = (input) => {
      if (!(input instanceof HTMLElement)) return "";
      if (input instanceof HTMLTextAreaElement) return input.value;
      const clone = input.cloneNode(true);
      if (!(clone instanceof HTMLElement)) return "";
      for (const marker of clone.querySelectorAll(selectedSelector)) marker.remove();
      const text = clone.innerText || clone.textContent || "";
      // ChatGPT can render the selected app as a plugin link inside the
      // contenteditable while keeping its selection marker beside it. The
      // link alone is not an owner draft; any additional text still blocks.
      if (text.trim() === requiredAppName && appSelectionFor(input).state === "bound") {
        const exactLinks = [...input.querySelectorAll('a[href*="/plugins/plugin_asdk_app_"]')]
          .filter((link) => appElementVisible(link) && normalizedLabel(link) === requiredAppName);
        if (exactLinks.length === 1) return "";
      }
      return text;
    };
    const composerPlaceholderText = (input) => {
      if (!(input instanceof HTMLElement)) return "";
      return (
        input.getAttribute("placeholder") ||
        input.getAttribute("aria-placeholder") ||
        input.querySelector("[data-placeholder]")?.getAttribute("data-placeholder") ||
        ""
      ).trim();
    };
  `;
}

export function bindChatGptAppScript(
  appName: string,
  expectedHref: string,
  manualDeepTest = false,
): string {
  return `(async () => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    if (location.href !== expectedHref) return { state: "navigated" };
    ${appSelectionPrelude(appName)}
    ${manualDeepTest ? manualDeepTestDraftGuard("", 'return { state: "blocked", reason: "draft_present" };') : ""}
    const input = findComposer();
    if (!(input instanceof HTMLElement)) return { state: "blocked", reason: "missing" };
    if (composerDraftText(input).trim().length > 0) {
      return { state: "blocked", reason: "draft_present" };
    }
    const current = appSelectionFor(input);
    if (current.state === "bound") return { state: "bound" };
    if (current.state === "ambiguous" || current.state === "conflict") {
      return { state: "blocked", reason: current.state };
    }
    const setComposerText = (value, inputType) => {
      if (input instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        if (!setter) return false;
        setter.call(input, value);
      } else {
        input.replaceChildren(document.createTextNode(value));
      }
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: value,
        inputType
      }));
      return true;
    };
    input.focus();
    const pickerQuery = "@" + requiredAppName;
    const pickerInputAccepted = input instanceof HTMLTextAreaElement
      ? setComposerText(pickerQuery, "insertText")
      : typeof document.execCommand === "function" &&
        document.execCommand("insertText", false, pickerQuery);
    if (!pickerInputAccepted) {
      return { state: "blocked", reason: "missing" };
    }
    const pickerOptions = () => {
      const pickerRoots = [...document.querySelectorAll([
        '[role="listbox"]',
        '[role="menu"]',
        '[data-radix-menu-content]',
        '[data-testid*="mention"]',
        '[data-testid*="app-picker"]'
      ].join(","))].filter(appElementVisible);
      let optionCandidates = [...new Set(pickerRoots.flatMap((root) =>
        [...root.querySelectorAll('[role="option"],[role="menuitem"],button')]
      ))].filter(exactPickerOption);
      if (optionCandidates.length !== 0) return optionCandidates;
      // ChatGPT also renders the mention picker as plain divs. Only use
      // its visible Plugins section next to this composer; never click an
      // arbitrary matching title elsewhere in the conversation.
      const composerRect = input.getBoundingClientRect();
      const nearComposer = (element) => {
        if (!appElementVisible(element) || input.contains(element)) return false;
        const rect = element.getBoundingClientRect();
        return rect.right > composerRect.left && rect.left < composerRect.right &&
          rect.top > composerRect.top - 400 &&
          rect.bottom < composerRect.bottom + 450;
      };
      // The current ChatGPT picker exposes the app row as a plain button
      // without a menu/listbox root. Match that exact row near the composer;
      // never select a similarly named control inside a conversation.
      const buttonOptions = [...document.querySelectorAll('button,[role="option"],[role="menuitem"]')]
        .filter((element) => element instanceof HTMLElement &&
          nearComposer(element) &&
          !element.closest('[data-message-author-role],article,[role="article"]') &&
          exactPickerOption(element));
      if (buttonOptions.length !== 0) return buttonOptions;
      const labels = [...document.querySelectorAll("span,div,strong")]
        .filter((element) => element instanceof HTMLElement && nearComposer(element));
      const pickerRootFor = (element) => {
        if (element.closest('[data-message-author-role],article,[role="article"]')) {
          return null;
        }
        for (let parent = element.parentElement; parent && parent !== document.body;
          parent = parent.parentElement) {
          if (parent.matches?.('[data-message-author-role],article,[role="article"]')) {
            return null;
          }
          const position = getComputedStyle(parent).position;
          if (position !== "absolute" && position !== "fixed") continue;
          const box = parent.getBoundingClientRect();
          return appElementVisible(parent) && !parent.contains(input) &&
            box.width <= Math.max(720, composerRect.width * 1.25) && box.height <= 600
            ? parent : null;
        }
        return null;
      };
      const unclippedInPicker = (element, pickerRoot) => {
        const title = element.getBoundingClientRect();
        const clips = (overflow) => /^(auto|scroll|hidden|clip)$/u.test(overflow || "");
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const box = parent.getBoundingClientRect();
          if (clips(style.overflowY) &&
            (title.top < box.top || title.bottom > box.bottom)) return false;
          if (clips(style.overflowX) &&
            (title.left < box.left || title.right > box.right)) return false;
          if (parent === pickerRoot) return true;
        }
        return false;
      };
      const pluginHeadings = ${JSON.stringify([...pluginSectionLabels])};
      const fileSectionHeadings = ${JSON.stringify([...filesSectionLabels])};
      const headings = labels.filter((element) => pluginHeadings.includes(normalizedLabel(element)) &&
        pickerRootFor(element) !== null);
      const fileHeadings = labels.filter((element) =>
        fileSectionHeadings.includes(normalizedLabel(element)));
      optionCandidates = labels.filter((element) =>
        normalizedLabel(element) === requiredAppName &&
        ![...element.children].some((child) => normalizedLabel(child) === requiredAppName) &&
        headings.some((heading) => {
          const pickerRoot = pickerRootFor(heading);
          if (pickerRoot === null || pickerRootFor(element) !== pickerRoot ||
            !unclippedInPicker(element, pickerRoot)) return false;
          const header = heading.getBoundingClientRect();
          const title = element.getBoundingClientRect();
          const nextFilesTop = Math.min(...fileHeadings
            .filter((files) => pickerRootFor(files) === pickerRoot)
            .map((files) => files.getBoundingClientRect().top)
            .filter((top) => top > header.bottom), Infinity);
          const popup = pickerRoot.getBoundingClientRect();
          // Inspect the whole bounded Plugins section, including later rows.
          // A first-row cutoff misses both valid apps and duplicate exact names.
          return header.bottom <= title.top + 8 && title.bottom <= nextFilesTop &&
            title.top >= popup.top && title.bottom <= popup.bottom &&
            title.left >= popup.left && title.right <= popup.right &&
            Math.abs(title.left - header.left) <= 180;
        })
      );
      return optionCandidates;
    };
    let optionCandidates = [];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (location.href !== expectedHref) return { state: "navigated" };
      if (appSelectionFor(input).state === "bound") return { state: "bound" };
      const draft = input instanceof HTMLTextAreaElement
        ? input.value
        : (input.innerText || input.textContent || "");
      if (draft.trim() !== pickerQuery) {
        return { state: "blocked", reason: "draft_present" };
      }
      optionCandidates = pickerOptions();
      if (optionCandidates.length > 0) break;
    }
    if (optionCandidates.length !== 1) {
      const draft = input instanceof HTMLTextAreaElement
        ? input.value
        : (input.innerText || input.textContent || "");
      if (draft.trim() === pickerQuery) setComposerText("", "deleteContentBackward");
      return {
        state: "blocked",
        reason: optionCandidates.length > 1 ? "ambiguous" : "missing"
      };
    }
    optionCandidates[0].click();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (location.href !== expectedHref) return { state: "navigated" };
      const selected = appSelection();
      if (selected.state === "bound") return { state: "bound" };
      if (selected.state === "ambiguous" || selected.state === "conflict") {
        return { state: "blocked", reason: selected.state };
      }
    }
    const textAfterSelection = input instanceof HTMLTextAreaElement
      ? input.value
      : (input.innerText || input.textContent || "");
    if (textAfterSelection.trim() === "@" + requiredAppName) {
      setComposerText("", "deleteContentBackward");
    }
    return { state: "blocked", reason: "selection_not_observed" };
  })()`;
}

export function verifyChatGptAppScript(
  appName: string,
  expectedHref: string,
): string {
  return `(() => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    if (location.href !== expectedHref) return { state: "navigated" };
    ${appSelectionPrelude(appName)}
    const selected = appSelection();
    return selected.state === "bound"
      ? { state: "bound" }
      : { state: "blocked", reason: selected.state };
  })()`;
}

export function installManualAppGateScript(appName: string): string {
  return `(() => {
    ${appSelectionPrelude(appName)}
    const showBlockedNotice = (reason) => {
      const noticeId = "farol-dev-app-submit-blocked";
      let notice = document.getElementById(noticeId);
      if (!(notice instanceof HTMLElement)) {
        notice = document.createElement("div");
        notice.id = noticeId;
        notice.setAttribute("role", "alert");
        notice.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:12px 14px;background:#241b0f;color:#fff4df;border:1px solid #b98230;border-radius:10px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35)";
        document.documentElement.appendChild(notice);
      }
      notice.textContent = reason === "ambiguous"
        ? "Message blocked before send. Keep exactly one @" + requiredAppName + " app chip, then try again."
        : reason === "conflict"
          ? "Message blocked before send. Remove the other selected app and select @" + requiredAppName + "."
          : "Message blocked before send. Select exactly one @" + requiredAppName + " app, then try again.";
      setTimeout(() => notice?.remove(), 6000);
    };
    const blockUnlessBound = (event, composer) => {
      const selection = appSelectionFor(composer);
      if (selection.state === "bound") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      showBlockedNotice(selection.state);
    };
    const fallbackComposerSelector = [
      "textarea",
      '[contenteditable="true"]',
      '[role="textbox"][aria-multiline="true"]'
    ].join(",");
    const fallbackComposerIn = (root) =>
      [...root.querySelectorAll(fallbackComposerSelector)].find(appElementVisible);
    const submissionComposerIn = (root) => {
      const input = findComposer();
      if (input instanceof HTMLElement && root.contains(input)) return input;
      return fallbackComposerIn(root);
    };
    const allowDirectFormSubmission = (form) => {
      const composer = submissionComposerIn(form);
      if (!(composer instanceof HTMLElement)) return true;
      const selection = appSelectionFor(composer);
      if (selection.state === "bound") return true;
      showBlockedNotice(selection.state);
      return false;
    };
    const originalSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function (...args) {
      if (!allowDirectFormSubmission(this)) return undefined;
      return Reflect.apply(originalSubmit, this, args);
    };
    const originalRequestSubmit = HTMLFormElement.prototype.requestSubmit;
    if (typeof originalRequestSubmit === "function") {
      HTMLFormElement.prototype.requestSubmit = function (...args) {
        if (!allowDirectFormSubmission(this)) return undefined;
        return Reflect.apply(originalRequestSubmit, this, args);
      };
    }
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest("button");
      const form = button?.closest("form");
      const knownSend = target.closest(${JSON.stringify(sendControlSelectors.join(","))});
      const knownCancel = target.closest(${JSON.stringify(stopControlSelectorList)});
      const formComposer = form instanceof HTMLFormElement
        ? submissionComposerIn(form)
        : null;
      const formButton =
        form instanceof HTMLFormElement &&
        button instanceof HTMLButtonElement &&
        form.contains(button) &&
        formComposer instanceof HTMLElement;
      const pickerChoice = target.closest('[role="option"],[role="menuitem"]');
      const exactRequiredAppChoice =
        pickerChoice instanceof HTMLElement &&
        exactPickerOption(pickerChoice);
      const appChipRepair = target.closest(selectedSelector);
      if (
        knownCancel ||
        exactRequiredAppChoice ||
        (appChipRepair instanceof HTMLElement && !knownSend)
      ) {
        return;
      }
      if (knownSend || formButton) {
        blockUnlessBound(
          event,
          form instanceof HTMLFormElement ? formComposer : findComposer()
        );
      }
    }, true);
    document.addEventListener("submit", (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const composer = submissionComposerIn(form);
      if (composer instanceof HTMLElement) {
        blockUnlessBound(event, composer);
      }
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const input = findComposer();
      const target = event.target instanceof Element
        ? event.target
        : event.target instanceof Node && event.target.parentElement instanceof Element
          ? event.target.parentElement
          : null;
      const form = target?.closest("form");
      const fallbackInput = form instanceof HTMLFormElement
        ? submissionComposerIn(form)
        : target?.closest(fallbackComposerSelector);
      if (event.target instanceof Node) {
        const submissionInput = input && input.contains(event.target)
          ? input
          : fallbackInput instanceof HTMLElement && fallbackInput.contains(event.target)
            ? fallbackInput
            : null;
        if (submissionInput instanceof HTMLElement) {
          blockUnlessBound(event, submissionInput);
        }
      }
    }, true);
    // Deliberately install again after each observed navigation. A marker in
    // the provider page's own global object could be forged before Farol's
    // first injection and turn idempotence into a send bypass. Duplicate
    // capture guards are fail-closed: the first refusal stops later handlers,
    // while a bound submission passes every identical check.
    return true;
  })()`;
}

// Both submission scripts take the page identity the caller validated and
// compare it against the page's own location as their first act: the main
// process cannot check anything between dispatching a script and the script
// running, so the last check before typing or clicking happens in-page.
// Exported for the in-page navigation-guard tests (S35-H2-4), which
// evaluate these exact source strings in `node:vm` against a stub page:
// the guard has to be proven on the bytes that are dispatched, not on a
// paraphrase of them.
function manualDeepTestDraftGuard(
  expectedText: string,
  refusal = "return { draftPresent: true };",
  mode: "initial" | "exact" = "initial",
  expectedExpression?: string,
  // Connection Ping must survive ChatGPT renaming composer chrome. Draft text,
  // attachments and a missing composer still refuse. Deep test stays strict.
  relaxUnknownControls = false,
): string {
  return `
    const manualComposer = findComposer();
    const manualForm = manualComposer instanceof HTMLElement ? manualComposer.closest('form') : null;
    // Ping may run on the home composer, which has no <form> and no file input.
    // Walk up to the toolbar that holds the add-files button and look there.
    const manualShell = manualForm || ${
      relaxUnknownControls
        ? `(manualComposer instanceof HTMLElement ? (() => {
      let node = manualComposer.parentElement;
      for (let depth = 0; node && depth < 8; depth += 1) {
        if (node.querySelector('button,input[type="file"]')) return node;
        node = node.parentElement;
      }
      return manualComposer.parentElement;
    })() : null)`
        : "null"
    };
    const manualScope = ${relaxUnknownControls ? "manualShell" : "manualForm"};
    const manualVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const manualInputs = manualScope ? [...document.querySelectorAll('input[type="file"]')]
      .filter((element) => manualScope.contains(element) || element.form === manualForm) : [];
    const manualComposers = [...new Set(document.querySelectorAll(${JSON.stringify(composerSelectorList)}))].filter(manualVisible);
    const manualAttachments = manualScope ? [...manualScope.querySelectorAll(
      '[data-testid="attachment-preview"],[data-testid="composer-attachment"],[data-testid*="file-chip"],[data-testid*="attachment-chip"]'
    )].some(manualVisible) || [...manualScope.querySelectorAll('[aria-label]')].some((element) =>
      manualVisible(element) && /remove file|remove attachment|удалить файл|удалить вложение/iu.test(element.getAttribute('aria-label') || '')) : true;
    const manualAllowedLabels = new Set(['Add files', 'Add files and more', 'Select ChatGPT model', 'Thinking effort', 'Reasoning effort', 'Dictate', 'Start Voice', 'Start voice mode', 'Start Voice Mode', 'Start voice conversation', 'Expand', 'Send prompt', 'Send message', 'Send', 'Добавить файлы', 'Добавить файлы и другое', 'Выбрать модель ChatGPT', 'Уровень рассуждения', 'Уровень усилий рассуждения', 'Диктовка', 'Диктовать', 'Начать голосовой режим', 'Начать голосовой разговор', 'Развернуть', 'Отправить', 'Отправить сообщение', 'Отправить запрос']);
    const manualControlSelector = 'button,[role="button"],input[type="button"],input[type="submit"]';
    const manualUnknownControls = ${
      relaxUnknownControls
        ? "false"
        : `manualForm ? [...new Set([
      ...manualForm.querySelectorAll(manualControlSelector),
      ...[...document.querySelectorAll(manualControlSelector)].filter((element) => element.form === manualForm)
    ])]
      .filter(manualVisible).some((element) =>
        !element.closest(selectedSelector) &&
        element.getAttribute('data-testid') !== 'send-button' &&
        !manualAllowedLabels.has(element.getAttribute('aria-label'))) : true`
    };
    const manualUnknownImage = manualScope ? [...manualScope.querySelectorAll('img,video,audio')]
      .filter(manualVisible).some((element) => !element.closest(selectedSelector)) : true;
    let manualText = composerDraftText(manualComposer);
    ${
      relaxUnknownControls
        ? `if (manualText.trim() === composerPlaceholderText(manualComposer) && composerPlaceholderText(manualComposer) !== "") manualText = "";`
        : ""
    }
    const manualExpected = ${expectedExpression ?? JSON.stringify(expectedText)};
    if (manualComposer instanceof HTMLElement && !(manualComposer instanceof HTMLTextAreaElement) &&
        appSelectionFor(manualComposer).state === 'bound') {
      const liveLinks = [...manualComposer.querySelectorAll('a[href*="/plugins/plugin_asdk_app_"]')]
        .filter((link) => appElementVisible(link) && normalizedLabel(link) === requiredAppName);
      if (liveLinks.length === 1) {
        const clone = manualComposer.cloneNode(true);
        if (clone instanceof HTMLElement) {
          for (const marker of clone.querySelectorAll(selectedSelector)) marker.remove();
          const clonedLinks = [...clone.querySelectorAll('a[href*="/plugins/plugin_asdk_app_"]')]
            .filter((link) => normalizedLabel(link) === requiredAppName);
          if (clonedLinks.length === 1) clonedLinks[0].remove();
          if (clonedLinks.length <= 1) manualText = clone.innerText || clone.textContent || '';
        }
      }
    }
    if (!(manualComposer instanceof HTMLElement) || !manualScope || manualComposers.length !== 1 || manualComposers[0] !== manualComposer || ${relaxUnknownControls ? "false" : "manualInputs.length === 0"} || manualAttachments || manualUnknownControls || manualUnknownImage ||
        manualInputs.some((input) => !(input instanceof HTMLInputElement) || !input.files || input.files.length > 0) ||
        ${
          mode === "initial"
            ? `!(manualText === '' || (
          manualComposer instanceof HTMLElement && !(manualComposer instanceof HTMLTextAreaElement) &&
          appSelectionFor(manualComposer).state === 'bound' &&
          [...manualComposer.querySelectorAll(selectedSelector + ',a[href*="/plugins/plugin_asdk_app_"]')]
            .some((element) => appElementVisible(element)) && manualText.trim() === ''
        ))`
            : "manualText !== manualExpected"
        })
      ${refusal}
  `;
}

export function prepareTaskScript(
  prompt: string,
  expectedHref: string,
  requiredAppName?: string,
  guard?: Readonly<{ deadlineAt: number; budgetMs: number }>,
  manualDeepTest = false,
  relaxUnknownControls = false,
): string {
  // Two bounds, and the script refuses when either is reached. The wall
  // instant (main's Date.now at dispatch plus the time left) also counts the
  // time the script waited in the page's queue before it ran; the budget, a
  // duration on the page's own monotonic clock from the instant the script
  // starts, still holds when the page's wall clock steps backwards while it
  // runs. A forward wall step can only make the script refuse early, which
  // leaves the composer untouched.
  if (
    guard !== undefined &&
    (!Number.isSafeInteger(guard.deadlineAt) ||
      guard.deadlineAt <= 0 ||
      !Number.isFinite(guard.budgetMs) ||
      guard.budgetMs < 0)
  )
    throw new Error("Invalid task preparation deadline");
  const expired = (): string =>
    guard === undefined
      ? ""
      : `if (Date.now() >= ${guard.deadlineAt} || performance.now() - preparationStartedAt >= ${guard.budgetMs}) return { ready: false };`;
  return `(() => {
    ${guard === undefined ? "" : `const preparationStartedAt = performance.now(); ${expired()}`}
    const expectedHref = ${JSON.stringify(expectedHref)};
    if (location.href !== expectedHref) return { navigated: true };
    const prompt = ${JSON.stringify(prompt)};
    ${requiredAppName ? appSelectionPrelude(requiredAppName) : ""}
    ${requiredAppName ? 'if (appSelection().state !== "bound") return { appSelectionLost: true };' : ""}
    ${manualDeepTest && requiredAppName ? manualDeepTestDraftGuard("", undefined, "initial", undefined, relaxUnknownControls) : ""}
    ${
      manualDeepTest && requiredAppName
        ? `const manualInitialText = manualText;
    if (manualInitialText.length + prompt.length > ${MAX_PREPARED_COMPOSER_CHARACTERS}) return { draftPresent: true };`
        : ""
    }
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const composer = [
      ${composerSelectors.map((selector) => `document.querySelector(${JSON.stringify(selector)})`).join(",\n      ")}
    ].find(visible);
    const baselineAssistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
    const baselineUserCount = document.querySelectorAll('[data-message-author-role="user"]').length;
    const baselineMessageIds = [...new Set(
      [...document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')]
        .map((element) => element.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null)
        .filter((value) => typeof value === 'string' && value.length > 0 && value.length <= 256)
    )].slice(-512);
    if (!(composer instanceof HTMLElement)) {
      return { ready: false, baselineAssistantCount, baselineUserCount, baselineMessageIds };
    }
    ${requiredAppName ? "if (composerDraftText(composer).trim().length > 0) return { draftPresent: true };" : ""}
    ${expired()}
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) return { ready: false, baselineAssistantCount, baselineUserCount };
      setter.call(composer, prompt);
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: prompt,
        inputType: "insertText"
      }));
    } else {
      ${
        requiredAppName
          ? `
      // Editing a live ChatGPT composer by appending a DOM node bypasses its
      // editor state and can detach the selected app on the next render.
      const range = document.createRange();
      const selection = document.getSelection();
      if (!selection || typeof document.execCommand !== "function") {
        return { ready: false, baselineAssistantCount, baselineUserCount, baselineMessageIds };
      }
      range.selectNodeContents(composer);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      if (!document.execCommand("insertText", false, prompt)) {
        return { ready: false, baselineAssistantCount, baselineUserCount, baselineMessageIds };
      }
      `
          : `
      composer.replaceChildren(document.createTextNode(prompt));
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: prompt,
        inputType: "insertText"
      }));`
      }
    }
    ${
      manualDeepTest && requiredAppName
        ? `{
      if (appSelection().state !== "bound") return { appSelectionLost: true };
      ${manualDeepTestDraftGuard("", undefined, "exact", "manualInitialText + prompt", relaxUnknownControls)}
      return { ready: true, baselineAssistantCount, baselineUserCount, baselineMessageIds, preparedComposerText: manualText };
    }`
        : ""
    }
    return { ready: true, baselineAssistantCount, baselineUserCount, baselineMessageIds };
  })()`;
}

export function activateTaskScript(
  expectedHref: string,
  requiredAppName?: string,
  requireTemporaryInstant = false,
  requireOrdinaryInstant = false,
  manualDeepTestPrompt?: string,
  explicitConnectionCheck = false,
): string {
  return `(() => {
    const expectedHref = ${JSON.stringify(expectedHref)};
    if (location.href !== expectedHref) return { navigated: true };
    ${
      requireTemporaryInstant
        ? `if (new URL(location.href).searchParams.get("temporary-chat") !== "true" ||
      // Exactly one model control, showing Instant. The ordinary task routes
      // refuse a page without one; the connection check does not use this.
      ((models) => models.length !== 1 ||
        !new RegExp(${JSON.stringify(instantModelLabelPattern.source)}, "iu").test((models[0].innerText || "").trim()))(
        [...document.querySelectorAll("button")].filter((button) =>
          ${selectedModelControlPredicate}(button) && button.getClientRects().length > 0)))
      return { profileLost: true };`
        : ""
    }
    ${
      requireOrdinaryInstant
        ? `if (new URL(location.href).searchParams.has("temporary-chat") ||
      [...document.querySelectorAll("button")].some((button) =>
        ${JSON.stringify(temporaryToggleLabels)}.includes(button.getAttribute("aria-label")) && button.getClientRects().length > 0) ||
      ((models) => models.length !== 1 ||
        !new RegExp(${JSON.stringify(instantModelLabelPattern.source)}, "iu").test((models[0].innerText || "").trim()))(
        [...document.querySelectorAll("button")].filter((button) =>
          ${selectedModelControlPredicate}(button) && button.getClientRects().length > 0)))
      return { profileLost: true };`
        : ""
    }
    ${requiredAppName ? appSelectionPrelude(requiredAppName) : ""}
    ${requiredAppName ? 'if (appSelection().state !== "bound") return { appSelectionLost: true };' : ""}
    ${manualDeepTestPrompt !== undefined && requiredAppName ? manualDeepTestDraftGuard(manualDeepTestPrompt, undefined, "exact", undefined, explicitConnectionCheck) : ""}
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const send = ${JSON.stringify(sendControlSelectors)}.map((selector) => document.querySelector(selector))
      .find((element) => visible(element) && element instanceof HTMLButtonElement && !element.disabled);
    if (!(send instanceof HTMLButtonElement)) return { activated: false };
    ${manualDeepTestPrompt !== undefined && requiredAppName ? "if (send.form !== manualForm) return { draftPresent: true };" : ""}
    ${explicitConnectionCheck ? `if ([...document.querySelectorAll(${JSON.stringify(stopControlSelectorList)})].some(visible)) return { activated: false };` : ""}
    send.click();
    return { activated: true };
  })()`;
}

export function taskProbeScript(
  prompt: string,
  baselineMessageIds: readonly string[],
  output: Readonly<{
    semantic: boolean;
    userId: string | null;
    assistantId: string | null;
  }> = { semantic: false, userId: null, assistantId: null },
  requiredAppName?: string,
): string {
  return `(() => {
    const prompt = ${JSON.stringify(prompt)};
    const output = ${JSON.stringify(output)};
    const markdown = ${publicMarkdownBlock.toString()};
    const readMessages = ${readPublicAssistantMessages.toString()};
    const contentVisible = ${publicContentVisible.toString()};
    const baselineMessageIds = new Set(${JSON.stringify(baselineMessageIds)});
    const requiredAppName = ${JSON.stringify(requiredAppName ?? null)};
    const usageLimitPattern = new RegExp(${JSON.stringify(chatGptUsageLimitPattern.source)}, ${JSON.stringify(chatGptUsageLimitPattern.flags)});
    const visible = (element) => {
      if (!contentVisible(element)) return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const messages = [...document.querySelectorAll('[data-message-author-role="user"],[data-message-author-role="assistant"]')];
    const assistants = messages.filter((element) => element.getAttribute('data-message-author-role') === 'assistant');
    const messageId = (element) => element?.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null;
    const users = messages.filter((element) => element.getAttribute('data-message-author-role') === 'user');
    const candidates = users.filter((element) => {
      const id = messageId(element);
      if (!(output.semantic ? contentVisible(element) : visible(element)) || id === null) return false;
      // A retained identity wins over repeated text during resumed observation.
      // Before correlation, preserve onboarding's exact app-prefixed prompt form.
      if (output.userId !== null) return id === output.userId;
      if (baselineMessageIds.has(id)) return false;
      const rendered = (element.innerText || '').trim();
      if (rendered === prompt.trim()) return true;
      // App chips may be represented differently in textContent and innerText.
      // This extra form is scoped to the exact app required by this route.
      const appRendered = (element.textContent || rendered).trim();
      return requiredAppName !== null && appRendered.startsWith(requiredAppName) &&
        appRendered.slice(requiredAppName.length).trim() === prompt.trim();
    });
    if (candidates.length > 1) throw new Error("CHATGPT_PUBLIC_USER_AMBIGUOUS");
    const currentUser = candidates[0] ?? null;
    const turnUserId = messageId(currentUser);
    let currentAssistant = null;
    const turnAssistants = [];
    if (currentUser && turnUserId !== null) {
      const userIndex = messages.indexOf(currentUser);
      for (const element of messages.slice(userIndex + 1)) {
        const role = element.getAttribute('data-message-author-role');
        if (role === 'user') break;
        if (role !== 'assistant' || !(output.semantic ? contentVisible(element) : visible(element))) continue;
        const id = messageId(element);
        if (id === null) {
          if (output.semantic) throw new Error("CHATGPT_PUBLIC_SOURCE_UNANCHORED");
          continue;
        }
        const parentId = element.closest('[data-parent-message-id]')?.getAttribute('data-parent-message-id') ?? null;
        if (!output.semantic && parentId !== null && parentId !== turnUserId) continue;
        turnAssistants.push(element);
        currentAssistant ??= element;
      }
    }
    const turnAssistantId = turnUserId === null ? null : (output.semantic ? output.assistantId ?? messageId(currentAssistant) : messageId(currentAssistant));
    const explicitSignIn = [
      document.querySelector('[data-testid="login-button"]'),
      document.querySelector('a[href*="/auth/login"]'),
      document.querySelector('button[name="login"]')
    ].some(visible);
    const labelledSignIn = [...document.querySelectorAll("a,button")]
      .some((element) => visible(element) && ${labelledSignInPattern}.test((element.textContent || "").trim()));
    const busy = ${JSON.stringify([...stopControlSelectors])}
      .map((selector) => document.querySelector(selector)).some(visible);
    const sendVisible = ${JSON.stringify(sendControlSelectors)}.map((selector) => document.querySelector(selector)).some(visible);
    const errors = [
      document.querySelector('[data-testid="conversation-turn-error"]'),
      document.querySelector('[data-testid="network-error"]'),
      document.querySelector('[data-testid="usage-limit-message"]'),
      document.querySelector('[data-testid="rate-limit-error"]'),
      ...document.querySelectorAll('[role="alert"]')
    ].filter(visible);
    const usageLimited = errors.some((element) =>
      usageLimitPattern.test((element.textContent || "").trim())
    );
    const errorVisible = errors.length > 0;
    const publicMessages = output.semantic && currentUser ? readMessages(turnAssistants, contentVisible, markdown, visible) : null;
    const assistantText = !output.semantic && currentAssistant instanceof HTMLElement ? currentAssistant.innerText : "";
    return {
      ...(publicMessages ? {publicFrame: {
        userId: turnUserId,
        messages: publicMessages,
        terminal: publicMessages.length > 0 && publicMessages.every((message) => message.complete) &&
          publicMessages.at(-1).channel === "answer" && !busy && sendVisible
      }} : {}),
      assistantCount: assistants.length,
      assistantCharacters: assistantText.length,
      assistantText,
      userCount: document.querySelectorAll('[data-message-author-role="user"]').length,
      turnUserId,
      turnAssistantId,
      busy,
      sendVisible,
      signInVisible: explicitSignIn || labelledSignIn,
      errorVisible,
      errorKind: usageLimited ? "usage_limited" : errorVisible ? "generic" : "none"
    };
  })()`;
}
