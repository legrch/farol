/** Compatibility document for an explicitly opened, read-only local guide. */
export function ConnectionGuide() {
  return (
    <details className="connection-guide">
      <summary>How to set up Farol</summary>
      <div className="connection-guide-content">
        <ol>
          <li>
            <strong>Sign in.</strong> Sign in to your own ChatGPT account,
            return to Farol and choose Check sign-in. Continue after the check
            passes.
          </li>
          <li>
            <strong>Workspaces.</strong> Add a workspace. Each row shows Read
            only or Read &amp; write, Commands and its access check. Command
            access is shared across all workspaces. All listed workspaces must
            work before continuing.
          </li>
          <li>
            <strong>Connect this Mac.</strong> Create a tunnel named Farol and a
            Restricted key with Tunnels: Read and Use in OpenAI. Enter the
            Tunnel ID and Key, then choose Connect. Farol finds the helper,
            saves the key, connects and checks health.
          </li>
          <li>
            <strong>Add to ChatGPT.</strong> In Settings → Apps, create Farol
            with connection Tunnel and your tunnel ID, and sign-in None. Choose
            Test in ChatGPT once in Farol. A matching receipt verifies workspace
            access without reading file contents. Start using Farol opens Home
            after all checks pass.
          </li>
        </ol>
        <p>
          If a result is unconfirmed, refresh its saved result and inspect it
          before trying again. Do not repeat an unconfirmed action. Save a
          support file from Settings → General when you need help.
        </p>
      </div>
    </details>
  );
}
