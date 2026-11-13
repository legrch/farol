import path from "node:path";
import { describe, expect, it } from "vitest";
import { desktopStatePaths } from "../../apps/desktop/host/state-paths";

// Golden table: the exact strings the former `*Root()` builders in main.ts
// produced for a given `app.getPath("userData")`. Production, Dev and Owner
// Preview differ only in that directory, so one layout is pinned per identity.
const identities = [
  {
    name: "production",
    userData:
      "/Users/example/Library/Application Support/io.github.legrch.farol",
    relay: "b732cb9adb0946a8",
  },
  {
    name: "dev",
    userData:
      "/Users/example/Library/Application Support/io.github.legrch.farol.dev",
    relay: "cec719020ba24ac0",
  },
  {
    name: "owner preview",
    userData:
      "/Users/example/Library/Application Support/io.github.legrch.farol.preview",
    relay: "cfa41e05977a03e8",
  },
] as const;

describe("desktopStatePaths", () => {
  it.each(identities)("pins every path for $name", ({ userData, relay }) => {
    const s = `${userData}/farol-state`;
    const p = `${userData}/farol-private`;
    expect(desktopStatePaths({ userData, tmpdir: "/var/folders/t" })).toEqual({
      state: s,
      private: p,
      attachmentStaging: `${s}/attachment-staging`,
      chatGptTaskJournal: `${s}/chatgpt-task-journal`,
      chatGptConversation: `${s}/chatgpt-conversation`,
      liveTasks: `${s}/live-tasks`,
      contextContinuity: `${s}/context-continuity`,
      secureMcpConnector: `${s}/secure-mcp-connector`,
      secureMcpLaunch: `${s}/secure-mcp-connector/computer-authority`,
      secureMcpCredential: `${p}/secure-mcp-connector`,
      modelEndpoint: `${p}/model-endpoint`,
      devMcpProof: `${p}/dev-mcp-proof`,
      codexHostProbe: `${s}/codex-host-probe`,
      codexHostRuntime: `${s}/codex-host-runtime`,
      codexAgentAssignments: `${s}/native-agent-assignments`,
      productAgentInputs: `${s}/product-agent-inputs`,
      workspaceMutations: `${s}/workspace-mutations`,
      operations: `${s}/operations`,
      savedChatHandoff: `${s}/saved-chat-handoff`,
      summaryFenceRecovery: `${s}/summary-fence-recovery.json`,
      callerRelay: `/var/folders/t/farol-relay-${relay}`,
    });
  });

  it("keeps identities isolated and the layout frozen", () => {
    const [a, b] = identities.map(({ userData }) =>
      desktopStatePaths({ userData, tmpdir: "/tmp" }),
    );
    expect(Object.isFrozen(a)).toBe(true);
    for (const [key, value] of Object.entries(a!)) {
      expect(value, key).not.toBe((b as Record<string, string>)[key]);
      expect(path.isAbsolute(value), key).toBe(true);
    }
  });
});
