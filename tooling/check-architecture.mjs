import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { enforcementSwitch } from "./architecture-enforcement.mjs";

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

// ADR-0002 decision 7 (TypeScript mirror). These rules report everywhere and
// block only in migrated scopes listed in the enforcement file; every ARCH_*
// rule in this checker always blocks. The switch is the Go checker's
// (tooling/architecture-enforcement.mjs), with its own file and scopes.
const migrationCodes = [
  "TS_LAYER_FOLDER",
  "TS_FOLDER_WORD",
  "TS_FILE_WORD",
  "TS_TEST_MISSING",
  "TS_TEST_ORPHAN",
  "TS_BOOT_TEST",
  "TS_BOOT_LOGIC",
  "TS_APP_MODULE_INTERNAL",
];
// A finding's scope is its module under src/modules, otherwise the second
// path segment: src/apps -> apps, src/boot -> boot, src/pkg -> pkg, src/ui ->
// ui, apps/desktop -> desktop.
const scopes = [
  "agent",
  "apps",
  "boot",
  "chat",
  "computer",
  "desktop",
  "pkg",
  "release",
  "task",
  "ui",
];
const scopeOf = (file) => {
  const parts = file.split("/");
  if (parts[0] === "src" && parts[1] === "modules" && parts[2]) return parts[2];
  return parts[1] ?? parts[0];
};
const enforcementFile = "tooling/ts-architecture-enforcement.json";
const enforcement = enforcementSwitch({
  file: enforcementFile,
  version: 1,
  codes: migrationCodes,
  scopes,
  scopeOf,
  prefix: "TS",
  label: "TypeScript",
  command: "node tooling/check-architecture.mjs",
});
const goModules = ["chat", "computer", "release", "task"];
const bootLineBudget = 400;
const word = /^[a-z][a-z0-9]*$/u;
const testName = /\.test\.[cm]?[jt]sx?$/u;
const generatedHeader = /^\/\/ Generated .*DO NOT EDIT\./u;

// The TS1 module tree (05 §1.6, mirroring the Go module layout). A group
// folder holds only folders; a leaf folder holds files and no folders.
const treeHint =
  "domain/<concept>, app/port, app/services/<feature>, app/capabilities/<role>, contracts/<feature>, infra/{peer,repos/<aggregate>,clients/<system>,<mechanism>}";
const knownTargets = new Map([
  ["app/service", "app/services/<feature>"],
  ["contract", "contracts/<feature>"],
  ["infra/repo", "infra/repos/<aggregate>"],
  ["infra/client", "infra/clients/<system>"],
]);
const groupTargets = new Map([
  ["domain", "domain/<concept>"],
  ["app", "app/port or app/services/<feature>"],
  ["app/services", "app/services/<feature>"],
  ["app/capabilities", "app/capabilities/<role>"],
  ["contracts", "contracts/<feature>"],
  ["infra", "infra/<mechanism>"],
  ["infra/repos", "infra/repos/<aggregate>"],
  ["infra/clients", "infra/clients/<system>"],
]);
const reservedInfra = new Set([
  "app",
  "capabilities",
  "client",
  "clients",
  "contract",
  "contracts",
  "domain",
  "port",
  "repo",
  "repos",
  "service",
  "services",
]);
function treeShape(segments) {
  const [first, second, third, ...rest] = segments;
  if (rest.length) return null;
  const key = segments.slice(0, 2).join("/");
  if (first === "domain")
    return second === undefined ? "group" : third === undefined ? "leaf" : null;
  if (first === "contracts")
    return second === undefined ? "group" : third === undefined ? "leaf" : null;
  if (first === "app") {
    if (second === undefined) return "group";
    if (second === "port") return third === undefined ? "leaf" : null;
    if (key === "app/services" || key === "app/capabilities")
      return third === undefined ? "group" : "leaf";
    return null;
  }
  if (first === "infra") {
    if (second === undefined) return "group";
    if (second === "repos" || second === "clients")
      return third === undefined ? "group" : "leaf";
    if (reservedInfra.has(second)) return null;
    return third === undefined ? "leaf" : null;
  }
  return null;
}

// `x.test.ts` pairs with `x.ts` (any source extension); `x.d.ts` declares.
function fileName(base) {
  const extension = path.extname(base);
  let stem = base.slice(0, -extension.length);
  const test = stem.endsWith(".test");
  if (test) stem = stem.slice(0, -".test".length);
  const declaration =
    !test && stem.endsWith(".d") && [".ts", ".mts", ".cts"].includes(extension);
  if (declaration) stem = stem.slice(0, -".d".length);
  return { stem, test, declaration };
}

