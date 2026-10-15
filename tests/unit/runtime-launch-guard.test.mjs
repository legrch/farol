import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILD_ENTRIES } from "../../tooling/build-contract.mjs";
import { GO_CORE_ENTRIES } from "../../tooling/go-core-artifact.mjs";
import {
  RUNTIME_LAUNCH_MANIFEST,
  assertRuntimeLaunchManifest,
  verifyRuntimeExecutableClosure,
} from "../../tooling/runtime-launch-manifest.mjs";
import { inspectRuntimeLaunches } from "../../tooling/check-runtime-launches.mjs";

// Synthetic source/files only. Fixture hashes are local test expectations, never
// compiler, native, shipped-package, provider or independently trusted evidence.
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
const file = "src/fixture.ts";
const manifest = (changes = {}) => ({
  ...structuredClone(RUNTIME_LAUNCH_MANIFEST),
  roots: [],
  launches: [],
  embedded: [],
  commands: [],
  ...changes,
});
const route = (changes = {}) => ({
  id: "fixture.launch",
  file,
  symbol: "entry",
  api: "spawn",
  executable: '"/usr/bin/python3"',
  classification: "legacy-python-active",
  resources: [],
  count: 1,
  ...changes,
});
const inspect = (source, m = manifest(), name = file) =>
  inspectRuntimeLaunches(new Map([[name, source]]), m);
const issue = (result, prefix) =>
  result.issues.some((x) => x.startsWith(prefix));

