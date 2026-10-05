import { expect, it } from "vitest";
import { parseConnectorLaunch } from "../../apps/desktop/bridge/connector-launch";

function fixture() {
  return {
    schema: "farol-go-connector/1",
    lifecycleRoot: "/private/tmp/profile/computer-authority",
    challengeSha256: "a".repeat(64),
    opened: {
      endpoint: {
        binding: {
          buildId: "build",
          profileId: "profile",
          backendGeneration: "backend",
          runtimeId: "runtime",
          connectorGeneration: "9007199254740993",
        },
        socketPath: "/private/tmp/farol-mcp-1234/computer.sock",
        token: "b".repeat(64),
      },
      execution: {
        ownerId: "owner",
        sessionId: "session",
        taskId: "scope",
        taskEpoch: "1",
        participantId: "participant",
        turnId: "correlation",
        generation: "1",
      },
      admissionOperationId: "original",
    },
  };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
it("retains exact Go binding and decimal identity without a policy or fallback", () => {
  const value = fixture(),
    parsed = parseConnectorLaunch(bytes(value));
  expect(parsed).toEqual(value);
  expect(parsed.opened.endpoint.binding.connectorGeneration).toBe(
    "9007199254740993",
  );
  expect(Object.isFrozen(parsed.opened.endpoint.binding)).toBe(true);
  expect(Object.isFrozen(parsed.opened.execution)).toBe(true);
});
it.each(["schema", "lifecycleRoot", "challengeSha256", "opened"])(
  "rejects absent %s",
  (field) => {
    const value: Record<string, unknown> = fixture();
    delete value[field];
    expect(() => parseConnectorLaunch(bytes(value))).toThrow(
      "COMPUTER_MCP_GO_LAUNCH_UNAVAILABLE",
    );
  },
);
it.each(["approval", "fallback", "executable", "workspaces"])(
  "rejects injected %s",
  (field) => {
    expect(() =>
      parseConnectorLaunch(bytes({ ...fixture(), [field]: {} })),
    ).toThrow();
  },
);
it.each([
  "/tmp/farol-mcp-1234/computer.sock",
  "/private/tmp/other/computer.sock",
  "/private/tmp/farol-mcp-1234/../computer.sock",
  "/private/tmp/farol-mcp-1234/other.sock",
  "/private/tmp/farol-mcp-1234/computer.sock\0",
])("rejects wrong socket path %s", (socketPath) => {
  const value = fixture();
  value.opened.endpoint.socketPath = socketPath;
  expect(() => parseConnectorLaunch(bytes(value))).toThrow();
});
it.each([
  "relative",
  "/private/tmp/../profile",
  "/private/tmp/profile/",
  "/private/tmp/pro\0file",
])("rejects noncanonical lifecycle path %s", (lifecycleRoot) => {
  expect(() =>
    parseConnectorLaunch(bytes({ ...fixture(), lifecycleRoot })),
  ).toThrow();
});
it("rejects duplicate keys, invalid UTF-8 and byte overflow without revealing content", () => {
  const body = JSON.stringify(fixture());
  for (const input of [
    Buffer.alloc(0),
    Buffer.alloc(16385),
    Buffer.from([0xff]),
    Buffer.from('{"schema":"other",' + body.slice(1)),
  ]) {
    expect(() => parseConnectorLaunch(input)).toThrow(
      "COMPUTER_MCP_GO_LAUNCH_UNAVAILABLE",
    );
  }
});
