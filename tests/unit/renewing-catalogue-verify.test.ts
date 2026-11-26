import { describe, expect, it } from "vitest";
import { renewingReadonlyComputerContract } from "../../src/modules/computer/infra/mcp/renewing-computer-contracts";

// The renewing wrapper's final catalogue verification over scripted ports: the
// handler's own check passes, then the execution re-check awaits. A
// cancellation that arrives during that await must still stop disclosure.

function contract(onCurrent: () => void) {
  const handler = {
    verifyWorkspaces: async () => ({ ok: true as const }),
    execute: async () => {
      throw new Error("not used");
    },
  };
  const execution = {
    current: async () => {
      onCurrent();
      return true;
    },
  };
  const authority = {
    admitExecution: async () => execution,
    run: async (_execution: unknown, action: () => Promise<unknown>) =>
      action(),
  };
  return renewingReadonlyComputerContract(handler as never, authority as never);
}

describe("renewing catalogue verification", () => {
  it("refuses when the call is cancelled during the execution re-check", async () => {
    const controller = new AbortController();
    const result = await contract(() => controller.abort()).verifyWorkspaces!(
      {} as never,
      { signal: controller.signal } as never,
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "WORKSPACE_REQUEST_CANCELLED",
        source: "native-workspace",
        retry: "never",
      },
    });
  });

  it("passes when nothing was cancelled", async () => {
    const controller = new AbortController();
    const result = await contract(() => {}).verifyWorkspaces!(
      {} as never,
      { signal: controller.signal } as never,
    );
    expect(result).toEqual({ ok: true });
  });
});
