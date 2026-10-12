import fs from "node:fs";
import vm from "node:vm";
import { parse } from "@babel/parser";
import { build } from "esbuild";
import { expect, it } from "vitest";

const source = fs.readFileSync("tooling/build.mjs", "utf8");
const ast = parse(source, { sourceType: "module" });
const objects = [];
let common;
function visit(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "VariableDeclarator" && node.id?.name === "common")
    common = node.init;
  if (node.type === "CallExpression" && node.callee?.name === "build") {
    const object = node.arguments[0];
    const entries = object?.properties?.find(
      (item) => item.key?.name === "entryPoints",
    );
    if (
      entries?.value?.elements?.[0]?.value ===
      "src/apps/desktop/desktop-entry.ts"
    )
      objects.push(object);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") visit(value);
  }
}
visit(ast);
const property = (object, key) =>
  object.properties.find((item) => item.key?.name === key).value;
const evaluate = (node, context) =>
  vm.runInNewContext("(" + source.slice(node.start, node.end) + ")", context);

it("both actual host build passes keep optional ws native addons disabled", async () => {
  expect(objects).toHaveLength(2);
  const core = { build: { buildId: "controlled-artifact-id" } };
  const commonDefine = evaluate(property(common, "define"), {});
  for (const [index, object] of objects.entries()) {
    const define = evaluate(property(object, "define"), {
      common: { define: commonDefine },
      core,
      coreResources: { kind: "controlled-resources" },
      shellSupport: { kind: "controlled-shell-support" },
      JSON,
    });
    const compiled = await build({
      stdin: {
        contents: `
        if (!process.env.WS_NO_BUFFER_UTIL) require("bufferutil");
        if (!process.env.WS_NO_UTF_8_VALIDATE) require("utf-8-validate");
        module.exports = { core: __FAROL_GO_CORE__ };
      `,
      },
      define,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["bufferutil", "utf-8-validate"],
      write: false,
      logLevel: "silent",
    });
    const attempted = [];
    const module = { exports: {} };
    vm.runInNewContext(compiled.outputFiles[0].text, {
      module,
      process: { env: {} },
      require: (name) => {
        attempted.push(name);
        return {};
      },
    });
    expect(
      attempted,
      `host pass ${index} must not load an ambient native addon`,
    ).toEqual([]);
    expect(JSON.stringify(module.exports.core)).toBe(
      JSON.stringify(index === 0 ? null : core),
    );
  }
});
