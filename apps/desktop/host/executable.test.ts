import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductConfigurationResultSchema } from "../../../src/pkg/product-settings/contract";
import { TUNNEL_CLIENT } from "../tunnel-client-contract";
import { createExecutableHost, type ExecutableHostPorts } from "./executable";

// The Codex and tunnel-client selection and verification over real temporary
// files, with the probes and the settings service scripted. Nothing here runs a
// real binary or checks a signature: the probes are the sole authority on that
// and are covered by their own tests. Every owner is read through a getter the
// test can change after the factory is built, so a test proves a value is taken
// at the call, not at construction.

type Recorded = { ok: true } | { ok: false; error: string };

const snapshot = { status: "error", error: "SETTINGS_READ_FAILED" } as const;
const sha = (character: string) => character.repeat(64);
const roots: string[] = [];

async function scratch(): Promise<string> {
  const made = await realpath(await mkdtemp(path.join(os.tmpdir(), "exe-")));
  roots.push(made);
  return made;
}

async function file(directory: string, ...segments: string[]): Promise<string> {
  const target = path.join(directory, ...segments);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "#!/bin/sh\n");
  return target;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

const codexProbe = {
  executablePath: "/fixture/codex",
  executableSha256: sha("a"),
  version: "1.2.3",
  protocol: "codex-app-server/v2",
  schemaSha256: sha("b"),
  taskSource: null,
  capabilities: {
    dynamicTools: true,
    correlatedToolCalls: true,
    descendantObservation: true,
    collabObservation: true,
    compaction: true,
  },
};

function tunnelProbe(executablePath: string) {
  return {
    executablePath,
    executableSha256: TUNNEL_CLIENT.sha256,
    version: TUNNEL_CLIENT.version,
    protocol: "openai-tunnel-client/v1",
  };
}

async function fixture() {
  const directory = await scratch();
  const state = {
    present: true,
    running: false as boolean | null,
    window: { id: "window" } as { id: string } | null,
    env: {} as Record<string, string | undefined>,
    dialog: { canceled: false, filePaths: [] as string[] },
    codexProbe: vi.fn(
      async (..._arguments: unknown[]) => codexProbe as unknown,
    ),
    tunnelProbe: vi.fn(async (..._arguments: unknown[]) => ({}) as unknown),
    recordCodexHost: vi.fn(async (_input: unknown): Promise<Recorded> => ({
      ok: true,
    })),
    recordCodexHostFailure: vi.fn(async (_kind: string): Promise<Recorded> => ({
      ok: true,
    })),
    recordTunnel: vi.fn(async (_input: unknown): Promise<Recorded> => ({
      ok: true,
    })),
  };
  const configuration = {
    recordCodexHost: async (input: unknown) => {
      const result = await state.recordCodexHost(input);
      return result.ok ? { ok: true, snapshot } : { ...result, snapshot };
    },
    recordCodexHostFailure: async (kind: string) => {
      const result = await state.recordCodexHostFailure(kind);
      return result.ok ? { ok: true, snapshot } : { ...result, snapshot };
    },
    recordSecureMcpTunnelClient: async (input: unknown) => {
      const result = await state.recordTunnel(input);
      return result.ok ? { ok: true, snapshot } : { ...result, snapshot };
    },
  };
  const showOpenDialog = vi.fn(async (_owner: unknown, _options: unknown) => ({
    canceled: state.dialog.canceled,
    filePaths: state.dialog.filePaths,
  }));
  const failure = vi.fn((error: string) => ({
    ok: false as const,
    error,
    snapshot,
  }));
  const ports = {
    configuration: () => (state.present ? configuration : null),
    secureMcpConnectorRuntime: () =>
      state.running === null ? null : { isRunning: () => state.running },
    window: () => state.window,
    showOpenDialog,
    statePaths: () => ({ codexHostProbe: path.join(directory, "probe") }),
    buildIdentity: { buildId: sha("c") },
    directory,
    configurationFailure: failure,
    probeCodexHost: (...input: unknown[]) => state.codexProbe(...input),
    probeTunnelClient: (...input: unknown[]) => state.tunnelProbe(...input),
    env: state.env,
  };
  return {
    state,
    directory,
    bundled: path.join(directory, TUNNEL_CLIENT.entry),
    showOpenDialog,
    failure,
    subject: createExecutableHost(ports as unknown as ExecutableHostPorts),
  };
}

function failed(error: string) {
  return ProductConfigurationResultSchema.parse({ ok: false, error, snapshot });
}

