#!/usr/bin/env node
// Refuses a NEW test that reads production source text and executes code
// derived from it. Existing offenders live in one shrink-only allowlist.
//
// A file offends when code that it executes derives, by data flow inside the
// file, from an fs read of a production path (a .ts/.tsx/.mts/.js/.go file
// under src/, apps/, boot/, modules/, pkg/, transport/, cmd/ or tooling/). The
// production path must be spelled by the read call's own path argument,
// followed through const/let/var bindings, assignments and same-file reader
// helpers. Import specifiers and test titles never count. Mechanisms:
//   vm         vm.runIn*Context, vm.Script, vm.compileFunction
//   function   new Function(...) / Function(...)
//   eval       eval(...), (0, eval)(...), globalThis.eval(...)
//   transpile  a TypeScript/Babel/esbuild transpile call on derived text,
//              in a file that also loads code dynamically
//   esbuild    an esbuild build with `stdin.contents` derived from the read
// Tests that only assert on source text are reported, never blocked.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, "..");
const allowlistRelative = "tests/architecture/source-slicing-allowlist.json";
const codeExtension = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const skippedDirectories = new Set([
  "node_modules",
  ".git",
  "_output",
  "dist",
  ".claude",
]);
const productionPath =
  /(?:^|\/)(?:src|apps|boot|modules|pkg|transport|cmd|tooling)\/[^\s"'`]*\.(?:ts|tsx|mts|js|mjs|cjs|go)(?![\w])/;
const readCalls = new Set(["readFileSync", "readFile", "createReadStream"]);
const vmApi = new Set([
  "runInContext",
  "runInNewContext",
  "runInThisContext",
  "compileFunction",
  "Script",
  "SourceTextModule",
]);
const transpileApi = new Map([
  ["transpileModule", ["typescript"]],
  ["transpile", ["typescript"]],
  ["stripTypeScriptTypes", ["module"]],
  ["transform", ["esbuild", "@babel/core"]],
  ["transformSync", ["esbuild", "@babel/core"]],
  ["transformAsync", ["@babel/core"]],
]);
const collectors = new Set([
  "push",
  "unshift",
  "add",
  "set",
  "splice",
  "append",
]);
const mechanismOrder = ["vm", "function", "eval", "transpile", "esbuild"];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const rootArg = args.indexOf("--root");
const root = path.resolve(rootArg >= 0 ? args[rootArg + 1] : defaultRoot);
const json = flag("--json");

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "extra") continue;
    const value = node[key];
    if (Array.isArray(value)) for (const item of value) walk(item, visit, node);
    else if (value && typeof value.type === "string") walk(value, visit, node);
  }
}

function calleeName(callee) {
  if (!callee) return "";
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed)
    return callee.property.name ?? "";
  if (callee.type === "SequenceExpression")
    return calleeName(callee.expressions.at(-1));
  if (callee.type === "ParenthesizedExpression")
    return calleeName(callee.expression);
  return "";
}

function literalText(node) {
  if (!node) return null;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral")
    return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join("\u0000");
  return null;
}

// A value is derived when it is not a plain string: a template literal that
// interpolates anything (for example a slice of the source) is derived.
function isDerived(node) {
  if (node.type === "StringLiteral") return false;
  if (node.type === "TemplateLiteral") return node.expressions.length > 0;
  return true;
}

// Names a node reads. Member property names and plain object keys are not
// variable references.
function referencedNames(node) {
  const names = new Set();
  walk(node, (inner, parent) => {
    if (inner.type !== "Identifier") return;
    if (
      parent?.type === "MemberExpression" &&
      !parent.computed &&
      parent.property === inner
    )
      return;
    if (
      parent?.type === "ObjectProperty" &&
      !parent.computed &&
      !parent.shorthand &&
      parent.key === inner
    )
      return;
    names.add(inner.name);
  });
  return names;
}

function patternNames(pattern, out = []) {
  if (!pattern) return out;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties)
        patternNames(
          property.type === "RestElement" ? property.argument : property.value,
          out,
        );
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) patternNames(element, out);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    default:
      break;
  }
  return out;
}

