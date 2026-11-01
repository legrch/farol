const prompt = `Please run a manual, non-destructive Deep test of my Farol connection in this conversation.

I authorize you to use the available Farol tools for this test, within their existing permissions and confirmations. First list the approved workspaces and select one that is already approved. If none is available, stop and tell me what is needed; do not request or assume broader access.

Inspect the available tools and exercise applicable read-only operations in that workspace using small, bounded requests. Do not read sensitive files, credentials, private keys, authentication data, or unrelated personal information. Do not create, modify, move, or delete files; run commands; change settings; or perform any other destructive or external action. Do not bypass a refusal or confirmation. Stop on an unknown outcome and do not retry it.

Report the workspace selected, each tool or capability tested, its observed result, and any skipped, refused, or unconfirmed checks. Distinguish actual tool results from assumptions; do not claim success for untested capabilities.`;

export function DeepTestPrompt() {
  return (
    <div className="deep-test-prompt">
      <p>
        Copy this prompt into your current ChatGPT conversation, or start a new
        one, and send it there. Farol does not send it automatically.
      </p>
      <label className="field">
        Deep test prompt
        <textarea
          readOnly
          rows={14}
          value={prompt}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
    </div>
  );
}
