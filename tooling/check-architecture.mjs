import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import process from "node:process";
import { parse } from "@babel/parser";

const extensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
const hostModules = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  "electron",
]);
const pureExternalModules = new Set(["zod"]);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const projectRoot = path.resolve(argument("--root", process.cwd()));
const sourceRoot = path.join(projectRoot, "src");
const sourceRoots = [sourceRoot, path.join(projectRoot, "apps", "desktop")];
const json = process.argv.includes("--json");

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(target);
      return extensions.includes(path.extname(entry.name))
        ? [path.resolve(target)]
        : [];
    })
    .sort();
}

function relative(file) {
  return path.relative(projectRoot, file).split(path.sep).join("/");
}

function classify(file) {
  const parts = relative(file).split("/");
  if (parts[0] === "apps" && parts[1] === "desktop" && parts.length > 2)
    return { kind: "application", application: "desktop" };
  if (parts[0] !== "src") return { kind: "outside" };
  if (parts[1] === "apps" && parts.length > 3) {
    return { kind: "application", application: parts[2] };
  }
  if (parts[1] === "boot" && parts.length > 2) return { kind: "boot" };
  if (parts[1] === "ui" && parts.length > 2) return { kind: "ui" };
  if (parts[1] === "pkg" && parts[2] === "kernel" && parts.length > 4) {
    const layer = parts[3];
    return ["domain", "app", "infra"].includes(layer)
      ? { kind: "kernel", layer }
      : { kind: "unclassified" };
  }
  if (parts[1] === "pkg" && parts.length > 3) return { kind: "mechanism" };
  if (parts[1] === "modules" && parts.length > 4) {
    const layer = parts[3];
    return ["domain", "app", "contract", "infra"].includes(layer)
      ? { kind: "module", module: parts[2], layer, peer: parts[4] === "peer" }
      : { kind: "unclassified" };
  }
  return { kind: "unclassified" };
}

function resolveLocal(importer, specifier) {
  const bare = specifier.startsWith("@next/")
    ? path.join(sourceRoot, specifier.slice("@next/".length))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(importer), specifier)
      : null;
  if (bare === null) return null;
  const candidates = [
    bare,
    ...extensions.map((extension) => `${bare}${extension}`),
    ...extensions.map((extension) => path.join(bare, `index${extension}`)),
  ];
  return (
    candidates.find(
      (candidate) =>
        fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
    ) ?? bare
  );
}

