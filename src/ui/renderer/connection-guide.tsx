/** Read-only help: opening it never saves, connects, verifies or sends a message. */
export function ConnectionGuide() {
  return (
    <details className="connection-guide">
      <summary>Connection guide</summary>
      <div className="connection-guide-content">
        <ol>
          <li>
            <strong>Overview.</strong> Review current checks. Returning profiles
            keep their workspaces and saved credentials.
          </li>
          <li>
            <strong>Sign in · optional.</strong> Embedded ChatGPT sign-in is
            separate from external Computer access. You can continue without it.
          </li>
          <li>
            <strong>Workspaces.</strong> Add a workspace, review its access,
            then choose Verify workspace. Save changes only when intended;
            Cancel discards the draft. Removing a workspace keeps its files.
          </li>
          <li>
            <strong>Connection.</strong> Enter the Tunnel ID and Runtime key for
            this environment, then choose Save &amp; connect once. A returning
            profile can use its saved key without entering it again. Show/Hide
            reveals only your current input, never the saved key.
          </li>
          <li>
            <strong>Add to ChatGPT.</strong> Attach this Farol connection in
            ChatGPT. Copy the current verification request and send it yourself
            once. Return here and choose Check attachment to observe its result.
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
