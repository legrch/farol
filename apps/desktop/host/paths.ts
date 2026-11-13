import { createHash } from "node:crypto";
import path from "node:path";
import { operationsDirectory } from "../operations/paths";

/** Inputs the layout is computed from. `userData` is the profile directory
 * (`app.getPath("userData")`); `tmpdir` is `os.tmpdir()`, used only for the
 * short caller-relay directory. */
export type DesktopStatePathInputs = {
  readonly userData: string;
  readonly tmpdir: string;
};

/** Every profile-local directory and file Desktop addresses by name. */
export type DesktopStatePaths = {
  /** `<userData>/farol-state`, the profile state root. */
  readonly state: string;
  /** `<userData>/farol-private`, the private (credential-bearing) root. */
  readonly private: string;
  readonly attachmentStaging: string;
  readonly chatGptTaskJournal: string;
  readonly chatGptConversation: string;
  readonly liveTasks: string;
  readonly contextContinuity: string;
  readonly secureMcpConnector: string;
  readonly secureMcpLaunch: string;
  readonly secureMcpCredential: string;
  readonly modelEndpoint: string;
  readonly devMcpProof: string;
  readonly codexHostProbe: string;
  readonly codexHostRuntime: string;
  readonly codexAgentAssignments: string;
  readonly productAgentInputs: string;
  readonly workspaceMutations: string;
  readonly operations: string;
  readonly savedChatHandoff: string;
  readonly summaryFenceRecovery: string;
  readonly callerRelay: string;
};

/** Pure layout of the profile's state directories; no filesystem access. */
export function desktopStatePaths(
  inputs: DesktopStatePathInputs,
): DesktopStatePaths {
  const { userData, tmpdir } = inputs;
  const state = path.join(userData, "farol-state");
  const priv = path.join(userData, "farol-private");
  const secureMcpConnector = path.join(state, "secure-mcp-connector");
  // The relay socket path must stay under the 104-byte Unix socket limit, so
  // it lives in a short temporary directory keyed by this profile.
  const profile = createHash("sha256")
    .update(userData)
    .digest("hex")
    .slice(0, 16);
  return Object.freeze({
    state,
    private: priv,
    attachmentStaging: path.join(state, "attachment-staging"),
    chatGptTaskJournal: path.join(state, "chatgpt-task-journal"),
    chatGptConversation: path.join(state, "chatgpt-conversation"),
    liveTasks: path.join(state, "live-tasks"),
    contextContinuity: path.join(state, "context-continuity"),
    secureMcpConnector,
    secureMcpLaunch: path.join(secureMcpConnector, "computer-authority"),
    secureMcpCredential: path.join(priv, "secure-mcp-connector"),
    modelEndpoint: path.join(priv, "model-endpoint"),
    devMcpProof: path.join(priv, "dev-mcp-proof"),
    codexHostProbe: path.join(state, "codex-host-probe"),
    codexHostRuntime: path.join(state, "codex-host-runtime"),
    codexAgentAssignments: path.join(state, "native-agent-assignments"),
    productAgentInputs: path.join(state, "product-agent-inputs"),
    workspaceMutations: path.join(state, "workspace-mutations"),
    operations: operationsDirectory(userData),
    savedChatHandoff: path.join(state, "saved-chat-handoff"),
    summaryFenceRecovery: path.join(state, "summary-fence-recovery.json"),
    callerRelay: path.join(tmpdir, `farol-relay-${profile}`),
  });
}
