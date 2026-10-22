import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";
import { desktopIdentity } from "../../tooling/harness-identity.ts";

const helper = "tooling/harness-identity.ts";
const scopes = ["tests/e2e", "tests/fixtures", "tooling"];
// Exact files only, never directory/pattern exceptions. Each exception owns a
// fixed product contract, historical reader, rejection case or displayed copy.
const allowlist = new Map([
  ["tooling/build.mjs", "Writes the fixed product build identity."],
  [
    "tooling/build-identity-contract.mjs",
    "Validates the fixed product build identity.",
  ],
  ["tooling/package.mjs", "Writes product bundle metadata and notices."],
  [
    "tooling/package-layout.mjs",
    "Defines current and historical package layouts.",
  ],
  [
    "tooling/resource-contract.mjs",
    "Defines the published product resource contract.",
  ],
  [
    "tooling/verify-package-content.mjs",
    "Rejects bundles with incorrect product metadata.",
  ],
  [
    "tooling/replace-installed-preview.mjs",
    "Validates the exact installed product pair.",
  ],
  [
    "tooling/replace-installed-preview.py",
    "Descriptor-bound installer validates fixed bundle leaves.",
  ],
  [
    "tooling/promotion-apply.py",
    "Descriptor-bound promotion validates fixed bundle leaves.",
  ],
  ["tooling/hunt-report.mjs", "Rejects evidence for another product build."],
  [
    "tooling/supervised-update-resources.mjs",
    "Rejects updates for another product identity.",
  ],
  [
    "tooling/update-slot-observer.mjs",
    "Validates the installed product update slot.",
  ],
  ["tooling/package-platform.mjs", "Writes the fixed product bundle plist."],
  [
    "tooling/prepare-release-archive.py",
    "Validates the exact published product artifact.",
  ],
  [
    "tooling/runtime-launch-manifest.mjs",
    "Retains the versioned product launch schema.",
  ],
  [
    "tooling/closed-preview-repair.mjs",
    "Reads historical installed-profile metadata.",
  ],
  [
    "tooling/closed-preview-repair.py",
    "Reads historical installed-profile metadata.",
  ],
  [
    "tooling/promotion-lease.mjs",
    "Reads the historical installed lock domain.",
  ],
  [
    "tooling/retire-preview-install.mjs",
    "Reads the historical installed product identity.",
  ],
  [
    "tooling/retire-preview-install.py",
    "Rejects current bundles during historical retirement.",
  ],
  [
    "tooling/supervised-update-backup.mjs",
    "Reads and backs up the historical installed pair.",
  ],
  [
    "tests/e2e/predecessor-package-path.mjs",
    "Reads exact historical package layouts.",
  ],
  [
    "tests/e2e/owner-preview-isolation.e2e.mjs",
    "Rejects access to literal owner and historical profile paths.",
  ],
  [
    "tests/fixtures/shell-launch.json",
    "Rejection fixture protects installed bundle resources.",
  ],
  [
    "tests/fixtures/shell-launch-git-resources.json",
    "Rejection fixture protects installed bundle Git resources.",
  ],
  [
    "tests/fixtures/go-architecture/cases.json",
    "Rejection fixture models the exact generated-code header.",
  ],
  [
    "tests/e2e/preview.e2e.mjs",
    "Asserts displayed product copy and rejects a foreign bundle ID.",
  ],
  [
    "tests/e2e/dev-onboarding-startup.e2e.mjs",
    "Asserts welcome copy and rejects the historical Dev profile.",
  ],
  ["tests/e2e/first-launch-reopen.e2e.mjs", "Asserts displayed welcome copy."],
  [
    "tests/e2e/onboarding-visual.e2e.mjs",
    "Asserts the displayed project-removal control label.",
  ],
  [
    "tests/e2e/guided-setup-selection.e2e.mjs",
    "Asserts the displayed external-connection confirmation.",
  ],
  [
    "tests/e2e/current-react-setup.mjs",
    "Waits for the displayed connection status to disappear.",
  ],
  [
    "tests/e2e/lib/read-conversation-witness.mjs",
    "Asserts displayed conversation and browser-readiness copy.",
  ],
  [
    "tests/e2e/writable-recovery.e2e.mjs",
    "Asserts displayed canary content across edits and recovery.",
  ],
  [
    "tests/e2e/lib/settings-mutation-witness.mjs",
    "Defines exact displayed canary text for mutation assertions.",
  ],
  [
    "tests/e2e/fixtures/go-read-discard-witness.mjs",
    "Asserts exact displayed multilingual read-canary content.",
  ],
  [
    "tests/e2e/codex-task-mcp.e2e.mjs",
    "Asserts the displayed native-observer canary title.",
  ],
]);
const identities = ["preview", "dev", "owner-preview"].map((environment) =>
  desktopIdentity(environment, "/__identity_guard__"),
);
const productName = identities[0].displayName;
const literals = new Set([
  ...identities.flatMap((identity) => [
    identity.displayName,
    identity.applicationName,
    identity.applicationId,
    path.basename(identity.userData),
    path.basename(identity.sessionData),
    identity.runtimePartition,
    identity.runtimePartition.slice("persist:".length),
    identity.chatGptPartition,
    identity.chatGptPartition.slice("persist:".length),
    identity.runtimeIdentity,
    identity.runtimeServiceName,
  ]),
  "farol_next",
  "persist:farol-next",
  "farol-next",
  "local.farol.next",
]);
const displayNameToken = new RegExp(`\\b${RegExp.escape(productName)}\\b`, "u");
function pinned(value) {
  return (
    displayNameToken.test(value) ||
    [...literals].some(
      (literal) => literal !== productName && value.includes(literal),
    )
  );
}
function violations(source, file = "fixture.mjs") {
  // Scan all text first: strings, paths, regexes, comments and unknown formats
  // have the same rule. Parsing below only adds decoded/constant expressions.
  const lines = source.split("\n");
  const failures = new Set(
    lines.flatMap((line, index) => (pinned(line) ? [index + 1] : [])),
  );
  if (/\.(?:mjs|cjs|mts|cts|ts|tsx|js|jsx)$/u.test(file)) {
    const ast = parse(source, {
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx"],
    });
    function joined(node) {
      if (node?.type === "StringLiteral") return node.value;
      if (node?.type === "TemplateLiteral") {
        let value = node.quasis[0].value.cooked;
        if (value === null) return undefined;
        for (let index = 0; index < node.expressions.length; index++) {
          const expression = joined(node.expressions[index]);
          const quasi = node.quasis[index + 1].value.cooked;
          if (expression === undefined || quasi === null) return undefined;
          value += expression + quasi;
        }
        return value;
      }
      if (node?.type === "BinaryExpression" && node.operator === "+") {
        const left = joined(node.left),
          right = joined(node.right);
        if (left !== undefined && right !== undefined) return left + right;
      }
      return undefined;
    }
    function walk(node) {
      if (!node || typeof node !== "object") return;
      const value =
        node.type === "TemplateElement"
          ? (node.value.cooked ?? node.value.raw)
          : joined(node);
      if (value !== undefined && pinned(value))
        failures.add(node.loc.start.line);
      for (const [key, child] of Object.entries(node)) {
        if (["loc", "extra"].includes(key)) continue;
        if (Array.isArray(child)) child.forEach(walk);
        else if (child && typeof child === "object") walk(child);
      }
    }
    walk(ast);
  }
  return [...failures]
    .sort((a, b) => a - b)
    .map((line) => `${line}:${lines[line - 1]}`);
}
async function harnessViolations(root) {
  const failures = [];
  for (const directory of scopes) {
    for (const relative of await fs.readdir(path.join(root, directory), {
      recursive: true,
    })) {
      const file = `${directory}/${relative}`;
      if (file === helper || allowlist.has(file)) continue;
      const absolute = path.join(root, file);
      const stat = await fs.lstat(absolute);
      // A link could point a scanned path at unscanned text, so none are allowed.
      if (stat.isSymbolicLink()) {
        failures.push(`${file}:symbolic link in a harness scope`);
        continue;
      }
      if (!stat.isFile()) continue;
      const bytes = await fs.readFile(absolute);
      if (bytes.includes(0)) continue;
      failures.push(
        ...violations(bytes.toString("utf8"), file).map(
          (entry) => `${file}:${entry}`,
        ),
      );
    }
  }
  return failures;
}
it("denies pinned identity tokens in every non-binary harness file by default", async () => {
  expect(
    await harnessViolations(path.resolve(import.meta.dirname, "../..")),
  ).toEqual([]);
});
it("rejects symbolic links to files or directories in a harness scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harness-links-"));
  try {
    for (const directory of scopes)
      await fs.mkdir(path.join(root, directory), { recursive: true });
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "text.mjs"), "export const x = 1;\n");
    await fs.symlink(
      path.join(outside, "text.mjs"),
      path.join(root, "tests/e2e/linked.mjs"),
    );
    await fs.symlink(outside, path.join(root, "tooling/linked-dir"));
    expect(await harnessViolations(root)).toEqual([
      "tests/e2e/linked.mjs:symbolic link in a harness scope",
      "tooling/linked-dir:symbolic link in a harness scope",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
it("keeps every exception explicit, reasoned, in scope and non-stale", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  for (const [file, reason] of allowlist) {
    expect(reason.trim(), file).not.toBe("");
    expect(reason, file).not.toContain("\n");
    expect(
      scopes.some((scope) => file.startsWith(`${scope}/`)),
      file,
    ).toBe(true);
    const bytes = await fs.readFile(path.join(root, file));
    expect(bytes.includes(0), file).toBe(false);
    expect(violations(bytes.toString("utf8"), file), file).not.toHaveLength(0);
  }
});
it("rejects every identity field, including production applicationName and partition leaves", () => {
  for (const value of literals) {
    expect(
      violations(`path.join(appData, ${JSON.stringify(value)})`),
      value,
    ).not.toHaveLength(0);
  }
  expect(violations('desktopIdentity("preview", appData).userData')).toEqual(
    [],
  );
  expect(
    violations('const label = "Farolish"; // Farolish is not the display name'),
  ).toEqual([]);
});
it.each([
  [
    'const profile = "Library/Application Support/io.github.legrch.farol/farol-state";',
    "fixture.mjs",
  ],
  [
    "const profile = `${home}/Library/Application Support/Farol Dev/farol-state`;",
    "fixture.ts",
  ],
  ['const profile = "io.github.legrch." + "farol";', "fixture.mjs"],
  ['const profile = `io.github.${"legrch.farol"}`;', "fixture.mjs"],
  ['path.resolve("_output/package/Farol.app")', "fixture.mjs"],
  ['path.resolve("_output/package/Farol Dev.app")', "fixture.mjs"],
  ['const applicationName = "Farol Preview";', "fixture.mjs"],
  ['const applicationName = "Farol";', "fixture.mjs"],
  ["// Farol.app must not be pinned even in a comment", "fixture.mjs"],
  ["/* Farol Dev */", "fixture.ts"],
  ["const app = /Farol\\.app/u;", "fixture.mjs"],
  ['const app = "\\u0046arol.app";', "fixture.mjs"],
  ...[
    "json",
    "sh",
    "py",
    "plist",
    "yaml",
    "yml",
    "go",
    "txt",
    "new-format",
  ].map((extension) => [
    'profile: "/home/Library/Application Support/io.github.legrch.farol/farol-state"',
    `fixture.${extension}`,
  ]),
])("rejects identity mutations in %s (%s)", (source, file) => {
  expect(violations(source, file)).not.toHaveLength(0);
});
it("discovers a new unallowlisted file, including comments in unknown text formats", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "harness-identity-guard-"),
  );
  try {
    for (const scope of scopes)
      await fs.mkdir(path.join(root, scope), { recursive: true });
    await fs.mkdir(path.join(root, "tooling/new-harness"));
    await fs.writeFile(
      path.join(root, "tooling/new-harness/fixture.unknown"),
      "# Farol.app\n",
    );
    await fs.writeFile(
      path.join(root, "tests/fixtures/binary"),
      Buffer.from([0, 70, 97, 114, 111, 108]),
    );
    expect(await harnessViolations(root)).toEqual([
      "tooling/new-harness/fixture.unknown:1:# Farol.app",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
