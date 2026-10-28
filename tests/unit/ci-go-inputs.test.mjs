import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  realpathSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  execFileSync: vi.fn(),
  measureGoToolchain: vi.fn(),
}));
vi.mock("node:fs", () => ({ default: mocks }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));
vi.mock("../../tooling/go-backend-build.mjs", () => ({
  measureGoToolchain: mocks.measureGoToolchain,
}));
import { provisionGoInputs } from "../../tooling/ci-go-inputs.mjs";

const modules = [
  ["github.com/google/go-cmp", "v0.6.0"],
  ["github.com/m-mizutani/gt", "v0.1.0"],
  ["github.com/m-mizutani/masq", "v0.2.3"],
  ["golang.org/x/sys", "v0.35.0"],
  ["golang.org/x/text", "v0.28.0"],
];
const approval = {
  schema: "farol-ci-go-sdk/1",
  version: "go1.26.2",
  goos: "darwin",
  goarch: "arm64",
  treeSha256: "a".repeat(64),
};

// Provisioning contract fixtures only: no SDK, downloads or shared outputs.
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
  mocks.existsSync.mockReturnValue(true);
  mocks.readFileSync.mockReturnValue(JSON.stringify(approval));
  mocks.realpathSync.mockImplementation((file) => file);
  mocks.measureGoToolchain.mockResolvedValue(approval.treeSha256);
  mocks.execFileSync.mockImplementation((_command, args) => {
    if (args[0] === "version") return "go version go1.26.2 darwin/arm64\n";
    if (args[0] === "env") return "/fixture/sdk\n";
    const [modulePath, version] = args[3].split("@");
    return JSON.stringify({
      Path: modulePath,
      Version: version,
      Zip: `/fixture/cache/${modulePath}/@v/${version}.zip`,
      GoMod: `/fixture/cache/${modulePath}/@v/${version}.mod`,
      Dir: `/fixture/cache/${modulePath}@${version}`,
    });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("CI Go input provisioning", () => {
  it("provisions exactly the pinned five-module graph and exclusively creates its declaration", async () => {
    await provisionGoInputs();
    expect(mocks.execFileSync.mock.calls.slice(2)).toEqual(
      modules.map(([modulePath, version]) => [
        "go",
        ["mod", "download", "-json", `${modulePath}@${version}`],
        { encoding: "utf8", timeout: 120000 },
      ]),
    );
    expect(mocks.writeFileSync).toHaveBeenCalledOnce();
    const [file, contents, options] = mocks.writeFileSync.mock.calls[0];
    expect(file).toBe(path.resolve("_output/go-build-inputs.json"));
    expect(options).toEqual({ mode: 0o600, flag: "wx" });
    expect(JSON.parse(contents)).toEqual({
      schema: "farol-go-build-inputs/1",
      toolchain: {
        root: "/fixture/sdk",
        treeSha256: approval.treeSha256,
        version: approval.version,
        goos: approval.goos,
        goarch: approval.goarch,
      },
      moduleInputs: modules.map(([modulePath, version]) => ({
        modulePath,
        version,
        zipPath: `/fixture/cache/${modulePath}/@v/${version}.zip`,
        modPath: `/fixture/cache/${modulePath}/@v/${version}.mod`,
        contentRoot: `/fixture/cache/${modulePath}@${version}`,
        zipHashPath: `/fixture/cache/${modulePath}/@v/${version}.ziphash`,
      })),
    });
  });

  it.each(["Path", "Version", "Error"])(
    "refuses a masq download with invalid %s before writing a declaration",
    async (key) => {
      const download = mocks.execFileSync.getMockImplementation();
      mocks.execFileSync.mockImplementation((command, args) => {
        const result = download(command, args);
        if (args[3] !== "github.com/m-mizutani/masq@v0.2.3") return result;
        return JSON.stringify({ ...JSON.parse(result), [key]: "unexpected" });
      });
      await expect(provisionGoInputs()).rejects.toThrow(
        "CI_GO_MODULE_INPUT_INVALID",
      );
      expect(mocks.writeFileSync).not.toHaveBeenCalled();
    },
  );

  it("preserves an existing declaration when exclusive creation refuses it", async () => {
    const error = Object.assign(new Error("fixture output already exists"), {
      code: "EEXIST",
    });
    mocks.writeFileSync.mockImplementation(() => {
      throw error;
    });
    await expect(provisionGoInputs()).rejects.toBe(error);
    expect(mocks.writeFileSync).toHaveBeenCalledOnce();
    expect(mocks.writeFileSync.mock.calls[0][2].flag).toBe("wx");
  });
});