describe("semantic runtime launch ratchet", () => {
  it("retains all four unresolved Python callsites by function, not a zero-Python assertion", () => {
    const rows = RUNTIME_LAUNCH_MANIFEST.launches.filter((row) =>
      ["legacy-python-active", "go-with-legacy-python"].includes(
        row.classification,
      ),
    );
    expect(rows.map((row) => `${row.file}:${row.symbol}`).sort()).toEqual([
      "src/modules/computer/infra/native/native-readonly-workspace.ts:runHelper",
      "src/modules/computer/infra/native/workspace-snapshot.ts:spawnSnapshotHelper",
      "src/modules/release/infra/native/installed-update-helper.ts:publishInstalledOperationBinding",
      "src/modules/release/infra/native/installed-update-helper.ts:startInstalledUpdateHelper",
    ]);
    expect(
      RUNTIME_LAUNCH_MANIFEST.boundaries.map((row) => row.classification),
    ).toContain("optional-user-hook-runtime");
    expect(
      RUNTIME_LAUNCH_MANIFEST.boundaries.map((row) => row.classification),
    ).toContain("build-test-maintenance-only");
  });
  it("ignores line movement and comments without weakening function/command identity", () => {
    const source =
      'import { spawn } from "node:child_process"; export function entry(){ spawn("/usr/bin/python3", []); }';
    const m = manifest({ launches: [route()] });
    expect(inspect(source, m).ok).toBe(true);
    expect(
      inspect(
        "\n\n// moved source\n" +
          source.replace('spawn("', 'spawn( /* comment */ "'),
        m,
      ).ok,
    ).toBe(true);
    expect(
      issue(
        inspect(source.replace("function entry", "function renamed"), m),
        "STALE_OR_CHANGED_LAUNCH",
      ),
    ).toBe(true);
  });
  it.each([
    'import { spawn as child } from "node:child_process"; const launch=child; function entry(){launch("/usr/bin/python3",[]);}',
    'import * as cp from "child_process"; const launch=cp["spawn"]; function entry(){launch("/usr/bin/python3",[]);}',
    'const {spawn: launch}=require("node:child_process"); function entry(){launch("/usr/bin/python3",[]);}',
    'import { spawn } from "child_process"; const launch=spawn.bind(null); function entry(){launch("/usr/bin/python3",[]);}',
    'import { spawn } from "child_process"; function entry(){spawn.call(null,"/usr/bin/python3",[]);}',
  ])(
    "recognizes process API aliases instead of scanning only spawn spelling",
    (source) => {
      const result = inspect(source);
      expect(issue(result, "DIRECT_TOOLCHAIN")).toBe(true);
      expect(issue(result, "UNDECLARED_LAUNCH")).toBe(true);
    },
  );
  it("recognizes promisify and constants but respects a shadowed import", () => {
    const source =
      'import {execFile} from "node:child_process"; import {promisify as p} from "node:util"; const execute=p(execFile); const python="python3"; function entry(){execute(python,[]);}';
    expect(issue(inspect(source), "DIRECT_TOOLCHAIN")).toBe(true);
    expect(
      inspect(
        'import {spawn} from "child_process"; function entry(spawn){spawn("python3");}',
      ).launches,
    ).toEqual([]);
  });
  it("does not hide a new literal toolchain inside a declared conditional executable", () => {
    const source =
      'import {spawn} from "node:child_process"; const executable=selected ? bundled : "/usr/bin/node"; function entry(){spawn(executable,[]);}';
    const m = manifest({
      launches: [
        route({
          executable: "executable",
          classification: "go-with-legacy-python",
        }),
      ],
    });
    expect(issue(inspect(source, m), "DIRECT_TOOLCHAIN")).toBe(true);
    expect(
      inspect(source.replace("/usr/bin/node", "/usr/bin/python3"), m).ok,
    ).toBe(true);
  });
  it.each([
    "/usr/bin/python3",
    "python",
    "node",
    "npm",
    "npx",
    "go",
    "/usr/bin/xcrun",
  ])("rejects a new direct interpreter/toolchain %s", (program) => {
    expect(
      issue(
        inspect(
          `import {spawn} from "child_process"; function entry(){spawn(${JSON.stringify(program)},[]);}`,
        ),
        "DIRECT_TOOLCHAIN",
      ),
    ).toBe(true);
  });
  it("finds env and shell interpreter selection and interpreter shebang templates", () => {
    expect(
      issue(
        inspect(
          'import {spawn} from "child_process"; function entry(){spawn("/usr/bin/env",["python3","-c","pass"]);}',
        ),
        "DIRECT_TOOLCHAIN",
      ),
    ).toBe(true);
    expect(
      issue(
        inspect(
          'import {spawn} from "child_process"; function entry(){spawn("/bin/sh",["-c","python3 helper.py"]);}',
        ),
        "DIRECT_TOOLCHAIN",
      ),
    ).toBe(true);
    expect(
      issue(
        inspect('const script=`#!/usr/bin/python3\nprint("hello")`;'),
        "SCRIPT_TOOLCHAIN",
      ),
    ).toBe(true);
  });
  it("rejects unresolved launcher member selection and assignment aliases", () => {
    expect(
      issue(
        inspect(
          'import * as cp from "child_process"; function entry(kind){cp[kind]("python3");}',
        ),
        "DYNAMIC_LAUNCHER_MEMBER",
      ),
    ).toBe(true);
    expect(
      issue(
        inspect(
          'import {spawn} from "child_process"; let launch; launch=spawn; function entry(){launch("python3");}',
        ),
        "LAUNCHER_ASSIGNMENT",
      ),
    ).toBe(true);
  });
  it("requires exact dynamic launcher scope, counts and non-stale exceptions", () => {
    const source =
      'import {spawn} from "child_process"; function entry(executable){spawn(executable,[]);}';
    const m = manifest({
      launches: [
        route({
          executable: "executable",
          classification: "confined-user-command",
        }),
      ],
    });
    expect(inspect(source, m).ok).toBe(true);
    expect(inspect(source).ok).toBe(false);
    expect(
      inspect(
        source.replace(
          "spawn(executable,[]);",
          "spawn(executable,[]);spawn(executable,[]);",
        ),
        m,
      ).ok,
    ).toBe(false);
    expect(inspect("export function entry(){}", m).ok).toBe(false);
    const wrongException = manifest({
      launches: [route({ executable: '"go"' })],
    });
    expect(
      issue(
        inspect(
          'import {spawn} from "child_process"; function entry(){spawn("go",[]);}',
          wrongException,
        ),
        "DIRECT_TOOLCHAIN",
      ),
    ).toBe(true);
  });
  it("parses declared embedded launchers and refuses a new or changed embedded launcher", () => {
    const source =
      'const WATCHDOG=String.raw`const {spawn}=require("child_process"); spawn(selected.executable, selected.args);`;';
    const m = manifest({
      embedded: [
        {
          file,
          symbol: "WATCHDOG",
          classification: "confined-user-command",
          expressions: ["selected.executable"],
        },
      ],
    });
    expect(inspect(source, m).ok).toBe(true);
    expect(inspect(source).ok).toBe(false);
    expect(
      inspect(source.replace("selected.executable", '"python3"'), m).ok,
    ).toBe(false);
    expect(inspect("", m).ok).toBe(false);
  });
  it("has closed manifest classifications and resource membership", () => {
    expect(() =>
      assertRuntimeLaunchManifest(manifest({ unexpected: true })),
    ).toThrow("MANIFEST_INVALID");
    expect(() =>
      assertRuntimeLaunchManifest(
        manifest({
          launches: [route({ classification: "approved-everything" })],
        }),
      ),
    ).toThrow("LAUNCH_INVALID");
    expect(() =>
      assertRuntimeLaunchManifest(
        manifest({ launches: [route({ resources: ["new-helper"] })] }),
      ),
    ).toThrow("RESOURCE_UNMANIFESTED");
    expect(() =>
      assertRuntimeLaunchManifest(
        manifest({
          resources: [
            {
              key: "new-helper",
              ledger: "build",
              kind: "go-macho",
              owner: "tooling/build-contract.mjs",
              mode: "executable",
            },
          ],
        }),
      ),
    ).toThrow("RESOURCE_LEDGER_UNKNOWN");
  });
  it("inventories Go Command aliases by receiver/function and rejects newly selected Go toolchains", () => {
    const name = "modules/fixture/native.go";
    const source =
      'package fixture\nimport child "os/exec"\nfunc (n boundary) Start(){ child.Command("python3", "-c", "pass") }';
    const result = inspect(source, manifest(), name);
    expect(result.launches[0]).toMatchObject({
      symbol: "boundary.Start",
      api: "go.Command",
      executable: '"python3"',
    });
    expect(issue(result, "DIRECT_TOOLCHAIN")).toBe(true);
    expect(
      issue(
        inspect(
          'package fixture\nimport "os/exec"\nvar run=exec.Command\n',
          manifest(),
          name,
        ),
        "GO_LAUNCHER_ALIAS",
      ),
    ).toBe(true);
  });
});