describe("e2eCodexExecutable", () => {
  it("is nothing outside an E2E run, whatever the override says", async () => {
    const s = await fixture();
    const target = await file(s.directory, "codex");
    s.state.env.FAROL_E2E_CODEX_EXECUTABLE = target;
    expect(s.subject.e2eCodexExecutable()).toBeUndefined();
    s.state.env.FAROL_E2E = "0";
    expect(s.subject.e2eCodexExecutable()).toBeUndefined();
    s.state.env.FAROL_E2E = "true";
    expect(s.subject.e2eCodexExecutable()).toBeUndefined();
  });

  it("is nothing in an E2E run that names no override", async () => {
    const s = await fixture();
    s.state.env.FAROL_E2E = "1";
    expect(s.subject.e2eCodexExecutable()).toBeUndefined();
  });

  it("accepts an absolute path from an E2E run, read at the call", async () => {
    const s = await fixture();
    const target = await file(s.directory, "bin", "codex");
    s.state.env.FAROL_E2E = "1";
    s.state.env.FAROL_E2E_CODEX_EXECUTABLE = target;
    expect(s.subject.e2eCodexExecutable()).toBe(target);
    delete s.state.env.FAROL_E2E;
    expect(s.subject.e2eCodexExecutable()).toBeUndefined();
  });

  it("marks a relative, empty or NUL-bearing override invalid", async () => {
    const s = await fixture();
    s.state.env.FAROL_E2E = "1";
    for (const value of ["codex", "./codex", "", "/abs/co\0dex"]) {
      s.state.env.FAROL_E2E_CODEX_EXECUTABLE = value;
      expect(s.subject.e2eCodexExecutable()).toBe("invalid");
    }
  });
});

describe("selectedCodexExecutable", () => {
  it("returns the E2E override without opening a dialog", async () => {
    const s = await fixture();
    const target = await file(s.directory, "codex");
    s.state.env.FAROL_E2E = "1";
    s.state.env.FAROL_E2E_CODEX_EXECUTABLE = target;
    expect(await s.subject.selectedCodexExecutable()).toBe(target);
    expect(s.showOpenDialog).not.toHaveBeenCalled();
  });

  it("returns an invalid E2E override as invalid, not a dialog choice", async () => {
    const s = await fixture();
    s.state.env.FAROL_E2E = "1";
    s.state.env.FAROL_E2E_CODEX_EXECUTABLE = "relative/codex";
    expect(await s.subject.selectedCodexExecutable()).toBe("invalid");
    expect(s.showOpenDialog).not.toHaveBeenCalled();
  });

  it("refuses without a window and opens nothing", async () => {
    const s = await fixture();
    s.state.window = null;
    expect(await s.subject.selectedCodexExecutable()).toBe("invalid");
    expect(s.showOpenDialog).not.toHaveBeenCalled();
  });

  it("asks the owner with the fixed prompt and takes the one chosen file", async () => {
    const s = await fixture();
    const target = await file(s.directory, "picked", "codex");
    s.state.dialog.filePaths = [target];
    expect(await s.subject.selectedCodexExecutable()).toBe(target);
    expect(s.showOpenDialog).toHaveBeenCalledWith(s.state.window, {
      title: "Choose the Codex executable",
      buttonLabel: "Verify Codex",
      properties: ["openFile"],
      securityScopedBookmarks: false,
    });
  });

  it("is cancelled when the dialog is cancelled, empty or returns several", async () => {
    const s = await fixture();
    const one = await file(s.directory, "one");
    const two = await file(s.directory, "two");
    s.state.dialog = { canceled: true, filePaths: [one] };
    expect(await s.subject.selectedCodexExecutable()).toBe("cancelled");
    s.state.dialog = { canceled: false, filePaths: [] };
    expect(await s.subject.selectedCodexExecutable()).toBe("cancelled");
    s.state.dialog = { canceled: false, filePaths: [one, two] };
    expect(await s.subject.selectedCodexExecutable()).toBe("cancelled");
  });

  it("refuses a chosen path that is relative, empty or carries a NUL", async () => {
    const s = await fixture();
    for (const value of ["codex", "", "/abs/co\0dex"]) {
      s.state.dialog = { canceled: false, filePaths: [value] };
      expect(await s.subject.selectedCodexExecutable()).toBe("invalid");
    }
  });
});

