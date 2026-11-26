import { describe, expect, it } from "vitest";

import * as productConfiguration from "../../../src/apps/desktop/product-configuration";
import type { ProductSettings } from "../../../src/pkg/product-settings/contract";
import * as input from "./input";

const sha = "a".repeat(64);
const otherSha = "b".repeat(64);
const uuid = "12345678-1234-4234-8234-123456789abc";
const executablePath = "/usr/local/bin/codex";

const issues = (result: {
  success: boolean;
  error?: { issues: { code: string }[] };
}) => result.error?.issues.map((issue) => issue.code) ?? [];

describe("configuration input re-exports", () => {
  it("serves the same values from product-configuration", () => {
    expect(productConfiguration.WORKSPACE_DRIFT_NEEDS_ACTION).toBe(
      input.WORKSPACE_DRIFT_NEEDS_ACTION,
    );
    expect(productConfiguration.workspaceCheckEvidence).toBe(
      input.workspaceCheckEvidence,
    );
  });
});

describe("workspace check evidence", () => {
  const settings = (
    workspaces: unknown[],
    verified?: unknown,
  ): ProductSettings =>
    ({
      computer: { workspaces },
      setup: { computer: verified === undefined ? {} : { verified } },
    }) as unknown as ProductSettings;

  it("names the drift action", () => {
    expect(input.WORKSPACE_DRIFT_NEEDS_ACTION).toContain("Check each folder");
  });

  it("combines the folder check with the Computer verification", () => {
    const evidence = input.workspaceCheckEvidence(
      settings([{ workspaceId: "w1", accessCheck: { ok: 1 } }], { v: 2 }),
      "w1",
    );
    expect(JSON.parse(evidence)).toEqual({
      accessCheck: { ok: 1 },
      verified: { v: 2 },
    });
  });

  it("uses null for a missing folder, check or verification", () => {
    expect(
      input.workspaceCheckEvidence(settings([{ workspaceId: "w1" }]), "w1"),
    ).toBe('{"accessCheck":null,"verified":null}');
    expect(input.workspaceCheckEvidence(settings([]), "missing")).toBe(
      '{"accessCheck":null,"verified":null}',
    );
  });

  it("changes when either input changes", () => {
    const a = input.workspaceCheckEvidence(
      settings([{ workspaceId: "w1", accessCheck: 1 }], 1),
      "w1",
    );
    expect(
      input.workspaceCheckEvidence(
        settings([{ workspaceId: "w1", accessCheck: 2 }], 1),
        "w1",
      ),
    ).not.toBe(a);
    expect(
      input.workspaceCheckEvidence(
        settings([{ workspaceId: "w1", accessCheck: 1 }], 2),
        "w1",
      ),
    ).not.toBe(a);
  });
});

describe("workspace input", () => {
  const schema = input.workspaceInputSchema;
  it("accepts a label with an optional identity and trims the label", () => {
    expect(schema.parse({ root: "/r", label: "  Home  " })).toEqual({
      root: "/r",
      label: "Home",
    });
    expect(
      schema.safeParse({
        root: "/r",
        label: "a",
        rootIdentity: { device: "1", inode: "2" },
      }).success,
    ).toBe(true);
  });
  it("refuses empty, oversized and unknown input", () => {
    expect(schema.safeParse({ root: "/r", label: "   " }).success).toBe(false);
    expect(
      schema.safeParse({ root: "/r", label: "x".repeat(120) }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ root: "/r", label: "x".repeat(121) }).success,
    ).toBe(false);
    expect(schema.safeParse({ root: "/r" }).success).toBe(false);
    expect(schema.safeParse({ root: "/r", label: "a", extra: 1 }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        root: "/r",
        label: "a",
        rootIdentity: { device: "x", inode: "2" },
      }).success,
    ).toBe(false);
  });
});

