import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";
import { desktopIdentity } from "../../src/apps/desktop/desktop-environment.ts";

// These implement product/build contracts or read historical installed data;
// they are not acceptance harnesses. New tooling is checked by default.
const productContracts = new Set([
  "tooling/build.mjs",
  "tooling/build-identity-contract.mjs",
  "tooling/package.mjs",
  "tooling/package-layout.mjs",
  "tooling/resource-contract.mjs",
  "tooling/verify-package-content.mjs",
  "tooling/replace-installed-preview.mjs",
  "tooling/hunt-report.mjs",
  "tooling/supervised-update-resources.mjs",
  "tooling/update-slot-observer.mjs",
  "tooling/package-platform.mjs", // Product bundle plist writer.
  "tooling/prepare-release-archive.py", // Exact published artifact validator.
  "tooling/runtime-launch-manifest.mjs", // Versioned launch schema, not an identity.
  "tooling/closed-preview-repair.mjs", // Historical installed-profile reader.
  "tooling/closed-preview-repair.py",
  "tooling/promotion-lease.mjs", // Historical lock-domain reader.
  "tooling/retire-preview-install.mjs", // Historical install retirement reader.
  "tooling/retire-preview-install.py",
  "tooling/supervised-update-backup.mjs", // Historical installed-pair backup reader.
]);
// Exact protective/rejection values only; the rest of each harness is scanned.
const rejectionLiterals = new Map([
  [
    "tests/e2e/preview.e2e.mjs",
    new Set(["Set :CFBundleIdentifier io.github.legrch.farol.foreign"]),
  ],
  [
    "tests/e2e/owner-preview-isolation.e2e.mjs",
    new Set([
      "Library/Application Support/Farol",
      "Library/Application Support/Farol Preview/x",
      "/Applications/Farol.app/Contents/MacOS/Farol",
      "Farol Dev Acceptance",
      "Farol Dev Acceptance/Farol Dev/farol-state/running.json",
      "Farol Dev Acceptance/Farol DEV",
      "Farol Preview/Cookies",
      "Farol Dev Acceptance/tmp",
    ]),
  ],
]);
const identities = ["preview", "dev", "owner-preview"].map((environment) =>
  desktopIdentity(environment, "/__identity_guard__"),
);
const literals = new Set(
  identities.flatMap((identity) => [
    identity.applicationId,
    identity.runtimePartition,
    identity.chatGptPartition,
    identity.runtimeIdentity,
    identity.runtimeServiceName,
    ...(identity.environment === "preview" ? [] : [identity.applicationName]),
  ]),
);
const leaves = new Set([
  ...identities.map((identity) => path.basename(identity.userData)),
  "Farol",
]);
// The unqualified product name also appears in UI prose. Treat it as an
// identity only as a complete path segment or a path-builder argument.
function pinned(value, inPath = false) {
  return (
    [...literals].some((literal) => value.includes(literal)) ||
    /farol_next|farol-next|local\.farol\.next/u.test(value) ||
    /(?:^|[/\\])Farol(?:[/\\]|$)/u.test(value) ||
    (inPath && leaves.has(value))
  );
}
function violations(source, file = "fixture.mjs") {
  if (!/\.(?:mjs|cjs|mts|cts|ts|tsx|js|jsx)$/u.test(file)) {
    // Shell, Python, JSON, YAML, plist, Go and other text fixtures are scanned
    // in full, including unquoted values. Do not maintain an extension allowlist.
    return source
      .split("\n")
      .flatMap((line, index) => (pinned(line) ? [`${index + 1}:${line}`] : []));
  }
  const failures = [];
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
  function walk(node, parent) {
    if (!node || typeof node !== "object") return;
    const value =
      node.type === "TemplateElement"
        ? (node.value.cooked ?? node.value.raw)
        : joined(node);
    const inPath =
      parent?.type === "CallExpression" &&
      parent.callee.type === "MemberExpression" &&
      ["join", "resolve"].includes(parent.callee.property.name);
    if (
      value !== undefined &&
      !rejectionLiterals.get(file)?.has(value) &&
      pinned(value, inPath)
    )
      failures.push(`${node.loc.start.line}:${value}`);
    for (const [key, child] of Object.entries(node)) {
      if (
        [
          "loc",
          "extra",
          "comments",
          "leadingComments",
          "trailingComments",
          "innerComments",
        ].includes(key)
      )
        continue;
      if (Array.isArray(child)) child.forEach((entry) => walk(entry, node));
      else if (child && typeof child === "object") walk(child, node);
    }
  }
  walk(ast);
  return failures;
}
it("acceptance harnesses derive identity from the product instead of pinning literals", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const failures = [];
  for (const directory of ["tests/e2e", "tests/fixtures", "tooling"]) {
    for (const relative of await fs.readdir(path.join(root, directory), {
      recursive: true,
    })) {
      const file = `${directory}/${relative}`;
      if (productContracts.has(file)) continue;
      const absolute = path.join(root, file);
      if (!(await fs.lstat(absolute)).isFile()) continue;
      const bytes = await fs.readFile(absolute);
      if (bytes.includes(0)) continue; // Binary assets contain no text literals.
      failures.push(
        ...violations(bytes.toString("utf8"), file).map(
          (entry) => `${file}:${entry}`,
        ),
      );
    }
  }
  expect(failures).toEqual([]);
  // Mutation witnesses keep the guard effective for the original stale leaf,
  // current identities, template-adjacent code and retired rename spellings.
  for (const value of [
    ...literals,
    ...leaves,
    "farol_next",
    "persist:farol-next-runtime",
  ]) {
    expect(
      violations(`path.join(appData, ${JSON.stringify(value)})`),
    ).not.toHaveLength(0);
  }
  expect(violations('desktopIdentity("preview", appData).userData')).toEqual(
    [],
  );
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
  ...["json", "sh", "py", "plist", "yaml", "yml", "go", "txt"].map(
    (extension) => [
      'profile: "/home/Library/Application Support/io.github.legrch.farol/farol-state"',
      `fixture.${extension}`,
    ],
  ),
])("rejects compound identities in %s (%s)", (source, file) => {
  expect(violations(source, file)).not.toHaveLength(0);
});
