import { describe, expect, it } from "vitest";
import {
  deriveGeneration,
  validateCredentialReference,
  validateExecutable,
  validateStartInput,
  validateTunnelId,
  type ConnectorStartInput,
} from "./input";

// The admission checks before any connector effect. Pure values; nothing runs.

const valid: ConnectorStartInput = {
  executablePath: "/app/tunnel-client",
  executableSha256: "a".repeat(64),
  connectorGeneration: 3,
  computerGeneration: 4,
  buildId: "b".repeat(64),
  launchContractSha256: "c".repeat(64),
};

describe("validateExecutable", () => {
  it("admits an absolute path", () =>
    expect(() => validateExecutable("/a/b")).not.toThrow());
  it.each(["a/b", "", "/a\0b"])("refuses %j", (value) =>
    expect(() => validateExecutable(value)).toThrow(
      "CONNECTOR_EXECUTABLE_INVALID",
    ),
  );
});

describe("validateTunnelId", () => {
  it.each(["t", "tun_1", "a.b:c-d", "A".repeat(160)])("admits %s", (value) =>
    expect(() => validateTunnelId(value)).not.toThrow(),
  );
  it.each(["", "a b", "a/b", "a\nb", "é", "A".repeat(161)])(
    "refuses %j",
    (value) =>
      expect(() => validateTunnelId(value)).toThrow(
        "CONNECTOR_TUNNEL_ID_INVALID",
      ),
  );
});

describe("validateCredentialReference", () => {
  it("admits an absolute file reference", () =>
    expect(() => validateCredentialReference("file:/p/key")).not.toThrow());
  it.each(["file:relative", "file:", "env:/p/key", "/p/key", "", "file:/a\0b"])(
    "refuses %j",
    (value) =>
      expect(() => validateCredentialReference(value)).toThrow(
        "CONNECTOR_CREDENTIAL_REFERENCE_INVALID",
      ),
  );
});

describe("validateStartInput", () => {
  it("admits a complete identity", () =>
    expect(() => validateStartInput(valid)).not.toThrow());

  it("refuses a relative executable with its own code first", () =>
    expect(() =>
      validateStartInput({ ...valid, executablePath: "tunnel", buildId: "x" }),
    ).toThrow("CONNECTOR_EXECUTABLE_INVALID"));

  it.each([
    ["a short executable digest", { executableSha256: "a".repeat(63) }],
    ["an uppercase digest", { buildId: "B".repeat(64) }],
    ["a bad launch contract digest", { launchContractSha256: "g".repeat(64) }],
    ["connector generation zero", { connectorGeneration: 0 }],
    ["a fractional connector generation", { connectorGeneration: 1.5 }],
    ["computer generation zero", { computerGeneration: 0 }],
    ["a negative computer generation", { computerGeneration: -2 }],
    ["a non-integer computer generation", { computerGeneration: NaN }],
  ])("refuses %s", (_name, patch) =>
    expect(() => validateStartInput({ ...valid, ...patch })).toThrow(
      "CONNECTOR_START_INPUT_INVALID",
    ),
  );
});

describe("deriveGeneration", () => {
  it("is the pinned digest of the nonce and the identity", () =>
    expect(deriveGeneration("id-1", valid)).toBe(
      "9456017c572c0b3b83ee547a6bbea86cafceda4e6bc249f7a495613e8b91872a",
    ));

  it("changes with the nonce and with each identity field", () => {
    const base = deriveGeneration("id-1", valid);
    expect(deriveGeneration("id-2", valid)).not.toBe(base);
    for (const patch of [
      { executableSha256: "d".repeat(64) },
      { connectorGeneration: 5 },
      { computerGeneration: 5 },
      { buildId: "d".repeat(64) },
      { launchContractSha256: "d".repeat(64) },
    ])
      expect(deriveGeneration("id-1", { ...valid, ...patch })).not.toBe(base);
  });

  it("ignores the executable path and the withdrawal callback", () =>
    expect(
      deriveGeneration("id-1", {
        ...valid,
        executablePath: "/other",
        beforeEffect: () => undefined,
      }),
    ).toBe(deriveGeneration("id-1", valid)));
});