describe("selected Settings Go route", () => {
  const command = {
    id: "settings.search",
    file,
    symbol: "configure",
    command: "computer.search-workspace",
    classification: "selected-go",
    requiredCall: "desktopGoCore.searchSettingsWorkspace",
    allowedCalls: [
      "desktopGoCore.searchSettingsWorkspace",
      "workspaceReadFailure",
    ],
  };
  const m = manifest({ commands: [command] });
  const source =
    'async function configure(command){switch(command.kind){case "computer.search-workspace": {try{return await desktopGoCore.searchSettingsWorkspace(command.pattern);}catch(error){return workspaceReadFailure(error);}}}}';
  it("accepts the Go edge with terminal error handling", () =>
    expect(inspect(source, m).ok).toBe(true));
  it("truthfully refuses old main's legacy route and any direct catch fallback", () => {
    expect(
      issue(
        inspect(
          source.replace(
            "desktopGoCore.searchSettingsWorkspace",
            "nativeWorkspace.execute",
          ),
          m,
        ),
        "SELECTED_ROUTE_CHANGED",
      ),
    ).toBe(true);
    expect(
      issue(
        inspect(
          source.replace(
            "return workspaceReadFailure(error);",
            "return fallback(error);",
          ),
          m,
        ),
        "SELECTED_ROUTE_CHANGED",
      ),
    ).toBe(true);
  });
  it("refuses a nonterminal catch and a stale command owner", () => {
    expect(
      issue(
        inspect(
          source.replace(
            "return workspaceReadFailure(error);",
            "workspaceReadFailure(error);",
          ),
          m,
        ),
        "SELECTED_ROUTE_NOT_TERMINAL",
      ),
    ).toBe(true);
    expect(
      inspect(source.replace("function configure", "function renamed"), m).ok,
    ).toBe(false);
    expect(
      issue(
        inspect(source.replace("return await", "return"), m),
        "SELECTED_ROUTE_NOT_TERMINAL",
      ),
    ).toBe(true);
  });
});

