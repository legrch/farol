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
function violations(source) {
  const failures = [];
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
  function walk(node, parent) {
    if (!node || typeof node !== "object") return;
    if (node.type === "StringLiteral") {
      const inPath =
        parent?.type === "CallExpression" &&
        parent.callee.type === "MemberExpression" &&
        ["join", "resolve"].includes(parent.callee.property.name);
      if (
        literals.has(node.value) ||
        /farol_next|persist:farol-next/u.test(node.value) ||
        (inPath && leaves.has(node.value)) ||
        /^Contents\/MacOS\/Farol$/u.test(node.value)
      )
        failures.push(`${node.loc.start.line}:${node.value}`);
    }
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
      if (file.endsWith(".go")) {
        const source = await fs.readFile(path.join(root, file), "utf8");
        for (const value of new Set([...literals, ...leaves])) {
          if (source.includes(JSON.stringify(value)))
            failures.push(`${file}:${value}`);
        }
        continue;
      }
      if (!/\.(?:mjs|cjs|ts|tsx|js)$/u.test(file) || productContracts.has(file))
        continue;
      failures.push(
        ...violations(await fs.readFile(path.join(root, file), "utf8")).map(
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
    ).toHaveLength(1);
  }
  expect(violations('desktopIdentity("preview", appData).userData')).toEqual(
    [],
  );
});