describe("verifyCodexExecutable", () => {
  it("refuses without a settings service before probing", async () => {
    const s = await fixture();
    s.state.present = false;
    expect(await s.subject.verifyCodexExecutable("/fixture/codex")).toEqual(
      failed("SETTINGS_UNAVAILABLE"),
    );
    expect(s.state.codexProbe).not.toHaveBeenCalled();
  });

  it("probes in the scratch root, records the probed contract and returns its evidence", async () => {
    const s = await fixture();
    const target = await file(s.directory, "codex");
    const result = await s.subject.verifyCodexExecutable(target);
    expect(s.state.codexProbe).toHaveBeenCalledWith({
      executablePath: target,
      scratchRoot: path.join(s.directory, "probe"),
    });
    expect(s.state.recordCodexHost).toHaveBeenCalledWith({
      executablePath: "/fixture/codex",
      executableSha256: sha("a"),
      version: "1.2.3",
      protocol: "codex-app-server/v2",
      schemaSha256: sha("b"),
      taskSource: null,
      buildId: sha("c"),
    });
    expect(result).toEqual({
      ok: true,
      snapshot,
      evidence: {
        kind: "host.codex-probe",
        version: "1.2.3",
        protocol: "codex-app-server/v2",
        executableSha256: sha("a"),
        schemaSha256: sha("b"),
        capabilities: codexProbe.capabilities,
      },
    });
    expect(s.state.recordCodexHostFailure).not.toHaveBeenCalled();
  });

  it("hands a discovery expectation to the probe only when one was supplied", async () => {
    const s = await fixture();
    const target = await file(s.directory, "codex");
    const expected = { canonicalPath: target, sha256: sha("d") };
    await s.subject.verifyCodexExecutable(target, expected);
    expect(s.state.codexProbe).toHaveBeenLastCalledWith({
      executablePath: target,
      scratchRoot: path.join(s.directory, "probe"),
      expectedDiscovery: expected,
    });
  });

  it("returns a refused record unchanged and shows no evidence", async () => {
    const s = await fixture();
    s.state.recordCodexHost.mockResolvedValue({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
    });
    expect(await s.subject.verifyCodexExecutable("/fixture/codex")).toEqual(
      failed("SETTINGS_WRITE_FAILED"),
    );
    expect(s.state.recordCodexHostFailure).not.toHaveBeenCalled();
  });

  it("refuses a stale discovery candidate without recording a failure", async () => {
    const s = await fixture();
    s.state.codexProbe.mockRejectedValue(
      new Error("CODEX_HOST_DISCOVERY_CANDIDATE_STALE"),
    );
    expect(await s.subject.verifyCodexExecutable("/fixture/codex")).toEqual(
      failed("CODEX_HOST_DISCOVERY_CANDIDATE_STALE"),
    );
    expect(s.state.recordCodexHostFailure).not.toHaveBeenCalled();
    expect(s.state.recordCodexHost).not.toHaveBeenCalled();
  });

  it.each([
    ["CODEX_HOST_INCOMPATIBLE", "unsupported", "CODEX_HOST_INCOMPATIBLE"],
    [
      "CODEX_HOST_SELECTION_INVALID",
      "unreachable",
      "CODEX_HOST_SELECTION_INVALID",
    ],
    [
      "CODEX_HOST_EXECUTABLE_UNSAFE",
      "unreachable",
      "CODEX_HOST_EXECUTABLE_UNSAFE",
    ],
    ["SOMETHING_ELSE", "unreachable", "CODEX_HOST_PROBE_FAILED"],
  ])(
    "records %s as %s, then refuses with %s",
    async (thrown, kind, refusal) => {
      const s = await fixture();
      s.state.codexProbe.mockRejectedValue(new Error(thrown));
      expect(await s.subject.verifyCodexExecutable("/fixture/codex")).toEqual(
        failed(refusal),
      );
      expect(s.state.recordCodexHostFailure).toHaveBeenCalledExactlyOnceWith(
        kind,
      );
    },
  );

  it("treats a thrown non-error as an unreachable host", async () => {
    const s = await fixture();
    s.state.codexProbe.mockRejectedValue("boom");
    expect(await s.subject.verifyCodexExecutable("/fixture/codex")).toEqual(
      failed("CODEX_HOST_PROBE_FAILED"),
    );
    expect(s.state.recordCodexHostFailure).toHaveBeenCalledExactlyOnceWith(
      "unreachable",
    );
  });

  it("returns the failure record's own refusal and does not map the probe error", async () => {
    const s = await fixture();
    s.state.codexProbe.mockRejectedValue(
      new Error("CODEX_HOST_EXECUTABLE_UNSAFE"),
    );
    s.state.recordCodexHostFailure.mockResolvedValue({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
    });
    expect(await s.subject.verifyCodexExecutable("/fixture/codex")).toEqual(
      failed("SETTINGS_WRITE_FAILED"),
    );
  });
});