function importsFrom(file, violations) {
  const sourceText = fs.readFileSync(file, "utf8");
  const sourceFile = parse(sourceText, {
    sourceType: "unambiguous",
    sourceFilename: file,
    plugins: ["typescript", "jsx", "importAttributes"],
  });
  const imports = new Set();
  const sourceClass = classify(file);
  const pure =
    (sourceClass.kind === "module" &&
      ["domain", "app", "contract"].includes(sourceClass.layer)) ||
    (sourceClass.kind === "kernel" &&
      ["domain", "app"].includes(sourceClass.layer));
  const bannedGlobals = new Set([
    "process",
    "Buffer",
    "globalThis",
    "Bun",
    "Deno",
    "document",
    "window",
    "HTMLElement",
    "EventSource",
    "WebSocket",
    "fetch",
    "setTimeout",
    "setInterval",
    "eval",
    "Function",
  ]);
  let hostGlobal = false;

  function addCallSpecifier(argument, kind) {
    if (argument?.type === "StringLiteral") {
      imports.add(argument.value);
      return;
    }
    violations.push({
      code: "ARCH_DYNAMIC_IMPORT",
      file: relative(file),
      detail: `dynamic ${kind} is not a string literal`,
    });
  }

  // `require(...)`, `require?.(...)`, `module.require(...)`,
  // `module?.require(...)` and `module["require"](...)`.
  function isRequireCallee(callee) {
    if (callee?.type === "Identifier") return callee.name === "require";
    if (
      callee?.type !== "MemberExpression" &&
      callee?.type !== "OptionalMemberExpression"
    ) {
      return false;
    }
    if (callee.object?.type !== "Identifier" || callee.object.name !== "module")
      return false;
    return callee.computed
      ? callee.property?.type === "StringLiteral" &&
          callee.property.value === "require"
      : callee.property?.type === "Identifier" &&
          callee.property.name === "require";
  }

  function isNonReferenceIdentifier(node, parent, key) {
    if (!parent) return false;
    if (
      (parent.type === "MemberExpression" ||
        parent.type === "OptionalMemberExpression") &&
      key === "property" &&
      !parent.computed
    ) {
      return true;
    }
    if (
      (parent.type === "ObjectProperty" ||
        parent.type === "ObjectMethod" ||
        parent.type === "ClassMethod" ||
        parent.type === "ClassProperty") &&
      key === "key" &&
      !parent.computed
    ) {
      return true;
    }
    return (
      key === "id" ||
      key === "param" ||
      key === "params" ||
      key === "local" ||
      key === "imported" ||
      key === "exported" ||
      key === "label"
    );
  }

  function visit(node, parent = null, key = null) {
    if (!node || typeof node !== "object") return;
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
      ].includes(node.type) &&
      node.source?.type === "StringLiteral"
    ) {
      imports.add(node.source.value);
    }
    if (node.type === "ImportExpression") {
      addCallSpecifier(node.source, "import");
    }
    // `import x = require("y")` and a type position `import("y")` are
    // dependencies as much as an import declaration is.
    if (
      node.type === "TSImportEqualsDeclaration" &&
      node.moduleReference?.type === "TSExternalModuleReference"
    ) {
      addCallSpecifier(node.moduleReference.expression, "require");
    }
    if (node.type === "TSImportType") {
      addCallSpecifier(
        node.argument?.type === "TSLiteralType"
          ? node.argument.literal
          : node.argument,
        "type import",
      );
    }
    if (
      node.type === "CallExpression" ||
      node.type === "OptionalCallExpression"
    ) {
      if (node.callee?.type === "Import") {
        addCallSpecifier(node.arguments[0], "import");
      } else if (isRequireCallee(node.callee)) {
        addCallSpecifier(node.arguments[0], "require");
      }
    }
    // A loader made by createRequire takes any specifier at run time, so no
    // edge it creates can be checked; the gate refuses the name wherever it
    // appears, however it is reached.
    if (node.type === "Identifier" && node.name === "createRequire") {
      violations.push({
        code: "ARCH_DYNAMIC_IMPORT",
        file: relative(file),
        detail: "createRequire makes a loader the gate cannot check",
      });
    }
    if (
      pure &&
      node.type === "Identifier" &&
      bannedGlobals.has(node.name) &&
      !isNonReferenceIdentifier(node, parent, key)
    ) {
      hostGlobal = true;
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (["loc", "start", "end", "extra", "errors"].includes(childKey))
        continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item, node, childKey);
      } else {
        visit(child, node, childKey);
      }
    }
  }
  visit(sourceFile);

  if (pure && hostGlobal) {
    violations.push({
      code: "ARCH_PURE_HOST_GLOBAL",
      file: relative(file),
      detail: "pure layer uses a host global",
    });
  }
  return [...imports];
}

function violationFor(source, target) {
  if (source.kind === "unclassified" || target.kind === "unclassified")
    return null;
  if (target.kind === "application" && source.kind !== "application")
    return "ARCH_INNER_TO_APP";
  if (
    source.kind === "application" &&
    target.kind === "application" &&
    source.application !== target.application
  )
    return "ARCH_APP_CROSS_ENTRY";
  if (source.kind === "module" && target.kind === "boot")
    return "ARCH_MODULE_TO_BOOT";
  if (source.kind === "module" && target.kind === "ui")
    return "ARCH_MODULE_TO_UI";
  if (
    source.kind === "ui" &&
    target.kind === "module" &&
    target.layer === "infra"
  )
    return "ARCH_UI_TO_MODULE_INFRA";
  if (source.kind === "kernel" && target.kind === "module")
    return "ARCH_KERNEL_TO_MODULE";
  if (
    source.kind === "module" &&
    target.kind === "module" &&
    source.module !== target.module
  ) {
    return source.layer === "infra" &&
      source.peer &&
      target.layer === "contract"
      ? null
      : "ARCH_CROSS_MODULE";
  }
  if (
    source.kind === "module" &&
    source.layer === "contract" &&
    target.kind === "module"
  ) {
    return "ARCH_CONTRACT_LEAK";
  }
  if (
    source.kind === "module" &&
    target.kind === "module" &&
    source.module === target.module
  ) {
    if (source.layer === "domain" && target.layer !== "domain")
      return "ARCH_LAYER_DIRECTION";
    if (source.layer === "app" && !["domain", "app"].includes(target.layer))
      return "ARCH_LAYER_DIRECTION";
  }
  if (source.kind === "module" && ["domain", "app"].includes(source.layer)) {
    if (
      source.layer === "domain" &&
      target.kind === "kernel" &&
      target.layer !== "domain"
    )
      return "ARCH_LAYER_DIRECTION";
    if (target.kind === "kernel" && target.layer === "infra")
      return "ARCH_LAYER_DIRECTION";
    if (target.kind === "mechanism") return "ARCH_LAYER_DIRECTION";
  }
  if (source.kind === "kernel") {
    if (
      source.layer === "domain" &&
      !(target.kind === "kernel" && target.layer === "domain")
    ) {
      return "ARCH_LAYER_DIRECTION";
    }
    if (
      source.layer === "app" &&
      !(target.kind === "kernel" && ["domain", "app"].includes(target.layer))
    ) {
      return "ARCH_LAYER_DIRECTION";
    }
  }
  if (source.kind === "mechanism" && target.kind === "module")
    return "ARCH_CROSS_MODULE";
  return null;
}