describe("verification and ChatGPT observation input", () => {
  const verification = {
    profile: "p",
    runtimeGeneration: "g",
    buildId: sha,
    protocol: "v1",
  };
  it("checks the verification record", () => {
    expect(input.verificationInputSchema.safeParse(verification).success).toBe(
      true,
    );
    for (const bad of [
      { ...verification, profile: "" },
      { ...verification, profile: "x".repeat(161) },
      { ...verification, buildId: "A".repeat(64) },
      { ...verification, buildId: "a".repeat(63) },
      { ...verification, extra: true },
    ])
      expect(input.verificationInputSchema.safeParse(bad).success).toBe(false);
    expect(
      input.verificationInputSchema.safeParse({
        ...verification,
        profile: "x".repeat(160),
      }).success,
    ).toBe(true);
  });
  it("discriminates on state", () => {
    const schema = input.chatGptObservationSchema;
    expect(
      schema.safeParse({ ...verification, state: "authenticated" }).success,
    ).toBe(true);
    for (const state of [
      "signed_out",
      "unreachable",
      "unsupported",
      "outcome_unknown",
    ])
      expect(schema.safeParse({ state }).success).toBe(true);
    expect(schema.safeParse({ state: "authenticated" }).success).toBe(false);
    expect(
      schema.safeParse({ state: "signed_out", profile: "p" }).success,
    ).toBe(false);
    expect(schema.safeParse({ state: "other" }).success).toBe(false);
  });
});

describe("Codex host input", () => {
  const host = {
    executablePath,
    executableSha256: sha,
    version: "1.2.3",
    protocol: "codex-app-server/v2",
    schemaSha256: otherSha,
    buildId: sha,
  };
  const unavailable = (path: string, hash: string, base: string) => ({
    status: "unavailable",
    code: "CODEX_HOST_HANDOFF_UNAVAILABLE",
    executablePath: path,
    executableSha256: hash,
    baseSchemaSha256: base,
  });
  const source = (path = executablePath, hash = sha, base = otherSha) => ({
    handoff: unavailable(path, hash, base),
    followup: {
      ...unavailable(path, hash, base),
      code: "CODEX_HOST_FOLLOWUP_UNAVAILABLE",
    },
  });

  it("defaults the task source to null", () => {
    expect(input.codexHostInputSchema.parse(host).taskSource).toBeNull();
    expect(
      input.codexHostInputSchema.parse({ ...host, taskSource: null })
        .taskSource,
    ).toBeNull();
  });
  it("accepts a task source bound to the same host", () => {
    expect(
      input.codexHostInputSchema.safeParse({ ...host, taskSource: source() })
        .success,
    ).toBe(true);
  });
  it("refuses a task source bound to another host", () => {
    for (const taskSource of [
      source("/other/codex"),
      source(executablePath, otherSha),
      source(executablePath, sha, sha),
    ]) {
      const result = input.codexHostInputSchema.safeParse({
        ...host,
        taskSource,
      });
      expect(result.success).toBe(false);
      expect(issues(result)).toContain("custom");
      expect(JSON.stringify(result.error?.issues)).toContain(
        "Task source does not match the selected host.",
      );
    }
  });
  it("refuses malformed hosts", () => {
    for (const bad of [
      { ...host, version: "1.2" },
      { ...host, protocol: "codex-app-server/v1" },
      { ...host, executableSha256: "z".repeat(64) },
      { ...host, extra: 1 },
    ])
      expect(input.codexHostInputSchema.safeParse(bad).success).toBe(false);
    expect(
      input.codexHostInputSchema.safeParse({ ...host, version: "1.2.3-rc.1" })
        .success,
    ).toBe(true);
  });
});

describe("Codex failure and live input", () => {
  it("lists the closed failure sets", () => {
    expect(input.codexHostFailureSchema.options).toEqual([
      "unreachable",
      "unsupported",
    ]);
    expect(input.codexHostLiveFailureSchema.options).toEqual([
      "failed",
      "model_unavailable",
      "outcome_unknown",
    ]);
    expect(input.codexAgentFailureSchema.options).toEqual([
      "failed",
      "running",
      "outcome_unknown",
      "workspace_not_verified",
    ]);
    expect(input.codexHostFailureSchema.safeParse("failed").success).toBe(
      false,
    );
    expect(input.codexAgentFailureSchema.safeParse("other").success).toBe(
      false,
    );
  });
  it("pins the live model", () => {
    const live = {
      model: "gpt-6-astra",
      executableSha256: sha,
      schemaSha256: sha,
      buildId: sha,
    };
    expect(input.codexHostLiveInputSchema.safeParse(live).success).toBe(true);
    expect(
      input.codexHostLiveInputSchema.safeParse({ ...live, model: "gpt-5" })
        .success,
    ).toBe(false);
    expect(
      input.codexHostLiveInputSchema.safeParse({ ...live, extra: 1 }).success,
    ).toBe(false);
    expect(
      input.codexHostLiveInputSchema.safeParse({ ...live, buildId: "x" })
        .success,
    ).toBe(false);
  });
});

