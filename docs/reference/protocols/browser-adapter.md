# Browser adapter and continuity

**State:** current TypeScript source with controlled-page, transport, and Electron
fixture coverage. Public DOM tests do not qualify the current authenticated ChatGPT
UI or enable the Farol model-provider route.

The desktop owns browser surfaces, exact document generations, readiness, submission,
and observation. Chat owns Turn/stream state and consumer-owned browser ports.
[Architecture](../../architecture/README.md) describes this ownership and the Go migration target.

## Public readiness

Readiness belongs to one route surface, URL, and document generation. Navigation,
replacement, disposal, and same-URL reload invalidate earlier observations. An older
asynchronous read cannot replace a newer settled result or authorize Send while a
newer probe is pending.

A visible sign-in barrier takes precedence over a guest composer. In the same
document, an unrecognized probe retains the observed sign-in requirement until a
current positive probe clears it. Navigation does not reuse that latch.

Admission checks current public evidence after asynchronous preparation and intent/app
verification, immediately before upload/Send. A previous positive result is not
persistent account authentication or reusable Send authority.

## Visible output

[Public markdown projection](../../../src/apps/desktop/chatgpt-public-markdown.ts) and
[visible output](../../../src/apps/desktop/chatgpt-visible-output.ts) parse bounded public
content instead of treating arbitrary DOM as an answer.

The qualified code wrapper is exactly `DIV[data-markdown-copy="code-block"]` with
one visible CODE and no outside prose. Local visible toolbar-button evidence can
remove its toolbar, without fingerprinting answer content by a transient translated
label. Newlines, indentation, fence/language escaping, and empty code blocks are
preserved. Unknown shapes, multiple/nested CODE nodes, hidden/control descendants,
and visible outside prose are not silently reinterpreted. A not-yet-mounted CODE is
pending. Shared depth/traversal/character bounds still apply.

Message IDs, committed prefixes, commentary/final phases, and tool-result continuation
have independent correlation checks. A label or a newer chunk cannot rewrite an
already committed answer prefix.

## One submission and recovery

Context is previewed before submission. Durable intent precedes an effect. Lost
click/transport/journal acknowledgment remains unknown; it cannot trigger another
Send, another conversation, or a provider fallback.

The source-only text-route assembly composes ChatGptRoute, the conversation adapter,
Responses/SSE provider, and caller relay on disposable transports. It checks exact
ordered deltas, message/response identity, one terminal frame, tool-result
continuation, and stream-loss no-replay. Page answers and Send counts are synthetic;
this is not native DOM or account evidence.

## Continuity

A retained conversation can keep context when available. Summary-only turns have no
tools, use a private bounded checkpoint, and wait for exact host completion before
an epoch transition. Restart/recovery keeps the retained binding. A model summary
neither renews Computer authority nor proves a side effect or original delivery.

Checkpoint provenance, provider completion, admission, and cleanup remain separate.
An uncertain handoff keeps its fence; an acknowledgment cannot release an occupied
route without the required correlated completion/cleanup evidence.

## Focused verification

The hidden public-source fixture can be prepared without launching Electron:

```sh
node tests/e2e/chatgpt-public-source.e2e.mjs --build-only
```

Its native execution mode needs the applicable native test authority and follows
[the display policy](../../development/testing.md#display-and-focus-policy). Build-only does not
count as native PASS. Controlled DOM answers cannot prove current provider selectors,
model selection, account identity, attachments, or live output recovery.

---

[Protocols](README.md) · [Documentation](../../README.md)
