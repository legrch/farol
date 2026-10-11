/** Read-only help. Opening it never changes access or sends a message. */
export function ConnectionGuide() {
  return (
    <details className="connection-guide">
      <summary>How to connect</summary>
      <div className="connection-guide-content">
        <ol>
          <li>
            <strong>Sign in.</strong> Use your ChatGPT account in Farol for the
            built-in check. You can skip this when using ChatGPT in another
            browser.
          </li>
          <li>
            <strong>Connect this Mac.</strong> Open Tunnels in ChatGPT, create
            or select your tunnel, and paste its Tunnel ID and runtime key into
            Farol. Choose Save &amp; connect. Keep the saved key unless the
            tunnel details change.
          </li>
          <li>
            <strong>Add Farol to ChatGPT.</strong> In ChatGPT, create or select
            the app attached to this tunnel. Use that app when checking the
            connection. The tunnel and the ChatGPT app must belong to the same
            connection.
          </li>
          <li>
            <strong>Workspace.</strong> Add a folder for Computer file access.
            Farol checks it and restores a configured connection automatically.
            Removing a workspace only removes access; your files stay on disk.
            ChatGPT itself can be used without a workspace; this version's
            Computer check requires one.
          </li>
          <li>
            <strong>Check.</strong> Select the exact ChatGPT app name. In a
            Temporary Chat using Instant, choose Check in ChatGPT once. Farol
            sends one small verification request; only a matching receipt from
            this Mac confirms success. Alternatively, copy the request into your
            own ChatGPT chat and return to Check attachment.
          </li>
        </ol>
        <p>
          Continue only moves to the next page. Overview shows the checks that
          actually passed. A local connection alone does not confirm that
          ChatGPT can reach this Mac.
        </p>
        <p>
          If a result is unconfirmed, open Connection diagnostics to inspect it
          before trying again. Opening Setup never repeats a request.
        </p>
      </div>
    </details>
  );
}