const moduleName = (spec) =>
  spec.replace(/^node:/, "").replace(/\/promises$/, "");

// Resolve `require("x")`, `await import("x")`, an alias, or a member chain
// over one of them to { module, path }.
function moduleOrigin(node, aliases) {
  if (!node) return null;
  if (
    node.type === "AwaitExpression" ||
    node.type === "ParenthesizedExpression"
  )
    return moduleOrigin(node.argument ?? node.expression, aliases);
  if (node.type === "CallExpression") {
    const callee = node.callee;
    const literal = node.arguments[0];
    if (
      literal?.type === "StringLiteral" &&
      ((callee.type === "Identifier" && callee.name === "require") ||
        callee.type === "Import")
    )
      return { module: moduleName(literal.value), path: [] };
    return null;
  }
  if (node.type === "Identifier") {
    const alias = aliases.get(node.name);
    return alias ? { module: alias.module, path: [...alias.path] } : null;
  }
  if (node.type === "MemberExpression" && !node.computed) {
    const base = moduleOrigin(node.object, aliases);
    return base
      ? { module: base.module, path: [...base.path, node.property.name] }
      : null;
  }
  return null;
}

// Facts about one parsed file.
function gather(ast) {
  const aliases = new Map(); // local name -> { module, path }
  const bindings = new Map(); // name -> expressions it can hold
  const funcs = new Map(); // name -> { params: (string|null)[], node }
  const calls = [];
  let dynamicLoad = false;
  const bind = (name, node) => {
    if (!bindings.has(name)) bindings.set(name, []);
    bindings.get(name).push(node);
  };
  const addFunction = (name, node) => {
    funcs.set(name, {
      node,
      params: node.params.map((param) =>
        param.type === "Identifier" ? param.name : null,
      ),
    });
  };
  walk(ast.program, (node) => {
    switch (node.type) {
      case "ImportDeclaration":
        for (const spec of node.specifiers)
          aliases.set(spec.local.name, {
            module: moduleName(node.source.value),
            path:
              spec.type === "ImportSpecifier"
                ? [spec.imported.name ?? spec.imported.value]
                : [],
          });
        break;
      case "VariableDeclarator": {
        if (!node.init) break;
        const origin = moduleOrigin(node.init, aliases);
        if (origin) {
          if (node.id.type === "Identifier") aliases.set(node.id.name, origin);
          else if (node.id.type === "ObjectPattern")
            for (const property of node.id.properties)
              if (
                property.type === "ObjectProperty" &&
                property.value.type === "Identifier"
              )
                aliases.set(property.value.name, {
                  module: origin.module,
                  path: [
                    ...origin.path,
                    property.key.name ?? property.key.value,
                  ],
                });
        }
        for (const name of patternNames(node.id)) bind(name, node.init);
        if (
          node.id.type === "Identifier" &&
          (node.init.type === "ArrowFunctionExpression" ||
            node.init.type === "FunctionExpression")
        )
          addFunction(node.id.name, node.init);
        break;
      }
      case "AssignmentExpression":
        for (const name of patternNames(node.left)) bind(name, node.right);
        break;
      case "ForOfStatement":
      case "ForInStatement":
        if (node.left.type === "VariableDeclaration")
          for (const declarator of node.left.declarations)
            for (const name of patternNames(declarator.id))
              bind(name, node.right);
        break;
      case "FunctionDeclaration":
        if (node.id) {
          bind(node.id.name, node);
          addFunction(node.id.name, node);
        }
        break;
      case "CallExpression":
      case "NewExpression": {
        calls.push(node);
        // `list.push(derived)` makes the receiver hold derived text.
        if (
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.object.type === "Identifier" &&
          collectors.has(node.callee.property.name)
        )
          for (const argument of node.arguments)
            bind(node.callee.object.name, argument);
        if (node.type === "CallExpression" && node.callee.type === "Import") {
          if (node.arguments[0]?.type !== "StringLiteral") dynamicLoad = true;
        }
        const name = calleeName(node.callee);
        if (name === "_compile") dynamicLoad = true;
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments[0]?.type !== "StringLiteral"
        )
          dynamicLoad = true;
        break;
      }
      default:
        break;
    }
  });
  return { aliases, bindings, funcs, calls, dynamicLoad };
}