describe("e2eTunnelClientExecutable", () => {
  it("is nothing outside an E2E run or without an override", async () => {
    const s = await fixture();
    const target = await file(s.directory, "tunnel");
    s.state.env.FAROL_E2E_TUNNEL_CLIENT = target;
    expect(s.subject.e2eTunnelClientExecutable()).toBeUndefined();
    delete s.state.env.FAROL_E2E_TUNNEL_CLIENT;
    s.state.env.FAROL_E2E = "1";
    expect(s.subject.e2eTunnelClientExecutable()).toBeUndefined();
  });

  it("accepts an absolute path and marks any other value invalid", async () => {
    const s = await fixture();
    const target = await file(s.directory, "tunnel");
    s.state.env.FAROL_E2E = "1";
    s.state.env.FAROL_E2E_TUNNEL_CLIENT = target;
    expect(s.subject.e2eTunnelClientExecutable()).toBe(target);
    for (const value of ["tunnel", "", "/abs/tun\0nel"]) {
      s.state.env.FAROL_E2E_TUNNEL_CLIENT = value;
      expect(s.subject.e2eTunnelClientExecutable()).toBe("invalid");
    }
  });
});

describe("selectedTunnelClientExecutable", () => {
  it("is the bundled client, with no dialog", async () => {
    const s = await fixture();
    expect(await s.subject.selectedTunnelClientExecutable()).toBe(s.bundled);
    expect(s.showOpenDialog).not.toHaveBeenCalled();
  });

  it("is the E2E fixture while one is named, and invalid for a bad one", async () => {
    const s = await fixture();
    const target = await file(s.directory, "fixture-tunnel");
    s.state.env.FAROL_E2E = "1";
    s.state.env.FAROL_E2E_TUNNEL_CLIENT = target;
    expect(await s.subject.selectedTunnelClientExecutable()).toBe(target);
    s.state.env.FAROL_E2E_TUNNEL_CLIENT = "relative";
    expect(await s.subject.selectedTunnelClientExecutable()).toBe("invalid");
  });
});

