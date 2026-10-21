// Provision the existing producer declaration; never self-approve a measured SDK.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { measureGoToolchain } from "./go-backend-build.mjs";

export async function provisionGoInputs() {
  const approvalPath = "config/ci-go-sdk.json";
  if (!fs.existsSync(approvalPath))
    throw Error(
      "CI_GO_SDK_APPROVAL_REQUIRED: commit a separately approved config/ci-go-sdk.json; a measured digest is not approval",
    );
  const approval = JSON.parse(fs.readFileSync(approvalPath, "utf8"));
  if (
    approval.schema !== "farol-ci-go-sdk/1" ||
    approval.version !== "go1.26.2" ||
    approval.goos !== "darwin" ||
    approval.goarch !== "arm64" ||
    !/^[a-f0-9]{64}$/u.test(approval.treeSha256 ?? "")
  )
    throw Error("CI_GO_SDK_APPROVAL_INVALID");
  const go = (...args) =>
    execFileSync("go", args, { encoding: "utf8", timeout: 120000 });
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    go("version").trim() !== "go version go1.26.2 darwin/arm64"
  )
    throw Error("CI_GO_SDK_PLATFORM_INVALID");
  const root = fs.realpathSync(go("env", "GOROOT").trim());
  if ((await measureGoToolchain(root)) !== approval.treeSha256)
    throw Error("CI_GO_SDK_DIGEST_MISMATCH");
  const moduleInputs = [
    ["golang.org/x/sys", "v0.35.0"],
    ["golang.org/x/text", "v0.28.0"],
  ].map(([modulePath, version]) => {
    const result = JSON.parse(
      go("mod", "download", "-json", `${modulePath}@${version}`),
    );
    if (
      result.Error ||
      result.Path !== modulePath ||
      result.Version !== version
    )
      throw Error("CI_GO_MODULE_INPUT_INVALID");
    return {
      modulePath,
      version,
      zipPath: fs.realpathSync(result.Zip),
      modPath: fs.realpathSync(result.GoMod),
      contentRoot: fs.realpathSync(result.Dir),
      zipHashPath: fs.realpathSync(result.Zip + "hash"),
    };
  });
  const declaration = {
    schema: "farol-go-build-inputs/1",
    toolchain: {
      root,
      treeSha256: approval.treeSha256,
      version: approval.version,
      goos: approval.goos,
      goarch: approval.goarch,
    },
    moduleInputs,
  };
  fs.mkdirSync("_output", { recursive: true });
  fs.writeFileSync(
    path.resolve("_output/go-build-inputs.json"),
    JSON.stringify(declaration, null, 2) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  await provisionGoInputs();
