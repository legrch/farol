import { createHash } from "node:crypto";
import { ownerComputerConsentDigest } from "../../src/modules/computer/infra/repo/owner-computer-consent";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductConfigurationService,
  ProductSettingsStore,
  type OriginalStopSettingsPlan,
} from "../../src/apps/desktop/product-configuration";

// Actual sole-writer conditional-save/readback integration with disposable
// ProductSettings bytes; Go and native Stop are separate, unexecuted owners.
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function connected() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-c7-original-"));
  roots.push(root);
  const store = new ProductSettingsStore({ root });
  const owner = new ProductConfigurationService(store);
  await owner.initialize();
  await owner.recordSecureMcpTunnelClient({
    executablePath: "/opt/homebrew/bin/tunnel-client",
    executableSha256: "a".repeat(64),
    version: "0.0.14+0f870e50a973fa820d4c409000059e181e8d242b",
    protocol: "openai-tunnel-client/v1",
  });
  await owner.configureSecureMcpTunnel({ tunnelId: "synthetic" });
  await owner.recordSecureMcpCredential("stored");
  const beforeRuntime = owner.snapshot();
  if (beforeRuntime.status !== "ready") throw new Error("settings unavailable");
  await owner.recordSecureMcpRuntime({
    state: "ready",
    runtimeGeneration: "b".repeat(64),
    computerGeneration: beforeRuntime.settings.computer.generation,
    buildId: "c".repeat(64),
  });
  const original = owner.snapshot();
  if (
    original.status !== "ready" ||
    original.settings.connectors.secureMcp.runtime === null
  )
    throw new Error("connected runtime unavailable");
  const selection = {
    effectId: "11111111-1111-4111-8111-111111111111",
    expectedRevision: original.settings.revision,
    expectedDigest: createHash("sha256")
      .update(JSON.stringify(original.settings))
      .digest("hex"),
    computerGeneration: original.settings.computer.generation,
    connectorGeneration: original.settings.connectors.secureMcp.generation,
    consentDigest: ownerComputerConsentDigest(original.settings),
  };
  return { owner, store, original, selection };
}

