import type {
  RendererFacade,
  WindowSnapshot,
} from "../../../src/ui/renderer/contract";

export function ChatBrowser({
  snapshot,
  facade,
}: {
  snapshot: WindowSnapshot;
  facade: RendererFacade;
}) {
  const intentions = [
    "chatgpt.present-browser",
    "chatgpt.open-browser",
    "chatgpt.open-sign-in",
  ] as const;
  const relevant = intentions
    .map((kind) => snapshot.intents[`settings:${kind}:`])
    .filter((intent) => intent && intent.state !== "applied");
  // Explicit navigation owns presentation; mounting this placeholder never
  // opens a browser. Retain pending and uncertain command outcomes separately
  // from the ambient route status.
  if (snapshot.route === "loaded" && relevant.length === 0) return null;
  const unknown = relevant.some((intent) => intent?.state === "unknown");
  const pending = relevant.some((intent) => intent?.state === "pending");
  const failed = snapshot.route === "failed" || relevant.length > 0;
  return (
    <div className="native-browser-placeholder">
      <p
        className="notice"
        role={unknown || (failed && !pending) ? "alert" : "status"}
      >
        {unknown
          ? "Opening ChatGPT is unconfirmed. Review Unresolved actions before repeating this action."
          : pending
            ? "Opening ChatGPT…"
            : relevant.some(
                  (intent) => intent?.code === "CHATGPT_SIGN_IN_IN_PROGRESS",
                )
              ? "Sign-in is already open in ChatGPT. Finish there, then check sign-in in Connection."
              : failed
                ? snapshot.route === "failed"
                  ? "ChatGPT could not be opened. The page failed to load. Return to Setup to check sign-in; navigation does not retry the page."
                  : "ChatGPT could not be opened. Check Connection in Setup for details."
                : "ChatGPT page status has not been confirmed. Check Connection for details."}
      </p>
      {(unknown || pending || !snapshot.setupSignInReturn) && (
        <div className="control-row">
          <button
            onClick={() =>
              unknown || pending
                ? facade.overlay("unresolved-actions")
                : facade.navigate({ area: "setup", setupStep: "connection" })
            }
          >
            {unknown || pending ? "Unresolved actions" : "Connection"}
          </button>
        </div>
      )}
    </div>
  );
}