function analyzeFacts(facts) {
  const { aliases, bindings, funcs, calls, dynamicLoad } = facts;
  const aliasFrom = (name, modules) => {
    const alias = aliases.get(name);
    return alias && modules.includes(alias.module) ? alias : null;
  };

  // Text a node spells out, following bindings to bounded depth so that
  // `const dir = path.join(root, "src"); read(path.join(dir, "x.ts"))` works.
  function pathText(node, depth = 0) {
    const parts = [];
    walk(node, (inner) => {
      const text = literalText(inner);
      if (text !== null) parts.push(text.replaceAll("\u0000", "/"));
      if (inner.type === "Identifier" && depth < 3 && bindings.has(inner.name))
        for (const bound of bindings.get(inner.name))
          if (bound.type !== "FunctionDeclaration")
            parts.push(pathText(bound, depth + 1));
    });
    return parts.join("/");
  }
  const production = (node) => productionPath.test(pathText(node));

  function isReadCall(node) {
    if (node.type !== "CallExpression") return false;
    const callee = node.callee;
    if (callee.type === "Identifier") {
      const alias = aliases.get(callee.name);
      if (alias)
        return alias.module === "fs" && readCalls.has(alias.path.at(-1) ?? "");
      return readCalls.has(callee.name);
    }
    return (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      readCalls.has(callee.property.name)
    );
  }

  // Same-file helpers that read a path: { bodyProd, params }.
  const readers = new Map();
  for (let pass = 0; pass < 3; pass += 1) {
    for (const [name, fn] of funcs) {
      const entry = readers.get(name) ?? { bodyProd: false, params: new Set() };
      walk(fn.node.body, (inner) => {
        if (inner.type !== "CallExpression") return;
        const target =
          inner.callee.type === "Identifier"
            ? readers.get(inner.callee.name)
            : null;
        const pathArgs = isReadCall(inner)
          ? [[0, inner.arguments[0]]]
          : target
            ? [...target.params].map((index) => [index, inner.arguments[index]])
            : [];
        if (target?.bodyProd) entry.bodyProd = true;
        for (const [, argument] of pathArgs) {
          if (!argument) continue;
          if (production(argument)) entry.bodyProd = true;
          const used = referencedNames(argument);
          fn.params.forEach((param, index) => {
            if (param && used.has(param)) entry.params.add(index);
          });
        }
      });
      readers.set(name, entry);
    }
  }

  function isProductionRead(node) {
    if (node.type !== "CallExpression") return false;
    if (isReadCall(node)) {
      return node.arguments[0] !== undefined && production(node.arguments[0]);
    }
    if (node.callee.type !== "Identifier") return false;
    const reader = readers.get(node.callee.name);
    if (!reader) return false;
    return (
      reader.bodyProd ||
      [...reader.params].some(
        (index) => node.arguments[index] && production(node.arguments[index]),
      )
    );
  }

  function containsProductionRead(node) {
    let found = false;
    walk(node, (inner) => {
      if (isProductionRead(inner)) found = true;
    });
    return found;
  }

  // Names that hold text read from production source, or text derived from it.
  const tainted = new Set();
  const derived = (node) =>
    containsProductionRead(node) ||
    [...referencedNames(node)].some((name) => tainted.has(name));
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, nodes] of bindings) {
      if (!tainted.has(name) && nodes.some(derived)) {
        tainted.add(name);
        changed = true;
      }
    }
    for (const call of calls) {
      if (call.callee.type !== "Identifier") continue;
      const fn = funcs.get(call.callee.name);
      if (!fn) continue;
      fn.params.forEach((param, index) => {
        const argument = call.arguments[index];
        if (param && !tainted.has(param) && argument && derived(argument)) {
          tainted.add(param);
          changed = true;
        }
      });
    }
  }

  const mechanisms = new Set();
  const hasEsbuild = [...aliases.values()].some((a) => a.module === "esbuild");
  for (const call of calls) {
    const callee = call.callee;
    const name = calleeName(callee);
    const first = call.arguments[0];
    // vm: named import/alias, or a method on a vm namespace/default import.
    const vmCallee =
      (callee.type === "Identifier" &&
        aliasFrom(callee.name, ["vm"]) &&
        vmApi.has(aliasFrom(callee.name, ["vm"]).path.at(-1) ?? "")) ||
      (callee.type === "MemberExpression" &&
        !callee.computed &&
        vmApi.has(callee.property.name) &&
        callee.object.type === "Identifier" &&
        aliasFrom(callee.object.name, ["vm"]));
    if (vmCallee && first && derived(first)) mechanisms.add("vm");
    if (
      name === "Function" &&
      (callee.type === "Identifier" || callee.object?.name === "globalThis") &&
      call.arguments.some(derived)
    )
      mechanisms.add("function");
    if (name === "eval" && first && derived(first)) mechanisms.add("eval");
    // transpile of derived text, in a file that also loads code dynamically.
    const modules = transpileApi.get(name);
    if (modules && first && derived(first) && dynamicLoad) {
      const fromModule =
        callee.type === "Identifier"
          ? aliasFrom(callee.name, modules.map(moduleName))
          : callee.type === "MemberExpression" &&
            callee.object.type === "Identifier" &&
            aliasFrom(callee.object.name, modules.map(moduleName));
      if (fromModule) mechanisms.add("transpile");
    }
  }
  // esbuild: any `stdin: { contents }` object whose contents are derived.
  const stdinObjects = [];
  for (const call of calls)
    walk(call, (inner) => {
      if (
        inner.type === "ObjectProperty" &&
        (inner.key.name ?? inner.key.value) === "stdin" &&
        inner.value.type === "ObjectExpression"
      )
        stdinObjects.push(inner.value);
    });
  if (hasEsbuild)
    for (const object of stdinObjects)
      for (const property of object.properties)
        if (
          property.type === "ObjectProperty" &&
          (property.key.name ?? property.key.value) === "contents" &&
          isDerived(property.value) &&
          derived(property.value)
        )
          mechanisms.add("esbuild");

  return {
    readsProduction: calls.some(isProductionRead),
    mechanisms: mechanismOrder.filter((name) => mechanisms.has(name)),
  };
}