const functionTypes = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
  "StaticBlock",
]);
const declarationTypes = new Set([
  "ImportDeclaration",
  "ExportAllDeclaration",
  "VariableDeclaration",
  "ClassDeclaration",
  "FunctionDeclaration",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSEnumDeclaration",
  "TSModuleDeclaration",
  "TSDeclareFunction",
  "TSImportEqualsDeclaration",
  "TSExportAssignment",
  "EmptyStatement",
]);

function children(node, visit) {
  for (const [key, child] of Object.entries(node)) {
    if (["loc", "start", "end", "extra", "errors", "comments"].includes(key))
      continue;
    if (Array.isArray(child)) {
      for (const item of child)
        if (item && typeof item === "object") visit(item, node, key);
    } else if (child && typeof child === "object") visit(child, node, key);
  }
}

// A file has behavior when it executes a statement at module level other
// than a declaration, or declares any function body. An empty constructor
// body (parameter properties only) is not behavior; a variable initialized by
// a call is not behavior either, as in the Go rule of ADR-0002.
function hasBehavior(ast) {
  for (const statement of ast.program.body) {
    const declared =
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (!declared) continue;
    if (
      statement.type === "ExportDefaultDeclaration" &&
      !declarationTypes.has(declared.type)
    )
      continue;
    if (!declarationTypes.has(declared.type)) return true;
  }
  let found = false;
  function visit(node) {
    if (found) return;
    if (
      functionTypes.has(node.type) &&
      node.body &&
      !(
        node.type === "ClassMethod" &&
        node.kind === "constructor" &&
        node.body.body.length === 0
      )
    ) {
      found = true;
      return;
    }
    children(node, visit);
  }
  visit(ast.program);
  return found;
}

function bootLogic(ast, source) {
  const kinds = new Map([
    ["IfStatement", "if statements"],
    ["ConditionalExpression", "conditional expressions"],
    ["SwitchStatement", "switch statements"],
    ["ForStatement", "loop statements"],
    ["ForInStatement", "loop statements"],
    ["ForOfStatement", "loop statements"],
    ["WhileStatement", "loop statements"],
    ["DoWhileStatement", "loop statements"],
    ["TryStatement", "try statements"],
    ["ClassDeclaration", "classes"],
    ["ClassExpression", "classes"],
  ]);
  const counts = new Map();
  function visit(node) {
    const kind = kinds.get(node.type);
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    children(node, visit);
  }
  visit(ast.program);
  const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  if (lines > bootLineBudget)
    counts.set(
      `lines beyond the ${bootLineBudget}-line budget`,
      lines - bootLineBudget,
    );
  return [...counts].sort();
}