describe("secure MCP input", () => {
  it("checks the tunnel client", () => {
    const client = {
      executablePath,
      executableSha256: sha,
      version: "0.1.0",
      protocol: "openai-tunnel-client/v1",
    };
    const schema = input.secureMcpTunnelClientInputSchema;
    expect(schema.safeParse(client).success).toBe(true);
    expect(schema.safeParse({ ...client, protocol: "x" }).success).toBe(false);
    expect(schema.safeParse({ ...client, version: "v1" }).success).toBe(false);
    expect(schema.safeParse({ ...client, extra: 1 }).success).toBe(false);
  });
  it("checks the tunnel id", () => {
    const schema = input.secureMcpTunnelInputSchema;
    expect(schema.safeParse({ tunnelId: "a.B_c:1-2" }).success).toBe(true);
    expect(schema.safeParse({ tunnelId: "x".repeat(160) }).success).toBe(true);
    expect(schema.safeParse({ tunnelId: "x".repeat(161) }).success).toBe(false);
    expect(schema.safeParse({ tunnelId: "" }).success).toBe(false);
    expect(schema.safeParse({ tunnelId: "a b" }).success).toBe(false);
    expect(schema.safeParse({ tunnelId: "a", extra: 1 }).success).toBe(false);
  });
  it("checks the runtime record", () => {
    const runtime = {
      state: "ready",
      runtimeGeneration: sha,
      computerGeneration: 1,
      buildId: sha,
    };
    const schema = input.secureMcpRuntimeInputSchema;
    expect(schema.safeParse(runtime).success).toBe(true);
    for (const state of ["unreachable", "outcome_unknown"])
      expect(schema.safeParse({ ...runtime, state }).success).toBe(true);
    for (const bad of [
      { ...runtime, state: "stopped" },
      { ...runtime, computerGeneration: 0 },
      { ...runtime, computerGeneration: 1.5 },
      { ...runtime, runtimeGeneration: "short" },
      { ...runtime, extra: 1 },
    ])
      expect(schema.safeParse(bad).success).toBe(false);
  });
  it("checks the attachment record", () => {
    const attachment = {
      workspaceId: uuid,
      runtimeGeneration: sha,
      computerGeneration: 2,
      buildId: sha,
      challengeSha256: sha,
      receiptSha256: sha,
    };
    const schema = input.secureMcpAttachmentInputSchema;
    expect(schema.safeParse(attachment).success).toBe(true);
    expect(schema.safeParse({ ...attachment, workspaceId: null }).success).toBe(
      true,
    );
    for (const bad of [
      { ...attachment, workspaceId: uuid.replace("-4234-", "-1234-") },
      { ...attachment, workspaceId: uuid.toUpperCase() },
      { ...attachment, workspaceId: undefined },
      { ...attachment, computerGeneration: -1 },
      { ...attachment, receiptSha256: "a" },
      { ...attachment, extra: 1 },
    ])
      expect(schema.safeParse(bad).success).toBe(false);
  });
  it("checks the challenge record", () => {
    const challenge = {
      challenge: uuid,
      runtimeGeneration: sha,
      computerGeneration: 3,
      buildId: sha,
    };
    const schema = input.secureMcpChallengeInputSchema;
    expect(schema.safeParse(challenge).success).toBe(true);
    for (const bad of [
      { ...challenge, challenge: "nope" },
      { ...challenge, challenge: null },
      { ...challenge, computerGeneration: 0 },
      { ...challenge, extra: 1 },
    ])
      expect(schema.safeParse(bad).success).toBe(false);
  });
});