const files = sourceRoots.flatMap(walk).sort();
const violations = [];
const graph = new Map(files.map((file) => [file, []]));
const importers = new Map();

for (const file of files) {
  const sourceClass = classify(file);
  if (sourceClass.kind === "unclassified") {
    violations.push({
      code: "ARCH_UNCLASSIFIED",
      file: relative(file),
      detail: "production source has no owned layer",
    });
  }
  const pure =
    (sourceClass.kind === "module" &&
      ["domain", "app", "contract"].includes(sourceClass.layer)) ||
    (sourceClass.kind === "kernel" &&
      ["domain", "app"].includes(sourceClass.layer));
  for (const specifier of importsFrom(file, violations)) {
    if (pure && hostModules.has(specifier)) {
      violations.push({
        code: "ARCH_PURE_HOST_IMPORT",
        file: relative(file),
        detail: specifier,
      });
      continue;
    }
    const target = resolveLocal(file, specifier);
    if (target === null) {
      if (sourceClass.kind === "boot") {
        violations.push({
          code: "ARCH_BOOT_HOST_IMPORT",
          file: relative(file),
          detail: specifier,
        });
        continue;
      }
      if (pure && !pureExternalModules.has(specifier)) {
        violations.push({
          code: "ARCH_PURE_EXTERNAL_IMPORT",
          file: relative(file),
          detail: specifier,
        });
      }
      continue;
    }
    const resolved = path.resolve(target);
    const relativeTarget = relative(resolved);
    if (
      relativeTarget.startsWith("tests/") ||
      relativeTarget.includes("/tests/")
    ) {
      violations.push({
        code: "ARCH_PRODUCTION_TESTKIT",
        file: relative(file),
        detail: specifier,
      });
      continue;
    }
    if (!fs.existsSync(resolved)) {
      violations.push({
        code: "ARCH_UNRESOLVED_IMPORT",
        file: relative(file),
        detail: specifier,
      });
      continue;
    }
    if (
      !sourceRoots.some((root) => resolved.startsWith(`${root}${path.sep}`))
    ) {
      violations.push({
        code: "ARCH_SOURCE_ESCAPE",
        file: relative(file),
        detail: specifier,
      });
      continue;
    }
    graph.get(file)?.push(resolved);
    const consumers = importers.get(resolved) ?? [];
    consumers.push(file);
    importers.set(resolved, consumers);
    const code = violationFor(sourceClass, classify(resolved));
    if (code)
      violations.push({
        code,
        file: relative(file),
        detail: `${specifier} -> ${relative(resolved)}`,
      });
  }
}

const visiting = new Set();
const visited = new Set();
function detectCycle(file, chain) {
  if (visiting.has(file)) {
    const start = chain.indexOf(file);
    violations.push({
      code: "ARCH_CYCLE",
      file: relative(file),
      detail: [...chain.slice(start), file].map(relative).join(" -> "),
    });
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  for (const target of graph.get(file) ?? [])
    detectCycle(target, [...chain, file]);
  visiting.delete(file);
  visited.add(file);
}
for (const file of files) detectCycle(file, []);

for (const file of files.filter((candidate) => {
  const classification = classify(candidate);
  return classification.kind === "kernel" && classification.layer === "infra";
})) {
  const portTargets = graph.get(file)?.filter((target) => {
    const classification = classify(target);
    return classification.kind === "kernel" && classification.layer === "app";
  });
  for (const port of portTargets ?? []) {
    const modules = new Set(
      (importers.get(port) ?? [])
        .map(classify)
        .filter((classification) => classification.kind === "module")
        .map((classification) => classification.module),
    );
    if (modules.size < 2) {
      violations.push({
        code: "ARCH_SHARED_INFRA_CONSUMERS",
        file: relative(file),
        detail: `${relative(port)} has ${modules.size} module consumer(s)`,
      });
    }
  }
}

violations.sort((left, right) =>
  `${left.code}:${left.file}:${left.detail}`.localeCompare(
    `${right.code}:${right.file}:${right.detail}`,
  ),
);
const result = {
  ok: violations.length === 0,
  root: projectRoot,
  files: files.length,
  violations,
};
process.stdout.write(
  json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${result.ok ? "PASS" : "FAIL"}: ${files.length} files, ${violations.length} violation(s)\n`,
);
if (!result.ok) process.exitCode = 1;