export function checkArchitecture(root, options = {}) {
  const projectRoot = path.resolve(root);
  const sourceRoot = path.join(projectRoot, "src");
  const sourceRoots = [sourceRoot, path.join(projectRoot, "apps", "desktop")];
  const parsed = new Map();

  function walk(directory, directories) {
    if (!fs.existsSync(directory)) return [];
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    directories?.push({
      directory,
      files: entries.some(
        (entry) =>
          !entry.isDirectory() && extensions.includes(path.extname(entry.name)),
      ),
    });
    return entries
      .flatMap((entry) => {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) return walk(target, directories);
        return extensions.includes(path.extname(entry.name))
          ? [path.resolve(target)]
          : [];
      })
      .sort();
  }

  function relative(file) {
    return path.relative(projectRoot, file).split(path.sep).join("/");
  }

  function isTest(file) {
    return testName.test(path.basename(file));
  }

  // Composition folders: src/boot and any apps/<host>/boot. Only src/boot is
  // classified as boot for the blocking import rules.
  function isBootZone(file) {
    return /^(?:src\/boot|apps\/[^/]+\/boot)\//u.test(relative(file));
  }

  function classify(file) {
    const parts = relative(file).split("/");
    if (
      parts[0] === "apps" &&
      parts[1] === "desktop" &&
      parts[2] === "renderer" &&
      parts.length > 3
    )
      return { kind: "ui" };
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
      // The TS1 target name `contracts` is the same layer as today's
      // `contract`; TS_LAYER_FOLDER reports the old name.
      const layer = parts[3] === "contracts" ? "contract" : parts[3];
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

  function syntax(file) {
    if (!parsed.has(file)) {
      const sourceText = fs.readFileSync(file, "utf8");
      parsed.set(file, {
        sourceText,
        ast: parse(sourceText, {
          sourceType: "unambiguous",
          sourceFilename: file,
          plugins: ["typescript", "jsx", "importAttributes"],
        }),
      });
    }
    return parsed.get(file);
  }

  function importsFrom(file, violations) {
    const sourceFile = syntax(file).ast;
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
      if (
        callee.object?.type !== "Identifier" ||
        callee.object.name !== "module"
      )
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
      target.layer !== "contract"
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

  const directories = [];
  const all = sourceRoots.flatMap((root) => walk(root, directories)).sort();
  // Co-located tests are not production: they are named and paired, never
  // part of the import graph (they may use test frameworks and host IO).
  const tests = all.filter(isTest);
  const files = all.filter((file) => !isTest(file));
  const violations = [];
  const reports = [];
  const report = (code, file, detail, amount) =>
    reports.push({
      code,
      file,
      detail,
      ...(amount === undefined ? {} : { amount }),
    });
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
      if (
        /^(?:react|react-dom)(?:\/|$)/u.test(specifier) &&
        sourceClass.kind !== "ui"
      )
        violations.push({
          code: "ARCH_REACT_OUTSIDE_RENDERER",
          file: relative(file),
          detail: specifier,
        });
      if (sourceClass.kind === "ui" && hostModules.has(specifier))
        violations.push({
          code: "ARCH_RENDERER_HOST_IMPORT",
          file: relative(file),
          detail: specifier,
        });
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
        relativeTarget.includes("/tests/") ||
        isTest(resolved)
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
      const targetClass = classify(resolved);
      const code = violationFor(sourceClass, targetClass);
      if (code)
        violations.push({
          code,
          file: relative(file),
          detail: `${specifier} -> ${relative(resolved)}`,
        });
      // Application code reaches a module only through its published
      // contract (ADR-0002 decision 7); composition in boot is exempt.
      if (
        sourceClass.kind === "application" &&
        targetClass.kind === "module" &&
        targetClass.layer !== "contract"
      )
        report(
          "TS_APP_MODULE_INTERNAL",
          relative(file),
          `Imports module internals: ${relative(resolved)}`,
        );
    }
  }

  // Walk the complete local graph: a safe-looking intermediary cannot hide host IO.
  for (const file of files.filter((file) => classify(file).kind === "ui")) {
    const seen = new Set();
    function inspect(target) {
      if (seen.has(target)) return;
      seen.add(target);
      for (const specifier of importsFrom(target, [])) {
        if (hostModules.has(specifier))
          violations.push({
            code: "ARCH_RENDERER_HOST_IMPORT",
            file: relative(file),
            detail: `via ${relative(target)}: ${specifier}`,
          });
      }
      for (const child of graph.get(target) ?? []) inspect(child);
    }
    inspect(file);
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

  // Folder names and the TS1 module tree. Report the topmost folder outside
  // the tree only; its descendants are part of the same finding.
  const outside = [];
  for (const { directory, files: holdsFiles } of directories) {
    const name = relative(directory);
    if (sourceRoots.includes(directory)) continue;
    const leaf = path.posix.basename(name);
    if (!word.test(leaf))
      report(
        "TS_FOLDER_WORD",
        name,
        `Folder name is not one lowercase word: ${leaf}`,
      );
    const parts = name.split("/");
    if (parts[0] !== "src" || parts[1] !== "modules" || parts.length < 3)
      continue;
    if (parts.length === 3) {
      if (!goModules.includes(parts[2]))
        report(
          "TS_LAYER_FOLDER",
          name,
          `Module folder is not a Go module name: ${parts[2]} (Go modules: ${goModules.join(", ")})`,
        );
      continue;
    }
    if (outside.some((prefix) => name.startsWith(`${prefix}/`))) continue;
    const inner = parts.slice(3);
    const shape = treeShape(inner);
    const key = inner.join("/");
    if (!shape) {
      outside.push(name);
      report(
        "TS_LAYER_FOLDER",
        name,
        `Folder outside the TS1 module tree: ${key} (target ${knownTargets.get(key) ?? treeHint})`,
      );
    } else if (shape === "group" && holdsFiles)
      report(
        "TS_LAYER_FOLDER",
        name,
        `Files directly in grouping folder: ${key} (target ${groupTargets.get(key)}/)`,
      );
  }

  // File names, test pairing and the composition folders.
  const named = new Map();
  for (const file of [...files, ...tests]) {
    const name = fileName(path.basename(file));
    named.set(file, name);
    if (!word.test(name.stem))
      report(
        "TS_FILE_WORD",
        relative(file),
        `File name is not one lowercase word: ${name.stem}`,
      );
  }
  const pairKey = (file) => `${path.dirname(file)}/${named.get(file).stem}`;
  const testedStems = new Set(tests.map(pairKey));
  const sourceStems = new Set(
    files.filter((file) => !named.get(file).declaration).map(pairKey),
  );
  for (const file of tests) {
    if (isBootZone(file)) {
      report("TS_BOOT_TEST", relative(file), "Boot holds no tests");
      continue;
    }
    if (!sourceStems.has(pairKey(file)))
      report(
        "TS_TEST_ORPHAN",
        relative(file),
        `No same-named source beside this test: ${named.get(file).stem}`,
      );
  }
  for (const file of files) {
    const { sourceText, ast } = syntax(file);
    if (isBootZone(file)) {
      for (const [kind, total] of bootLogic(ast, sourceText))
        report("TS_BOOT_LOGIC", relative(file), kind, total);
      continue;
    }
    if (named.get(file).declaration || generatedHeader.test(sourceText))
      continue;
    if (!testedStems.has(pairKey(file)) && hasBehavior(ast))
      report(
        "TS_TEST_MISSING",
        relative(file),
        `File with behavior has no co-located test: ${named.get(file).stem}.test${path.extname(file)}`,
      );
  }

  const result = enforcement.enforce(
    projectRoot,
    reports,
    (code, file, detail) => violations.push({ code, file, detail }),
    options.write ?? null,
  );
  violations.sort((left, right) =>
    `${left.code}:${left.file}:${left.detail}`.localeCompare(
      `${right.code}:${right.file}:${right.detail}`,
    ),
  );
  return {
    ok: violations.length === 0,
    root: projectRoot,
    files: files.length,
    testFiles: tests.length,
    violations,
    report: result,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    let root = process.cwd();
    let only = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--root" && args[i + 1]) root = args[++i];
      else if (args[i] === "--scope" && args[i + 1]) only = args[++i];
      else if (!["--json", "--write-baseline", "--admit-new"].includes(args[i]))
        throw new Error(`Unknown or incomplete option: ${args[i]}`);
    }
    // Only an explicit option writes, and only the baseline rows: stale rows
    // are dropped and amounts lowered; --admit-new also adds new findings.
    const writing = args.includes("--write-baseline");
    if (args.includes("--admit-new") && !writing)
      throw new Error("--admit-new requires --write-baseline");
    if (writing && !fs.existsSync(path.join(root, enforcementFile)))
      throw new Error(`--write-baseline requires ${enforcementFile}`);
    const result = checkArchitecture(root, {
      write: writing ? { admit: args.includes("--admit-new") } : null,
    });
    const { report } = result;
    if (args.includes("--json"))
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const violation of result.violations)
        process.stdout.write(
          `${violation.code} ${violation.file}: ${violation.detail}\n`,
        );
      for (const finding of report.findings)
        if (!only || finding.scope === only)
          process.stdout.write(
            `REPORT ${finding.code} ${finding.file}: ${finding.detail}${finding.amount === undefined ? "" : ` (${finding.amount})`}\n`,
          );
      for (const finding of report.excepted)
        if (!only || finding.scope === only)
          process.stdout.write(
            `EXCEPTED ${finding.code} ${finding.file}: ${finding.detail} (${finding.reason}; removal: ${finding.removal})\n`,
          );
      process.stdout.write(`\n${enforcement.table(report)}`);
      process.stdout.write(
        `\nADR-0002 report mode: ${report.findings.length} report findings; ${report.excepted.length} excepted; * = migrated scope (blocking); TS_BOOT_LOGIC counts occurrences and excess lines.\n`,
      );
      process.stdout.write(
        `${result.ok ? "PASS" : "FAIL"}: ${result.files} files, ${result.violations.length} violation(s)\n`,
      );
    }
    if (writing) await enforcement.format(root);
    process.exitCode = result.violations.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(
      `TypeScript architecture check failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}