// Analyze one file's source. Pure: no filesystem access.
export function analyze(source, file) {
  const ast = parse(source, {
    sourceType: "unambiguous",
    plugins: file.endsWith("x") ? ["typescript", "jsx"] : ["typescript"],
    errorRecovery: false,
  });
  const result = analyzeFacts(gather(ast));
  return {
    ...result,
    textOnly: result.readsProduction && result.mechanisms.length === 0,
  };
}

function collect(dir, scanRoot, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(scanRoot, full).split(path.sep).join("/");
    if (skippedDirectories.has(entry.name)) continue;
    if (relative === "tests/architecture/fixtures") continue;
    if (entry.isDirectory()) collect(full, scanRoot, out);
    else if (
      codeExtension.test(entry.name) &&
      (relative.startsWith("tests/") || testFile.test(entry.name))
    )
      out.push(full);
  }
}

// Every code file under tests/, plus co-located *.test.* / *.spec.* files
// anywhere else in the repository.
export function scan(scanRoot) {
  const files = [];
  collect(scanRoot, scanRoot, files);
  const offenders = {};
  const textOnly = [];
  const unparsable = [];
  for (const file of files.sort()) {
    const relative = path.relative(scanRoot, file).split(path.sep).join("/");
    try {
      const result = analyze(fs.readFileSync(file, "utf8"), file);
      if (result.mechanisms.length > 0) offenders[relative] = result.mechanisms;
      else if (result.textOnly) textOnly.push(relative);
    } catch (error) {
      unparsable.push(`${relative}: ${error.message}`);
    }
  }
  return { scanned: files.length, offenders, textOnly, unparsable };
}

