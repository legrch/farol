// Test-only page client. It knows public DOM mechanics and currently available
// provider state, never the runner's script, barriers or expected future output.
const documentId = document.body.dataset.documentId;
const documentGeneration = Number(document.body.dataset.documentGeneration);
const conversationId = document.body.dataset.conversationId;
const identity = { documentId, documentGeneration, conversationId };
const composer = document.querySelector("#prompt-textarea");
const send = document.querySelector('[data-testid="send-button"]');
const stop = document.querySelector('[data-testid="stop-button"]');
const error = document.querySelector('[data-testid="network-error"]');
const output = document.querySelector("#conversation");
const model = document.querySelector(
  'button[aria-label="Select ChatGPT model"]',
);
const effort = document.querySelector(
  'button[aria-haspopup="menu"][data-tone="neutral"]',
);
const connector = document.querySelector('[data-testid="composer-app-chip"]');
let state = { turns: [] };
let submitting = false;
const publicSelection = () => ({
  model: model.innerText,
  effort: effort.innerText,
  connector: connector.hidden
    ? null
    : { id: connector.dataset.pluginId, label: connector.dataset.appName },
});
const busy = () => state.turns.some((turn) => !turn.renderedTerminal);
// This fixture editor contains only native text, DIV line blocks and BRs.
// Serialize its logical lines independently of the production draft reader.
const message = () =>
  Array.from(composer.childNodes, (node, index) => {
    if (node.nodeName === "DIV")
      return (
        (index > 0 ? "\n" : "") +
        (node.childNodes.length === 1 && node.firstChild.nodeName === "BR"
          ? ""
          : node.textContent)
      );
    if (node.nodeName === "BR")
      return composer.childNodes.length === 1 ? "" : "\n";
    return node.textContent;
  }).join("");
const updateSend = () => {
  send.disabled = submitting || busy() || message().length === 0;
};
const post = async (path, value) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...identity, ...value }),
  });
  if (!response.ok) throw new Error("Controlled provider request refused");
  return response.json();
};
const render = (next) => {
  if (
    next.documentGeneration !== documentGeneration ||
    next.conversationId !== conversationId
  )
    return;
  state = next;
  model.textContent = next.selection.model;
  effort.textContent = next.selection.effort;
  connector.hidden = next.selection.connector === null;
  if (next.selection.connector !== null) {
    connector.dataset.pluginId = next.selection.connector.id;
    connector.dataset.appName = next.selection.connector.label;
    connector.textContent = next.selection.connector.label;
  }
  const articles = [];
  for (const turn of next.turns) {
    const user = document.createElement("article");
    user.dataset.messageAuthorRole = "user";
    user.dataset.messageId = turn.userId;
    user.textContent = turn.prompt;
    articles.push(user);
    const article = document.createElement("article");
    const assistant = document.createElement("div");
    assistant.dataset.messageAuthorRole = "assistant";
    assistant.dataset.messageId = turn.replyId;
    assistant.dataset.parentMessageId = turn.userId;
    assistant.dataset.messageChannel = "final";
    assistant.dataset.isStreaming = String(!turn.renderedTerminal);
    const markdown = document.createElement("div");
    markdown.className = "markdown";
    // Synthetic profile: each published segment is immutable. Actual ChatGPT
    // DOM is not qualified by this fixture marker.
    markdown.dataset.farolSourceProfile =
      "farol-controlled-settled-segments-v1";
    for (const segment of turn.segments) {
      const paragraph = document.createElement("p");
      paragraph.dataset.segmentId = segment.id;
      paragraph.dataset.segmentState = "settled";
      paragraph.textContent = segment.text;
      markdown.append(paragraph);
    }
    assistant.append(markdown);
    article.append(assistant);
    if (turn.renderedTerminal) {
      const copy = document.createElement("button");
      copy.dataset.testid = "copy-turn-action-button";
      copy.textContent = "Copy";
      article.append(copy);
    }
    articles.push(article);
  }
  output.replaceChildren(...articles);
  stop.hidden = !busy();
  send.hidden = busy();
  updateSend();
  for (const turn of next.turns) {
    // This receipt is a page-render watermark only, never product persistence/ACK.
    void post("/fixtures/chatgpt/rendered", {
      replyId: turn.replyId,
      segmentIds: turn.segments.map((segment) => segment.id),
    }).catch(() => {});
  }
};
composer.addEventListener("input", updateSend);
send.addEventListener("click", async () => {
  if (send.disabled || submitting) return;
  submitting = true;
  error.hidden = true;
  updateSend();
  const previous = state.turns.at(-1);
  try {
    const result = await post("/fixtures/chatgpt/send", {
      message: message(),
      selection: publicSelection(),
      previousUserId: previous?.userId ?? null,
      previousReplyId: previous?.replyId ?? null,
    });
    if (!result.accepted)
      throw new Error("Controlled provider rejected submission");
    history.replaceState(null, "", `/chatgpt/c/${conversationId}`);
    composer.textContent = "";
  } catch {
    // A lost acknowledgement is displayed, never resent here.
    error.hidden = false;
  } finally {
    submitting = false;
    updateSend();
  }
});
stop.addEventListener("click", () => {
  const turn = state.turns.at(-1);
  if (turn)
    void post("/fixtures/chatgpt/stop", { replyId: turn.replyId }).catch(
      () => {},
    );
});
const query = new URLSearchParams({
  documentId,
  documentGeneration: String(documentGeneration),
  conversationId,
});
const events = new EventSource(`/fixtures/chatgpt/events?${query}`);
events.addEventListener("state", (event) => {
  render(JSON.parse(event.data));
});
window.addEventListener("pagehide", () => events.close(), { once: true });
