import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertOwnerPreviewIdle,
  assertNativePreviewAdmission,
  recheckNativePreviewIsolation,
  readOwnedStartupMarker,
} from "../e2e/native-preview-admission.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function root() {
  const value = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-native-admission-"),
  );
  roots.push(value);
  return value;
}

describe("native owner Preview admission", () => {
  it("accepts an absent marker without creating state", async () => {
    const base = await root();
    const missing = path.join(base, "missing");
    await expect(assertOwnerPreviewIdle(missing)).resolves.toEqual({
      stateRoot: missing,
      marker: "absent",
    });
    await expect(fs.lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["regular", "symlink", "directory"])(
    "refuses an existing %s marker without changing it",
    async (kind) => {
      const base = await root();
      const marker = path.join(base, "running.json");
      if (kind === "regular")
        await fs.writeFile(marker, "private marker bytes");
      if (kind === "symlink")
        await fs.symlink(path.join(base, "not-readable-target"), marker);
      if (kind === "directory") await fs.mkdir(marker);
      const before = await fs.lstat(marker);
      await expect(assertOwnerPreviewIdle(base)).rejects.toThrow(
        "NATIVE_OWNER_PREVIEW_NOT_CONFIRMED_IDLE",
      );
      const after = await fs.lstat(marker);
      expect([after.dev, after.ino, after.size, after.mtimeMs]).toEqual([
        before.dev,
        before.ino,
        before.size,
        before.mtimeMs,
      ]);
    },
  );
  it("refuses an unavailable metadata observation", async () => {
    await expect(
      assertOwnerPreviewIdle("/fixture", async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }),
    ).rejects.toThrow("NATIVE_OWNER_PREVIEW_STATE_UNREADABLE");
  });
});

describe("owned native startup witness", () => {
  const marker = {
    schema: 1,
    pid: process.pid,
    startedAt: "2026-09-29T00:00:00.000Z",
    bootTime: null,
    processStart: null,
  };
  async function state() {
    const base = await root();
    const owned = path.join(base, "user-data/farol-next-state");
    await fs.mkdir(owned, { recursive: true });
    await fs.writeFile(
      path.join(owned, "running.json"),
      JSON.stringify(marker),
      { mode: 0o600 },
    );
    return { base, owned, file: path.join(owned, "running.json") };
  }
  it("correlates the actual private marker with the launched process", async () => {
    const { base, owned } = await state();
    await expect(
      readOwnedStartupMarker(owned, base, process.pid),
    ).resolves.toEqual(marker);
  });
  it("rejects an outside state root and a different process", async () => {
    const { base, owned } = await state();
    const other = await root();
    await expect(
      readOwnedStartupMarker(owned, other, process.pid),
    ).rejects.toThrow("NATIVE_STARTUP_STATE_NOT_OWNED");
    await expect(
      readOwnedStartupMarker(owned, base, process.pid + 1),
    ).rejects.toThrow("NATIVE_STARTUP_MARKER_WRONG_PROCESS");
  });
  it.each(["symlink", "directory", "oversized"])(
    "rejects a %s marker without consuming it as a stream",
    async (kind) => {
      const { base, owned, file } = await state();
      await fs.unlink(file);
      if (kind === "symlink")
        await fs.symlink(path.join(base, "missing-target"), file);
      if (kind === "directory") await fs.mkdir(file);
      if (kind === "oversized") await fs.writeFile(file, "x".repeat(4097));
      await expect(
        readOwnedStartupMarker(owned, base, process.pid),
      ).rejects.toThrow("NATIVE_STARTUP_MARKER_TYPE_OR_SIZE");
    },
  );
});

// Server address/listening below are synthetic metadata. No socket is bound,
// no process is started, and these cases are not native-effect qualification.
describe("hidden disposable Setup admission", () => {
  async function selection(environment = "preview", normalProfile = false) {
    const profileRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-next-e2e-home-")),
    );
    roots.push(profileRoot);
    await fs.chmod(profileRoot, 0o700);
    const proof = randomUUID();
    await fs.writeFile(path.join(profileRoot, ".farol-next-e2e-root"), proof, {
      mode: 0o600,
    });
    const appData = path.join(profileRoot, "app-data");
    const userData =
      environment === "dev"
        ? path.join(appData, "Farol Dev")
        : normalProfile
          ? path.join(appData, "Farol Next Preview")
          : path.join(profileRoot, "user-data");
    await fs.mkdir(appData, { mode: 0o700 });
    await fs.mkdir(userData, { mode: 0o700 });
    const fixture = new Server();
    Object.defineProperty(fixture, "listening", {
      value: true,
      configurable: true,
    });
    fixture.address = () => ({
      address: "127.0.0.1",
      port: 32123,
      family: "IPv4",
    });
    const launchOptions = {
      executablePath: "/fixture/Electron",
      args: [
        ...(normalProfile
          ? []
          : ["/fixture/main.cjs", `--user-data-dir=${userData}`]),
        "--preview-window-mode=hidden",
      ],
      env: {
        HOME: profileRoot,
        TMPDIR: os.tmpdir(),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "en_US.UTF-8",
        FAROL_NEXT_E2E: "1",
        FAROL_NEXT_E2E_APP_DATA: appData,
        FAROL_NEXT_E2E_TEST_ROOT: profileRoot,
        FAROL_NEXT_E2E_TEST_PROOF: proof,
        FAROL_NEXT_E2E_CHATGPT_URL: "http://127.0.0.1:32123/",
        ...(environment === "dev" ? { FAROL_NEXT_ENVIRONMENT: "dev" } : {}),
      },
      timeout: 15000,
    };
    return {
      profileRoot,
      proof,
      launchOptions,
      fixture,
      actual: {
        home: profileRoot,
        userData,
        sessionData: userData,
        temp: os.tmpdir(),
        windows: [{ visible: false, focused: false }],
      },
    };
  }
  const admit = (value) =>
    assertNativePreviewAdmission("/unavailable-owner-profile", value);
  it.each([
    ["preview", false],
    ["dev", false],
    ["preview", true],
  ])(
    "admits %s (normal profile %s) without observing the owner's state",
    async (environment, normal) => {
      const selected = await selection(environment, normal);
      const receipt = await admit(selected);
      expect(receipt.kind).toBe("isolated-native-preview-preflight");
      expect(Object.isFrozen(receipt)).toBe(true);
      const observed = await recheckNativePreviewIsolation(
        receipt,
        selected.actual,
      );
      expect(Object.isFrozen(observed)).toBe(true);
      expect(observed.kind).toBe("isolated-native-preview-readback");
      await expect(
        admit({ ...selected, previous: observed }),
      ).resolves.toMatchObject({ profileRoot: selected.profileRoot });
    },
  );
  it("retains the owner-idle requirement for a non-isolated caller", async () => {
    const base = await root();
    await fs.writeFile(
      path.join(base, "running.json"),
      "unreadable-by-contract",
    );
    await expect(assertNativePreviewAdmission(base)).rejects.toThrow(
      "NATIVE_OWNER_PREVIEW_NOT_CONFIRMED_IDLE",
    );
    await expect(assertNativePreviewAdmission(base, null)).rejects.toThrow(
      "NATIVE_ISOLATION_NOT_ESTABLISHED",
    );
  });
  it.each([
    [
      "disabled E2E",
      (s) => {
        s.launchOptions.env.FAROL_NEXT_E2E = "0";
      },
    ],
    [
      "borrowed HOME",
      (s) => {
        s.launchOptions.env.HOME = "/owner";
      },
    ],
    [
      "foreign appData",
      (s) => {
        s.launchOptions.env.FAROL_NEXT_E2E_APP_DATA = "/owner/app-data";
      },
    ],
    [
      "proof mismatch",
      (s) => {
        s.launchOptions.env.FAROL_NEXT_E2E_TEST_PROOF = randomUUID();
      },
    ],
    [
      "credential environment",
      (s) => {
        s.launchOptions.env.CODEX_HOME = "/owner/.codex";
      },
    ],
    [
      "loader injection",
      (s) => {
        s.launchOptions.env.NODE_OPTIONS = "--require /owner/hook";
      },
    ],
    [
      "unknown environment",
      (s) => {
        s.launchOptions.env.FAROL_NEXT_ENVIRONMENT = "production";
      },
    ],
    [
      "outside temp",
      (s) => {
        s.launchOptions.env.TMPDIR = s.profileRoot;
      },
    ],
    [
      "visible mode",
      (s) => {
        s.launchOptions.args[s.launchOptions.args.length - 1] =
          "--preview-window-mode=secondary-visible";
      },
    ],
    [
      "duplicate hidden mode",
      (s) => {
        s.launchOptions.args.push("--preview-window-mode=hidden");
      },
    ],
    [
      "unknown launch flag",
      (s) => {
        s.launchOptions.args.push("--remote-debugging-port=1234");
      },
    ],
    [
      "foreign userData",
      (s) => {
        s.launchOptions.args[1] = "--user-data-dir=/owner";
      },
    ],
    [
      "public Browser URL",
      (s) => {
        s.launchOptions.env.FAROL_NEXT_E2E_CHATGPT_URL = "https://chatgpt.com/";
      },
    ],
    [
      "wrong fixture port",
      (s) => {
        s.launchOptions.env.FAROL_NEXT_E2E_CHATGPT_URL =
          "http://127.0.0.1:32124/";
      },
    ],
    [
      "fixture credentials",
      (s) => {
        s.launchOptions.env.FAROL_NEXT_E2E_CHATGPT_URL =
          "http://user:secret@127.0.0.1:32123/";
      },
    ],
    [
      "unowned fixture",
      (s) => {
        s.fixture = {
          listening: true,
          address: () => ({ address: "127.0.0.1", port: 32123 }),
        };
      },
    ],
    [
      "unbound fixture",
      (s) => {
        Object.defineProperty(s.fixture, "listening", { value: false });
      },
    ],
    [
      "nonloopback bind",
      (s) => {
        s.fixture.address = () => ({ address: "0.0.0.0", port: 32123 });
      },
    ],
    [
      "unowned workspace",
      (s) => {
        s.launchOptions.env.FAROL_NEXT_E2E_WORKSPACE_ROOT = "/owner/work";
      },
    ],
    [
      "unowned executable",
      (s) => {
        s.launchOptions.env.FAROL_NEXT_E2E_TUNNEL_CLIENT = "/owner/client";
      },
    ],
  ])("refuses %s before launch", async (_name, change) => {
    const selected = await selection();
    change(selected);
    await expect(admit(selected)).rejects.toThrow(
      "NATIVE_ISOLATION_NOT_ESTABLISHED",
    );
  });
  it.each([
    "root-mode",
    "proof-mode",
    "proof-link",
    "proof-hardlink",
    "home-link",
    "descendant-link",
    "descendant-hardlink",
  ])("refuses unsafe %s metadata", async (kind) => {
    const selected = await selection();
    const file = path.join(selected.profileRoot, ".farol-next-e2e-root");
    const other = await root();
    if (kind === "root-mode") await fs.chmod(selected.profileRoot, 0o755);
    if (kind === "proof-mode") await fs.chmod(file, 0o644);
    if (kind === "proof-link") {
      await fs.rename(file, path.join(other, "proof"));
      await fs.symlink(path.join(other, "proof"), file);
    }
    if (kind === "proof-hardlink")
      await fs.link(file, path.join(other, "borrowed-proof"));
    if (kind === "home-link") {
      await fs.symlink(selected.profileRoot, path.join(other, "home"));
      selected.profileRoot =
        selected.launchOptions.env.HOME =
        selected.launchOptions.env.FAROL_NEXT_E2E_TEST_ROOT =
          path.join(other, "home");
    }
    if (kind === "descendant-link")
      await fs.symlink(other, path.join(selected.actual.userData, "foreign"));
    if (kind === "descendant-hardlink") {
      const source = path.join(other, "credential");
      await fs.writeFile(source, "synthetic");
      await fs.link(source, path.join(selected.actual.userData, "borrowed"));
    }
    await expect(admit(selected)).rejects.toThrow(
      "NATIVE_ISOLATION_NOT_ESTABLISHED",
    );
  });
  it("refuses a correctly named proof root outside OS temp", async () => {
    const selected = await selection();
    const outside = path.join(
      await root(),
      path.basename(selected.profileRoot),
    );
    await fs.rename(selected.profileRoot, outside);
    selected.profileRoot =
      selected.launchOptions.env.HOME =
      selected.launchOptions.env.FAROL_NEXT_E2E_TEST_ROOT =
        outside;
    await expect(admit(selected)).rejects.toThrow(
      "NATIVE_ISOLATION_NOT_ESTABLISHED",
    );
  });
  it("binds auxiliary workspace and tunnel fixture metadata", async () => {
    const selected = await selection();
    const auxiliaryRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "farol-guided-setup-")),
    );
    roots.push(auxiliaryRoot);
    await fs.chmod(auxiliaryRoot, 0o700);
    await fs.writeFile(
      path.join(auxiliaryRoot, ".farol-next-e2e-root"),
      selected.proof,
      { mode: 0o600 },
    );
    const workspace = path.join(auxiliaryRoot, "approved-folder");
    const tunnel = path.join(auxiliaryRoot, "tunnel-client.cjs");
    await fs.mkdir(workspace, { mode: 0o700 });
    await fs.writeFile(tunnel, "synthetic executable", { mode: 0o700 });
    selected.auxiliaryRoot = auxiliaryRoot;
    selected.launchOptions.env.FAROL_NEXT_E2E_WORKSPACE_ROOT = workspace;
    selected.launchOptions.env.FAROL_NEXT_E2E_TUNNEL_CLIENT = tunnel;
    const receipt = await admit(selected);
    const observed = await recheckNativePreviewIsolation(
      receipt,
      selected.actual,
    );
    await fs.unlink(tunnel);
    await fs.symlink("/outside", tunnel);
    await expect(
      recheckNativePreviewIsolation(observed, selected.actual),
    ).rejects.toThrow("NATIVE_ISOLATION_TREE_UNSAFE");
  });
  it.each([
    "home",
    "userData",
    "sessionData",
    "temp",
    "visible",
    "focused",
    "no-windows",
    "proof",
    "directory",
    "endpoint",
  ])("rejects changed %s readback", async (kind) => {
    const selected = await selection();
    const receipt = await admit(selected);
    if (["home", "userData", "sessionData", "temp"].includes(kind))
      selected.actual[kind] = await root();
    if (kind === "visible") selected.actual.windows[0].visible = true;
    if (kind === "focused") selected.actual.windows[0].focused = true;
    if (kind === "no-windows") selected.actual.windows = [];
    if (kind === "proof")
      await fs.writeFile(
        path.join(selected.profileRoot, ".farol-next-e2e-root"),
        selected.proof,
      );
    if (kind === "directory") {
      await fs.rename(
        selected.actual.userData,
        selected.actual.userData + "-previous",
      );
      await fs.mkdir(selected.actual.userData, { mode: 0o700 });
    }
    if (kind === "endpoint")
      Object.defineProperty(selected.fixture, "listening", { value: false });
    await expect(
      recheckNativePreviewIsolation(receipt, selected.actual),
    ).rejects.toThrow();
  });
  it("requires a verified immutable predecessor receipt for reopen", async () => {
    const selected = await selection();
    const receipt = await admit(selected);
    await expect(admit({ ...selected, previous: receipt })).rejects.toThrow(
      "NATIVE_ISOLATION_NOT_ESTABLISHED",
    );
    await expect(
      recheckNativePreviewIsolation({ ...receipt }, selected.actual),
    ).rejects.toThrow("NATIVE_ISOLATION_RECEIPT_INVALID");
    const observed = await recheckNativePreviewIsolation(
      receipt,
      selected.actual,
    );
    await expect(
      admit({ ...selected, previous: { ...observed } }),
    ).rejects.toThrow("NATIVE_ISOLATION_NOT_ESTABLISHED");
    await expect(
      admit({ ...(await selection()), previous: observed }),
    ).rejects.toThrow("NATIVE_ISOLATION_NOT_ESTABLISHED");
  });
  it("consumes readback witnesses even when validation fails", async () => {
    const selected = await selection();
    const receipt = await admit(selected);
    selected.actual.windows[0].visible = true;
    await expect(
      recheckNativePreviewIsolation(receipt, selected.actual),
    ).rejects.toThrow("NATIVE_ISOLATION_NATIVE_WINDOW_CHANGED");
    selected.actual.windows[0].visible = false;
    await expect(
      recheckNativePreviewIsolation(receipt, selected.actual),
    ).rejects.toThrow("NATIVE_ISOLATION_RECEIPT_INVALID");
    const fresh = await admit(selected);
    const observed = await recheckNativePreviewIsolation(
      fresh,
      selected.actual,
    );
    await expect(
      recheckNativePreviewIsolation(fresh, selected.actual),
    ).rejects.toThrow("NATIVE_ISOLATION_RECEIPT_INVALID");
    await expect(
      admit({ ...selected, previous: observed }),
    ).resolves.toBeDefined();
    await expect(admit({ ...selected, previous: observed })).rejects.toThrow(
      "NATIVE_ISOLATION_NOT_ESTABLISHED",
    );
  });
  it("refuses a marker in its disposable profile without reading it", async () => {
    const selected = await selection();
    const stateRoot = path.join(selected.actual.userData, "farol-next-state");
    await fs.mkdir(stateRoot, { mode: 0o700 });
    const file = path.join(stateRoot, "running.json");
    await fs.writeFile(file, "synthetic unknown prior run", { mode: 0o600 });
    const before = await fs.lstat(file);
    await expect(admit(selected)).rejects.toMatchObject({
      cause: { message: "NATIVE_ISOLATION_PRIOR_RUN_UNCONFIRMED" },
    });
    expect((await fs.lstat(file)).ino).toBe(before.ino);
  });
  it.each(["foreign-owner", "unreadable"])(
    "refuses %s metadata",
    async (kind) => {
      const selected = await selection();
      const original = fs.lstat.bind(fs);
      const observation = vi
        .spyOn(fs, "lstat")
        .mockImplementation(async (file, ...args) => {
          if (file !== selected.profileRoot) return original(file, ...args);
          if (kind === "unreadable")
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          const info = await original(file, ...args);
          info.uid += 1;
          return info;
        });
      try {
        await expect(admit(selected)).rejects.toThrow(
          "NATIVE_ISOLATION_NOT_ESTABLISHED",
        );
      } finally {
        observation.mockRestore();
      }
    },
  );
  it.each(["FAROL_MODEL_ENABLED", "FAROL_BACKED_PRODUCT_AGENT_ENABLED"])(
    "refuses an enabled %s source gate",
    async (gate) => {
      const selected = await selection();
      vi.resetModules();
      vi.doMock("../../src/apps/desktop/foundation-feature-gates.ts", () => ({
        FAROL_MODEL_ENABLED: gate === "FAROL_MODEL_ENABLED",
        FAROL_BACKED_PRODUCT_AGENT_ENABLED:
          gate === "FAROL_BACKED_PRODUCT_AGENT_ENABLED",
      }));
      try {
        const guarded = await import("../e2e/native-preview-admission.mjs");
        await expect(
          guarded.assertNativePreviewAdmission(
            "/unavailable-owner-profile",
            selected,
          ),
        ).rejects.toMatchObject({
          cause: { message: "NATIVE_ISOLATION_MODEL_GATE_CHANGED" },
        });
      } finally {
        vi.doUnmock("../../src/apps/desktop/foundation-feature-gates.ts");
        vi.resetModules();
      }
    },
  );
  it("refuses a preexisting relay namespace and binds the owned new directory", async () => {
    const selected = await selection();
    const receipt = await admit(selected);
    // Mint only the unique namespace derived from this disposable test root.
    await fs.mkdir(receipt.relayRoot, { mode: 0o700 });
    roots.push(receipt.relayRoot);
    await expect(admit(selected)).rejects.toThrow(
      "NATIVE_ISOLATION_NOT_ESTABLISHED",
    );
    const observed = await recheckNativePreviewIsolation(
      receipt,
      selected.actual,
    );
    const reopened = await admit({ ...selected, previous: observed });
    const reopenedWitness = await recheckNativePreviewIsolation(
      reopened,
      selected.actual,
    );
    await fs.rename(
      receipt.relayRoot,
      path.join(selected.profileRoot, "old-relay"),
    );
    await fs.mkdir(receipt.relayRoot, { mode: 0o700 });
    await expect(
      admit({ ...selected, previous: reopenedWitness }),
    ).rejects.toMatchObject({
      cause: { message: "NATIVE_ISOLATION_RELAY_OVERLAP" },
    });
  });
});
