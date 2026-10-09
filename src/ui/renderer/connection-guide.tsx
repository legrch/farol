/** Read-only help: opening it never saves, connects, verifies or sends a message. */
export function ConnectionGuide() {
  return (
    <details className="connection-guide">
      <summary>Connection guide</summary>
      <div className="connection-guide-content">
        <ol>
          <li>
            <strong>Overview.</strong> Fresh profiles complete the required
            workspace, connection and attachment checks. Returning profiles
            review current checks and keep saved workspaces and credentials.
            Continue advances through sections; Review setup returns to
            Overview. Navigation does not save, verify, change access or
            connection bindings, or replay an action.
          </li>
          <li>
            <strong>Sign in · optional.</strong> Embedded ChatGPT sign-in is
            separate from external Computer access. You can continue without it.
            For an unchecked account, use Sign in, Open ChatGPT and Check
            sign-in when needed, or Skip for now. Opening sign-in does not
            confirm an authenticated account. When Setup says Sign-in is checked
            for this build, use Continue; the launcher and check controls are
            hidden.
          </li>
          <li>
            <strong>Workspaces.</strong> For fresh setup, use Add workspace… and
            Add selected workspace read-only, then Verify workspace when
            offered. For a current verified workspace, review Saved access and
            Access checked, then Continue without re-verifying. Edit opens
            access controls only when you intend to change them. Save submits
            changed access; Cancel discards the draft. Removing a workspace
            keeps its files. A saved workspace or stale check alone is
            insufficient.
          </li>
          <li>
            <strong>Connection.</strong> For fresh setup, enter the Tunnel ID
            and Runtime key for this environment, then choose Save &amp; connect
            once. For a returning profile, Tunnel credentials saved means you
            can keep the saved key. Use Edit connection only when details change
            and Continue when the connection check is current. Check connection
            is an explicit local health check. Show runtime key and Hide runtime
            key reveal only your current input, never the saved key. Submission
            clears that field. Saved credentials do not establish transport
            recovery.
          </li>
          <li>
            <strong>Add to ChatGPT.</strong> For fresh or unfinished attachment,
            attach this Farol connection in ChatGPT. Use Copy verification
            request only when available and send it yourself once. Return here
            and choose Check attachment to observe its result; this does not
            send another message. For a current retained attachment check that
            matches this build, connection and workspace, choose Review setup.
            Setup hides the first-time instructions, copy and check controls; do
            not resend verification to advance.
          </li>
        </ol>
        <p>
          If no compatible helper is confirmed, use Find connection helper or
          review Connection diagnostics. Discovery must verify the helper before
          connection can start.
        </p>
        <p>
          A local connection still needs the external ChatGPT check. Computer
          ready requires current workspace and attachment evidence.
        </p>
        <p>
          If credentials are saved but connection did not finish, keep the key
          and review the result. For a pending or unknown result, use
          Diagnostics to observe the original action. Refresh and reopening this
          guide do not settle uncertainty or repeat an action.
        </p>
      </div>
    </details>
  );
}