describe("C7 original stopped ProductSettings publication", () => {
  it("admits exact original intent before sole conditional publication and returns its readback ACK", async () => {
    const { owner, store, original, selection } = await connected();
    const events: string[] = [];
    const actualSave = store.saveConditional.bind(store);
    const save = vi
      .spyOn(store, "saveConditional")
      .mockImplementation(async (...args) => {
        events.push("save");
        return actualSave(...args);
      });
    let retainedPlan: OriginalStopSettingsPlan | undefined;
    const result = await owner.commitOriginalStoppedSettings(
      selection,
      async (plan) => {
        events.push("durable-intent");
        retainedPlan = plan;
        expect(plan.effectId).toBe(selection.effectId);
        expect(plan.expectedDigest).toBe(selection.expectedDigest);
        expect(plan.expectedRevision).toBe(String(original.settings.revision));
      },
      () => true,
    );
    expect(events).toEqual(["durable-intent", "save"]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("committed");
    if (result.status !== "committed" || !retainedPlan)
      throw new Error("no original Settings ACK");
    expect(result.receipt).toMatchObject({
      effectId: selection.effectId,
      revision: retainedPlan.nextRevision,
      documentDigest: retainedPlan.nextDigest,
      computerGeneration: retainedPlan.computerGeneration,
      connectorGeneration: retainedPlan.connectorGeneration,
      consentDigest: retainedPlan.consentDigest,
    });
    const readback = await store.load();
    expect(
      createHash("sha256").update(JSON.stringify(readback)).digest("hex"),
    ).toBe(result.receipt.documentDigest);
    expect(readback?.connectors.secureMcp.runtime).toBeNull();
  });

  it("a lost intent ACK dispatches ZERO Settings save despite unchanged original bytes", async () => {
    const { owner, store, original, selection } = await connected();
    const save = vi.spyOn(store, "saveConditional");
    let calls = 0;
    const result = await owner.commitOriginalStoppedSettings(
      selection,
      async () => {
        calls++;
        throw new Error("lost Go intent acknowledgement");
      },
      () => true,
    );
    expect(result.status).toBe("unknown");
    expect(calls).toBe(1);
    expect(save).not.toHaveBeenCalled();
    expect(await store.load()).toEqual(original.settings);
  });

  it("an unknown save after actual original publication never becomes ACK from equal disk bytes", async () => {
    const { owner, store, selection } = await connected();
    const realSave = store.saveConditional.bind(store);
    const save = vi
      .spyOn(store, "saveConditional")
      .mockImplementation(async (...args) => {
        await realSave(...args);
        // Simulate loss of the positive publication/readback receipt.
        return { status: "unknown" };
      });
    const first = await owner.commitOriginalStoppedSettings(
      selection,
      async () => {},
      () => true,
    );
    expect(first.status).toBe("unknown");
    const visible = await store.load();
    expect(visible?.connectors.secureMcp.runtime).toBeNull();
    const again = await owner.commitOriginalStoppedSettings(
      selection,
      async () => {
        throw new Error("second Go intent forbidden");
      },
      () => true,
    );
    expect(again.status).not.toBe("committed");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("pre-publication changed revision rejects before Go intent and Settings save", async () => {
    const { owner, store, selection } = await connected();
    const intent = vi.fn(async () => {});
    const save = vi.spyOn(store, "saveConditional");
    const result = await owner.commitOriginalStoppedSettings(
      { ...selection, expectedRevision: selection.expectedRevision + 1 },
      intent,
      () => true,
    );
    expect(result.status).toBe("not_written");
    expect(intent).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("a stale authority reservation cannot admit the original write", async () => {
    const { owner, store, selection } = await connected();
    const intent = vi.fn(async () => {});
    const save = vi.spyOn(store, "saveConditional");
    const result = await owner.commitOriginalStoppedSettings(
      selection,
      intent,
      () => false,
    );
    expect(result.status).toBe("not_written");
    expect(intent).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("complete C7 owner-consent fingerprint and stopped readback", () => {
  it("excludes transient revision/runtime/device observations but retains owner choices", async () => {
    const { original } = await connected();
    const selected = structuredClone(original.settings);
    const originalDigest = ownerComputerConsentDigest(selected);
    selected.revision += 1;
    selected.computer.generation += 1;
    selected.connectors.secureMcp.runtime = null;
    expect(ownerComputerConsentDigest(selected)).toBe(originalDigest);
    selected.computer.commands =
      selected.computer.commands === "workspace" ? "none" : "workspace";
    expect(ownerComputerConsentDigest(selected)).not.toBe(originalDigest);
    selected.computer.commands = original.settings.computer.commands;
    selected.computer.filePolicy =
      selected.computer.filePolicy === "approved-roots-v1"
        ? ""
        : "approved-roots-v1";
    expect(ownerComputerConsentDigest(selected)).not.toBe(originalDigest);

    const withRoot = structuredClone(original.settings);
    withRoot.computer.workspaces.push({
      workspaceId: "scope-one",
      root: "/Users/example/project",
      label: "Project",
      access: "read",
      excludedPaths: [],
    });
    const scopeDigest = ownerComputerConsentDigest(withRoot);
    const relabelled = structuredClone(withRoot);
    relabelled.computer.workspaces[0]!.label = "Presentation only";
    expect(ownerComputerConsentDigest(relabelled)).toBe(scopeDigest);
    const restricted = structuredClone(withRoot);
    restricted.computer.workspaces[0]!.excludedPaths = [
      "/Users/example/project/private",
    ];
    expect(ownerComputerConsentDigest(restricted)).not.toBe(scopeDigest);
    const accessChanged = structuredClone(withRoot);
    accessChanged.computer.workspaces[0]!.access = "write";
    expect(ownerComputerConsentDigest(accessChanged)).not.toBe(scopeDigest);
    const gitChoice = structuredClone(withRoot);
    gitChoice.computer.workspaces[0]!.gitHistoryApproved = true;
    expect(ownerComputerConsentDigest(gitChoice)).not.toBe(scopeDigest);
  });

  it("a mismatched stable owner-consent hash refuses before Settings intent or save", async () => {
    const { owner, store, selection } = await connected();
    const intent = vi.fn(async () => {});
    const save = vi.spyOn(store, "saveConditional");
    const bad = { ...selection, consentDigest: "f".repeat(64) };
    const result = await owner.commitOriginalStoppedSettings(
      bad,
      intent,
      () => true,
    );
    expect(result.status).toBe("not_written");
    expect(intent).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("a crossed post-write policy readback is UNKNOWN, not an exact Settings ACK", async () => {
    const { owner, store, selection } = await connected();
    const actual = store.saveConditional.bind(store);
    const save = vi
      .spyOn(store, "saveConditional")
      .mockImplementation(async (...args) => {
        const recorded = await actual(...args);
        if (recorded.status !== "committed") return recorded;
        const crossed = structuredClone(recorded.settings);
        crossed.computer.commands =
          crossed.computer.commands === "none" ? "verification" : "none";
        return { status: "committed", settings: crossed };
      });
    const intent = vi.fn(async () => {});
    const result = await owner.commitOriginalStoppedSettings(
      selection,
      intent,
      () => true,
    );
    expect(intent).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(result.status).toBe("unknown");
    const second = await owner.commitOriginalStoppedSettings(
      selection,
      async () => {
        throw new Error("no second intent");
      },
      () => true,
    );
    expect(second.status).not.toBe("committed");
    expect(save).toHaveBeenCalledTimes(1);
  });
});
