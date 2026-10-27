import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { startControlledChatGptSite } from "./chatgpt-controlled-site.mjs";

// Legacy mode is a render-delayed complete-answer fixture. Its retained full
// answer is not generation-paused evidence. Controlled mode uses server barriers.
export async function startChatGptFixture(options = {}) {
  assert.ok(
    Object.keys(options).every((key) =>
      ["controlledScenario", "setupVerification"].includes(key),
    ),
    "FIXTURE_OPTIONS_INVALID",
  );
  assert.ok(
    !(options.controlledScenario && options.setupVerification),
    "FIXTURE_MODES_CONFLICT",
  );
  if (options.controlledScenario !== undefined)
    return startControlledChatGptSite(options.controlledScenario);
  const setup = options.setupVerification;
  if (setup)
    assert.ok(
      typeof setup.appName === "string" &&
        /^[A-Za-z0-9 ]{1,64}$/u.test(setup.appName) &&
        typeof setup.verify === "function",
      "SETUP_FIXTURE_INVALID",
    );
  if (setup?.readinessDelayMs !== undefined)
    assert.ok(
      Number.isSafeInteger(setup.readinessDelayMs) &&
        setup.readinessDelayMs >= 0 &&
        setup.readinessDelayMs <= 5000,
      "SETUP_FIXTURE_READINESS_DELAY_INVALID",
    );
  const fixture = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/setup-verify" && setup) {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 8192) {
          response.writeHead(413).end();
          return;
        }
      }
      try {
        const input = JSON.parse(body);
        assert.equal(typeof input.prompt, "string");
        await setup.verify(input.prompt);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end('{"verified":true}');
      } catch {
        response
          .writeHead(409, { "content-type": "application/json" })
          .end('{"verified":false}');
      }
      return;
    }
    if (pathname === "/chatgpt-popup") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'",
      });
      response.end(`<!doctype html>
        <html><head><meta charset="utf-8"><title>ChatGPT popup fixture</title>
        <style>body{background:#111216;color:#f7f7f8;font:16px sans-serif;padding:32px}</style></head>
        <body><p data-testid="popup-ready">Secure popup ready</p></body></html>`);
      return;
    }
    // Simulates an MFA-style "Next" step: a same-origin (e2e-allowed) form
    // navigation to a second page, proving the sign-in surface's policy
    // lets that ordinary step proceed rather than silently doing nothing
    // (UX34-07's fixture test).
    if (pathname === "/chatgpt-next") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'",
      });
      response.end(`<!doctype html>
        <html><head><meta charset="utf-8"><title>ChatGPT next-step fixture</title>
        <style>body{background:#111216;color:#f7f7f8;font:16px sans-serif;padding:32px}</style></head>
        <body><p data-testid="next-page-ready">Next step reached</p></body></html>`);
      return;
    }
    if (
      !(setup && pathname === "/") &&
      pathname !== "/chatgpt" &&
      !/^\/chatgpt\/c\/[A-Za-z0-9-]{8,128}\/?$/u.test(pathname)
    ) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found\n");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" +
        (setup ? "; connect-src 'self'" : ""),
    });
    response.end(`<!doctype html>
      <html><head><meta charset="utf-8"><title>ChatGPT readiness fixture</title>
      <style>body{background:#111216;color:#f7f7f8;font:16px sans-serif;padding:32px}button,#prompt-textarea{min-width:280px;min-height:44px}.message{white-space:pre-wrap;margin:18px 0}.attachment-chip{display:inline-block;margin:8px;padding:6px 10px;border:1px solid #555;border-radius:8px}</style></head>
      <body>
        <button data-testid="login-button" type="button">Log in</button>
        <button data-testid="popup-button" type="button">Open login popup</button>
        <button data-testid="expire-button" type="button" hidden>Expire session</button>
        <button data-testid="blocked-nav-button" type="button">Navigate off-policy</button>
        <button data-testid="next-page-button" type="button">Next</button>
        ${setup && new URL(request.url, "http://127.0.0.1").searchParams.get("temporary-chat") === "true" ? `<button type="button" aria-label="Turn off temporary chat">Temporary chat</button><button type="button">Personalized</button>` : ""}
        ${setup ? `<button type="button" aria-label="Select ChatGPT model" onclick="document.querySelector('#setup-model-power').hidden=false"><span style="display:block">Thinking effort</span><span style="display:block">6 Instant</span></button><input id="setup-model-power" type="range" min="0" max="2" value="0" hidden><span data-testid="composer-app-chip" data-plugin-id="plugin_asdk_app_SetupFixture" data-app-name="${setup.appName}">${setup.appName}</span>` : ""}
        <div id="prompt-textarea" contenteditable="true" data-virtualkeyboard="true" aria-label="Message" hidden></div>
        <input data-testid="attachment-input" type="file" multiple hidden />
        <div id="attachment-chips"></div>
        <p data-testid="attachment-upload-error" hidden>Failed to upload attachment</p>
        <button data-testid="send-button" type="button" disabled hidden>Send</button>
        <button data-testid="stop-button" type="button" hidden>Stop</button>
        <section id="conversation"></section>
        <script>
          // UX34 self-deception guard fixture (test-only): ?cover=1 adds a
          // full-viewport overlay at the same maximal z-index the injected
          // return banner uses, counting its own clicks. Equal
          // z-index falls back to DOM order, and the banner is injected
          // later (on did-finish-load), so the overlay re-appends itself
          // whenever a sibling is added, keeping it the topmost element.
          if (new URLSearchParams(location.search).get('cover') === '1') {
            const overlay = document.createElement('div');
            overlay.id = 'e2e-cover-overlay';
            overlay.dataset.testid = 'cover-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent;';
            window.__farolCoverClicks = 0;
            overlay.addEventListener('click', () => {
              window.__farolCoverClicks += 1;
            });
            document.documentElement.appendChild(overlay);
            new MutationObserver(() => {
              if (document.documentElement.lastElementChild !== overlay) {
                document.documentElement.appendChild(overlay);
              }
            }).observe(document.documentElement, { childList: true });
          }
          const login = document.querySelector('[data-testid="login-button"]');
          const popup = document.querySelector('[data-testid="popup-button"]');
          const expire = document.querySelector('[data-testid="expire-button"]');
          const composer = document.querySelector('#prompt-textarea');
          const attachmentInput = document.querySelector('[data-testid="attachment-input"]');
          const attachmentChips = document.querySelector('#attachment-chips');
          const attachmentError = document.querySelector('[data-testid="attachment-upload-error"]');
          const send = document.querySelector('[data-testid="send-button"]');
          const stop = document.querySelector('[data-testid="stop-button"]');
          const conversation = document.querySelector('#conversation');
          const requestedTask = new URLSearchParams(location.search).get('farol-e2e-task');
          const pathParts = location.pathname.split('/').filter(Boolean);
          const existingConversationId = pathParts.length === 3 && pathParts[0] === 'chatgpt' && pathParts[1] === 'c'
            ? pathParts[2]
            : null;
          const conversationId = existingConversationId || requestedTask || 'farol-e2e';
          const conversationPath = '/chatgpt/c/' + conversationId;
          const conversationStorageKey = 'farol-e2e-conversation:' + conversationPath;
          const messageSequenceStorageKey = 'farol-e2e-message-sequence:' + conversationPath;
          window.__farolTaskProgress = [];
          window.__farolSubmitCount = 0;
          window.__farolAttachmentProof = [];
          let attachmentLoading = false;
          let responseGeneration = 0;
          // Delay hydration of an already signed-in document, not the initial
          // interactive sign-in transition exercised by the setup harness.
          const readinessDelay = localStorage.getItem('farol-e2e-authenticated') === '1'
            ? ${setup?.readinessDelayMs ?? 0} : 0;
          const readinessDeadline = Date.now() + readinessDelay;
          const updateSend = () => {
            send.disabled = composer.textContent.trim().length === 0 || attachmentLoading;
          };
          const render = () => {
            const authenticated = localStorage.getItem('farol-e2e-authenticated') === '1';
            login.hidden = authenticated;
            expire.hidden = !authenticated;
            composer.hidden = !authenticated || Date.now() < readinessDeadline;
            send.hidden = !authenticated || Date.now() < readinessDeadline;
          };
          setTimeout(() => render(), readinessDelay);
          const restoreConversation = () => {
            if (location.pathname !== conversationPath) return;
            try {
              const saved = JSON.parse(localStorage.getItem(conversationStorageKey) || 'null');
              if (!saved || typeof saved.user !== 'string' || typeof saved.assistant !== 'string') return;
              const user = document.createElement('article');
              user.className = 'message';
              user.dataset.messageAuthorRole = 'user';
              user.dataset.messageId = saved.userMessageId || 'user-' + conversationId + '-restored';
              user.textContent = saved.user;
              const assistant = document.createElement('article');
              assistant.className = 'message';
              assistant.dataset.messageAuthorRole = 'assistant';
              assistant.dataset.messageId = saved.assistantMessageId || 'assistant-' + conversationId + '-restored';
              assistant.dataset.parentMessageId = user.dataset.messageId;
              assistant.textContent = saved.assistant;
              conversation.append(user, assistant);
            } catch {
              localStorage.removeItem(conversationStorageKey);
            }
          };
          popup.addEventListener('click', () => window.open('/chatgpt-popup', 'chatgpt-auth'));
          document.querySelector('[data-testid="blocked-nav-button"]').addEventListener('click', () => {
            location.href = 'https://example.invalid/blocked';
          });
          document.querySelector('[data-testid="next-page-button"]').addEventListener('click', () => {
            location.href = '/chatgpt-next';
          });
          composer.addEventListener('input', () => {
            updateSend();
          });
          attachmentInput.addEventListener('change', async () => {
            attachmentLoading = true;
            attachmentError.hidden = true;
            attachmentChips.replaceChildren();
            window.__farolAttachmentProof = [];
            updateSend();
            const files = [...(attachmentInput.files || [])];
            for (const file of files) {
              const bytes = new Uint8Array(await file.arrayBuffer());
              let binary = '';
              for (const byte of bytes) binary += String.fromCharCode(byte);
              window.__farolAttachmentProof.push({
                name: file.name,
                type: file.type,
                size: file.size,
                base64: btoa(binary)
              });
              const chip = document.createElement('span');
              chip.className = 'attachment-chip';
              chip.dataset.testid = 'attachment-chip';
              chip.textContent = file.name;
              attachmentChips.append(chip);
            }
            attachmentLoading = false;
            updateSend();
          });
          login.addEventListener('click', () => {
            localStorage.setItem('farol-e2e-authenticated', '1');
            render();
          });
          expire.addEventListener('click', () => {
            localStorage.removeItem('farol-e2e-authenticated');
            render();
          });
          stop.addEventListener('click', () => {
            responseGeneration += 1;
            stop.hidden = true;
            send.hidden = false;
            send.disabled = true;
          });
          document.addEventListener('keydown', event => { if (event.key === 'Escape') { const slider=document.querySelector('#setup-model-power'); if(slider) slider.hidden=true; } });
          send.addEventListener('click', async () => {
            if (send.disabled) return;
            const activeGeneration = ++responseGeneration;
            window.__farolSubmitCount += 1;
            const storedMessageSequence = Number(localStorage.getItem(messageSequenceStorageKey) || '0');
            const messageSequence = Number.isSafeInteger(storedMessageSequence) && storedMessageSequence >= 0
              ? storedMessageSequence + 1
              : 1;
            localStorage.setItem(messageSequenceStorageKey, String(messageSequence));
            if (location.pathname === '/chatgpt' || location.pathname === '/') {
              history.replaceState(null, '', conversationPath);
            }
            send.disabled = true;
            send.hidden = true;
            const userText = composer.textContent;
            const user = document.createElement('article');
            user.className = 'message';
            user.dataset.messageAuthorRole = 'user';
            user.dataset.messageId = 'user-' + conversationId + '-' + messageSequence;
            user.textContent = userText;
            const assistant = document.createElement('article');
            assistant.className = 'message';
            assistant.dataset.messageAuthorRole = 'assistant';
            assistant.dataset.messageId = 'assistant-' + conversationId + '-' + messageSequence;
            assistant.dataset.parentMessageId = user.dataset.messageId;
            conversation.append(user, assistant);
            composer.textContent = '';
            attachmentInput.value = '';
            attachmentChips.replaceChildren();
            stop.hidden = false;
            const contextSummary = userText.startsWith('Preserve the current task context for a safe continuation.');
            const checkpoint = {
              goal: 'Complete the context continuity acceptance safely.',
              activeConstraints: [
                'Keep every change local until owner review.',
                'Never publish, push, sign, or release.'
              ],
              latestCorrections: ['Use report-v2.md; report-v1.md is obsolete.'],
              keyDecisions: ['Observe unknown external effects before another mutation.'],
              completedWork: [{
                description: 'Retained the completed local checkpoint receipt.',
                evidenceRefs: ['receipt-context-epoch-1']
              }],
              unfinishedWork: ['Confirm the host handoff and continue safely.'],
              unresolvedQuestions: ['Did the unknown external operation complete?'],
              unknownOutcomes: [{
                operationRef: 'context-unknown-1',
                description: 'The external effect remains unknown and must not be repeated.'
              }],
              artifactRefs: [{
                reference: 'artifact:report-v2.md',
                availability: 'available'
              }],
              attachmentRefs: [{
                reference: 'attachment:context-evidence-1',
                availability: 'unavailable'
              }],
              nextSafeStep: 'Confirm the exact host context, then observe the unknown operation.'
            };
            if (${Boolean(setup)}) {
              try {
                const result = await fetch('/setup-verify', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({prompt:userText}) });
                if (!result.ok) throw new Error('Synthetic connector check refused');
              } catch {
                assistant.textContent = 'Synthetic connector check refused.';
                stop.hidden = true; send.hidden = false; send.disabled = false;
                return;
              }
            }
            const chunks = contextSummary
              ? [JSON.stringify(checkpoint)]
              : [
                  'The selected file reports a bounded workspace verification. ',
                  'It contains one concrete status line. ',
                  'Action: keep the read-only boundary in place.'
                ];
            localStorage.setItem(conversationStorageKey, JSON.stringify({
              user: userText,
              assistant: chunks.join(''),
              userMessageId: user.dataset.messageId,
              assistantMessageId: assistant.dataset.messageId
            }));
            const chunkDelay = userText.includes('cancellation canary') ? 1000 : 150;
            chunks.forEach((chunk, index) => {
              setTimeout(() => {
                if (activeGeneration !== responseGeneration) return;
                assistant.textContent += chunk;
                window.__farolTaskProgress.push(assistant.textContent.length);
                if (index === chunks.length - 1) {
                  stop.hidden = true;
                  send.hidden = false;
                  send.disabled = false;
                }
              }, chunkDelay * (index + 1));
            });
          });
          restoreConversation();
          render();
        </script>
      </body></html>`);
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  return {
    server: fixture,
    url: `http://127.0.0.1:${address.port}${setup ? "/" : "/chatgpt"}`,
  };
}

export async function stopChatGptFixture(fixture) {
  if (!fixture) return;
  if (fixture.close) {
    await fixture.close();
    return;
  }
  await new Promise((resolve, reject) => {
    fixture.server.close((error) => (error ? reject(error) : resolve()));
  });
}