async function packageFixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "farol-runtime-guard-"),
  );
  roots.push(directory);
  const entrySha256 = {};
  const resources = new Map(
    RUNTIME_LAUNCH_MANIFEST.resources.map((row) => [row.key, row]),
  );
  async function write(name, bytes, mode = 0o644) {
    await fs.writeFile(path.join(directory, name), bytes, { mode });
    await fs.chmod(path.join(directory, name), mode);
    entrySha256[name] = createHash("sha256").update(bytes).digest("hex");
  }
  for (const name of [...BUILD_ENTRIES, ...GO_CORE_ENTRIES]) {
    const row = resources.get(name);
    await write(
      name,
      row?.kind === "go-macho"
        ? Buffer.from("cffaedfe00000000", "hex")
        : Buffer.from(
            row?.kind === "python-source"
              ? "# synthetic Python source\n"
              : "synthetic fixture data\n",
          ),
      row?.mode === "executable" ? 0o700 : 0o644,
    );
  }
  return { directory, entrySha256, write };
}
describe("bounded owned executable closure", () => {
  it("treats update-archive.py as declared Go Mach-O, independent of suffix", async () => {
    const f = await packageFixture();
    await expect(verifyRuntimeExecutableClosure(f)).resolves.toMatchObject({
      nativeQualification: false,
    });
    expect(
      RUNTIME_LAUNCH_MANIFEST.resources.find(
        (row) => row.key === "update-archive.py",
      ).kind,
    ).toBe("go-macho");
  });
  it("rejects missing and mistyped owned executables", async () => {
    const f = await packageFixture();
    await fs.unlink(path.join(f.directory, "farol-backend"));
    await expect(verifyRuntimeExecutableClosure(f)).rejects.toThrow();
    await f.write("farol-backend", Buffer.from("not a native binary"), 0o700);
    await expect(verifyRuntimeExecutableClosure(f)).rejects.toThrow(
      "EXECUTABLE_KIND_MISMATCH",
    );
  });
  it("rejects nonexecutable Go, executable Python and symlink resources", async () => {
    const f = await packageFixture();
    await fs.chmod(path.join(f.directory, "farol-backend"), 0o600);
    await expect(verifyRuntimeExecutableClosure(f)).rejects.toThrow(
      "EXECUTABLE_KIND_MISMATCH",
    );
    await fs.chmod(path.join(f.directory, "farol-backend"), 0o700);
    await fs.chmod(path.join(f.directory, "farol-backend"), 0o777);
    await expect(verifyRuntimeExecutableClosure(f)).rejects.toThrow(
      "EXECUTABLE_MODE_INVALID",
    );
    await fs.chmod(path.join(f.directory, "farol-backend"), 0o700);
    await fs.chmod(path.join(f.directory, "computer-safe-open.py"), 0o700);
    await expect(verifyRuntimeExecutableClosure(f)).rejects.toThrow(
      "EXECUTABLE_KIND_MISMATCH",
    );
    await fs.chmod(path.join(f.directory, "computer-safe-open.py"), 0o644);
    await fs.unlink(path.join(f.directory, "farol-backend"));
    await fs.symlink(
      path.join(f.directory, "update-archive.py"),
      path.join(f.directory, "farol-backend"),
    );
    await expect(verifyRuntimeExecutableClosure(f)).rejects.toThrow(
      "PACKAGE_ENTRY_TYPE",
    );
  });
  it("rejects an unmanifested Mach-O even without executable mode", async () => {
    const f = await packageFixture();
    await f.write("shell.js", Buffer.from("cffaedfe00000000", "hex"));
    await expect(verifyRuntimeExecutableClosure(f)).rejects.toThrow(
      "EXECUTABLE_UNMANIFESTED",
    );
  });
  it("rejects an added package executable or substituted host interpreter script", async () => {
    const f = await packageFixture();
    await fs.writeFile(
      path.join(f.directory, "surprise"),
      "#!/usr/bin/python3\n",
      { mode: 0o700 },
    );
    await expect(verifyRuntimeExecutableClosure(f)).rejects.toThrow(
      "PACKAGE_ENTRY_UNMANIFESTED",
    );
    await fs.unlink(path.join(f.directory, "surprise"));
    await f.write("runtime.cjs", Buffer.from("#!/usr/bin/python3\npass\n"));
    await expect(verifyRuntimeExecutableClosure(f)).rejects.toThrow(
      "EXECUTABLE_KIND_MISMATCH",
    );
  });
  it("uses existing ledger expectations and never repairs a byte mismatch", async () => {
    const f = await packageFixture();
    const expected = { ...f.entrySha256 };
    await fs.appendFile(path.join(f.directory, "runtime.cjs"), "changed");
    await expect(
      verifyRuntimeExecutableClosure({ ...f, entrySha256: expected }),
    ).rejects.toThrow("BUILD_ENTRY_DIGEST_MISMATCH");
    expect(f.entrySha256).toEqual(expected);
  });
});