function loadAllowlist(scanRoot) {
  const file = path.join(scanRoot, allowlistRelative);
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed.files ?? {};
}

export function diff(result, allowlist) {
  const findings = [];
  for (const entry of result.unparsable)
    findings.push({
      code: "SLICING_UNPARSABLE",
      detail: `${entry} (an unparsable test file fails the gate)`,
    });
  for (const [file, mechanisms] of Object.entries(result.offenders)) {
    const listed = allowlist[file];
    if (!listed)
      findings.push({
        code: "SLICING_NEW_OFFENDER",
        detail: `${file} reads production source and executes derived code (${mechanisms.join(", ")}); import the code under test instead of slicing it`,
      });
    else if (listed.join() !== mechanisms.join())
      findings.push({
        code: "SLICING_ALLOWLIST_STALE",
        detail: `${file} is listed as [${listed.join(", ")}] but now offends as [${mechanisms.join(", ")}]; regenerate with --write-allowlist (shrink only)`,
      });
  }
  for (const file of Object.keys(allowlist))
    if (!result.offenders[file])
      findings.push({
        code: "SLICING_ALLOWLIST_STALE",
        detail: `${file} no longer offends; remove it from ${allowlistRelative}`,
      });
  return findings;
}

function writeAllowlistFile(scanRoot, files) {
  const target = path.join(scanRoot, allowlistRelative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `${JSON.stringify({ schema: 1, files }, null, 2)}\n`,
  );
}

// --write-allowlist: shrink only. Removes entries and mechanisms that no
// longer offend; any growth (new file, added mechanism) fails and writes
// nothing.
export function shrinkAllowlist(result, current) {
  const next = {};
  const growth = [];
  for (const [file, mechanisms] of Object.entries(result.offenders)) {
    const listed = current[file];
    if (!listed) {
      growth.push(`${file}: new offender (${mechanisms.join(", ")})`);
      continue;
    }
    const added = mechanisms.filter((name) => !listed.includes(name));
    if (added.length > 0)
      growth.push(`${file}: new mechanism (${added.join(", ")})`);
    const kept = mechanismOrder.filter(
      (name) => listed.includes(name) && mechanisms.includes(name),
    );
    if (kept.length > 0) next[file] = kept;
  }
  return { next, growth };
}

function main() {
  const result = scan(root);
  const current = loadAllowlist(root);
  if (flag("--write-allowlist")) {
    const { next, growth } = shrinkAllowlist(result, current);
    if (growth.length > 0) {
      for (const entry of growth)
        console.error(`refused, allowlist may only shrink: ${entry}`);
      process.exit(1);
    }
    writeAllowlistFile(root, next);
    console.log(
      `allowlist written: ${Object.keys(next).length} listed, ${Object.keys(current).length - Object.keys(next).length} dropped`,
    );
    process.exit(0);
  }
  if (flag("--init-allowlist")) {
    if (Object.keys(current).length > 0) {
      console.error(
        `refused: ${allowlistRelative} already lists ${Object.keys(current).length} files; use --write-allowlist to shrink it`,
      );
      process.exit(1);
    }
    writeAllowlistFile(root, result.offenders);
    console.log(
      `allowlist initialized: ${Object.keys(result.offenders).length} listed`,
    );
    process.exit(0);
  }
  const findings = diff(result, current);
  const byMechanism = {};
  for (const mechanisms of Object.values(result.offenders))
    for (const name of mechanisms)
      byMechanism[name] = (byMechanism[name] ?? 0) + 1;
  const summary = {
    scanned: result.scanned,
    offenders: Object.keys(result.offenders).length,
    byMechanism,
    textOnly: result.textOnly.length,
    findings,
  };
  if (json) console.log(JSON.stringify(summary));
  else {
    for (const finding of findings)
      console.error(`${finding.code}: ${finding.detail}`);
    console.log(
      `source-slicing: ${summary.scanned} test files, ${summary.offenders} allowlisted offenders, ${summary.textOnly} text-only, ${findings.length} findings`,
    );
  }
  process.exit(findings.length > 0 ? 1 : 0);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