describe("verifyTunnelClientExecutable", () => {
  it("refuses without a settings service before probing", async () => {
    const s = await fixture();
    s.state.present = false;
    expect(await s.subject.verifyTunnelClientExecutable(s.bundled)).toEqual(
      failed("SETTINGS_UNAVAILABLE"),
    );
    expect(s.state.tunnelProbe).not.toHaveBeenCalled();
  });

  it("refuses an external path before probing or recording it", async () => {
    const s = await fixture();
    const outside = await file(s.directory, "elsewhere", "tunnel-client");
    expect(await s.subject.verifyTunnelClientExecutable(outside)).toEqual(
      failed("TUNNEL_CLIENT_EXECUTABLE_UNSAFE"),
    );
    expect(s.state.tunnelProbe).not.toHaveBeenCalled();
    expect(s.state.recordTunnel).not.toHaveBeenCalled();
  });

  it("pins the bundled bytes whatever expectation was supplied", async () => {
    const s = await fixture();
    s.state.tunnelProbe.mockResolvedValue(tunnelProbe(s.bundled));
    const result = await s.subject.verifyTunnelClientExecutable(s.bundled, {
      canonicalPath: "/arbitrary",
      sha256: sha("f"),
    });
    expect(s.state.tunnelProbe).toHaveBeenCalledExactlyOnceWith({
      executablePath: s.bundled,
      expectedDiscovery: {
        canonicalPath: s.bundled,
        sha256: TUNNEL_CLIENT.sha256,
      },
    });
    expect(s.state.recordTunnel).toHaveBeenCalledExactlyOnceWith(
      tunnelProbe(s.bundled),
    );
    expect(result).toEqual({
      ok: true,
      snapshot,
      evidence: {
        kind: "connector.client-probe",
        version: TUNNEL_CLIENT.version,
        protocol: "openai-tunnel-client/v1",
        executableSha256: TUNNEL_CLIENT.sha256,
      },
    });
  });

  it("probes the exact E2E fixture with the supplied expectation, and nothing else", async () => {
    const s = await fixture();
    const fixturePath = await file(s.directory, "fixture-tunnel");
    s.state.env.FAROL_E2E = "1";
    s.state.env.FAROL_E2E_TUNNEL_CLIENT = fixturePath;
    s.state.tunnelProbe.mockResolvedValue(tunnelProbe(fixturePath));
    await s.subject.verifyTunnelClientExecutable(fixturePath);
    expect(s.state.tunnelProbe).toHaveBeenLastCalledWith({
      executablePath: fixturePath,
    });
    const expected = { canonicalPath: fixturePath, sha256: sha("e") };
    await s.subject.verifyTunnelClientExecutable(fixturePath, expected);
    expect(s.state.tunnelProbe).toHaveBeenLastCalledWith({
      executablePath: fixturePath,
      expectedDiscovery: expected,
    });
    s.state.tunnelProbe.mockClear();
    const other = await file(s.directory, "another-tunnel");
    expect(await s.subject.verifyTunnelClientExecutable(other)).toEqual(
      failed("TUNNEL_CLIENT_EXECUTABLE_UNSAFE"),
    );
    expect(s.state.tunnelProbe).not.toHaveBeenCalled();
  });

  it("does not take a fixture outside an E2E run or an invalid one", async () => {
    const s = await fixture();
    const fixturePath = await file(s.directory, "fixture-tunnel");
    s.state.env.FAROL_E2E_TUNNEL_CLIENT = fixturePath;
    expect(await s.subject.verifyTunnelClientExecutable(fixturePath)).toEqual(
      failed("TUNNEL_CLIENT_EXECUTABLE_UNSAFE"),
    );
    s.state.env.FAROL_E2E = "1";
    s.state.env.FAROL_E2E_TUNNEL_CLIENT = "invalid";
    expect(await s.subject.verifyTunnelClientExecutable("invalid")).toEqual(
      failed("TUNNEL_CLIENT_EXECUTABLE_UNSAFE"),
    );
    expect(s.state.tunnelProbe).not.toHaveBeenCalled();
  });

  it("does not replace a running connector's saved client, after the probe and before the record", async () => {
    const s = await fixture();
    s.state.tunnelProbe.mockResolvedValue(tunnelProbe(s.bundled));
    s.state.running = true;
    expect(await s.subject.verifyTunnelClientExecutable(s.bundled)).toEqual(
      failed("CONNECTOR_STOP_REQUIRED"),
    );
    expect(s.state.tunnelProbe).toHaveBeenCalledOnce();
    expect(s.state.recordTunnel).not.toHaveBeenCalled();
    // The runtime is read at the check, so a connector that stopped meanwhile
    // no longer blocks, and a missing runtime never does.
    s.state.running = false;
    expect((await s.subject.verifyTunnelClientExecutable(s.bundled)).ok).toBe(
      true,
    );
    s.state.running = null;
    expect((await s.subject.verifyTunnelClientExecutable(s.bundled)).ok).toBe(
      true,
    );
  });

  it("returns a refused record unchanged", async () => {
    const s = await fixture();
    s.state.tunnelProbe.mockResolvedValue(tunnelProbe(s.bundled));
    s.state.recordTunnel.mockResolvedValue({
      ok: false,
      error: "SETTINGS_WRITE_FAILED",
    });
    expect(await s.subject.verifyTunnelClientExecutable(s.bundled)).toEqual(
      failed("SETTINGS_WRITE_FAILED"),
    );
  });

  it.each([
    [
      "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE",
      "TUNNEL_CLIENT_DISCOVERY_CANDIDATE_STALE",
    ],
    ["TUNNEL_CLIENT_SELECTION_INVALID", "TUNNEL_CLIENT_SELECTION_INVALID"],
    ["TUNNEL_CLIENT_EXECUTABLE_UNSAFE", "TUNNEL_CLIENT_EXECUTABLE_UNSAFE"],
    ["TUNNEL_CLIENT_INCOMPATIBLE", "TUNNEL_CLIENT_INCOMPATIBLE"],
    ["TUNNEL_CLIENT_PROBE_FAILED", "TUNNEL_CLIENT_PROBE_FAILED"],
    ["SOMETHING_ELSE", "TUNNEL_CLIENT_PROBE_FAILED"],
  ])("maps a probe error %s to the refusal %s", async (thrown, refusal) => {
    const s = await fixture();
    s.state.tunnelProbe.mockRejectedValue(new Error(thrown));
    expect(await s.subject.verifyTunnelClientExecutable(s.bundled)).toEqual(
      failed(refusal),
    );
    expect(s.state.recordTunnel).not.toHaveBeenCalled();
  });

  it("treats a thrown non-error as a failed probe", async () => {
    const s = await fixture();
    s.state.tunnelProbe.mockRejectedValue("boom");
    expect(await s.subject.verifyTunnelClientExecutable(s.bundled)).toEqual(
      failed("TUNNEL_CLIENT_PROBE_FAILED"),
    );
  });
});
