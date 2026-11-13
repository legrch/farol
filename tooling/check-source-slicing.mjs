#!/usr/bin/env node
// Refuses a NEW test that reads production source text and executes code
// derived from it. Existing offenders live in one shrink-only allowlist.
//
// A file offends when code that it executes derives, by data flow inside the
// file, from an fs read (or a bundler `?raw` import) of a production file: a
// .ts/.tsx/.mts/.js/.mjs/.cjs/.go file under src/, apps/, boot/, modules/,
// pkg/, transport/, cmd/ or tooling/. The path is evaluated as a bounded set
// of candidate strings (one per binding alternative, callee names skipped);
// any candidate counts unless it reaches the production match through a
// fixtures/ or node_modules/ segment. It is followed through bindings,
// assignments, member assignments, callbacks and same-file reader helpers
// (including helpers that add the root themselves). Import specifiers and test
// titles never count. Mechanisms:
//   vm         vm.runIn*Context, vm.Script, vm.compileFunction
//   function   new Function(...) / Function(...)
//   eval       eval(...), (0, eval)(...), globalThis.eval(...)
//   load       the LOADED CONTENT is derived text: a data: URL built from
//              it, a file written from it and then imported, or the first
//              argument of module._compile. A specifier merely computed from
//              text names real modules and does not count.
//   transpile  a TypeScript/Babel/esbuild transpile call on derived text, in a
//              file that also loads code dynamically
//   esbuild    an esbuild build with `stdin.contents` derived from the read
// A reviewed false positive can be waived with a comment line
// `// source-slicing: allowed - <reason>` (reason of 10+ characters) in the
// first 30 lines; a waiver on a file that is not flagged is an error.
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
const productionRoots = "src|apps|boot|modules|pkg|transport|cmd|tooling";
const productionFile = new RegExp(
  `(?:^|/)(?:${productionRoots})/[^\\s"'\`]*\\.(?:ts|tsx|mts|js|mjs|cjs|go)(?![\\w])`,
  "g",
);
const productionRootSegment = new RegExp(
  `(?:^|/)(?:${productionRoots})(?:/|$)`,
  "g",
);
const codeFileEnding = /\.(?:ts|tsx|mts|js|mjs|cjs|go)$/;

// A candidate path counts when a production match is not reached through a
// fixtures/ or node_modules/ directory: whatever literal text precedes the
// match may not contain such a segment. Other prefixes (a temp directory, a
// computed root) are fine, because the root is usually computed.
function rootRelative(text, pattern) {
  for (const match of text.matchAll(pattern)) {
    const prefix = text.slice(0, match.index);
    if (
      !prefix
        .split("/")
        .some((segment) => segment === "fixtures" || segment === "node_modules")
    )
      return true;
  }
  return false;
}
const productionText = (text) => rootRelative(text, productionFile);
const prefixesProduction = (text) => rootRelative(text, productionRootSegment);
const minimumReason = 10;
// `// source-slicing: allowed - <reason>` as a parsed line comment that
// starts within the first 30 lines; text inside strings or block comments
// never counts.
const waiverLine =
  /^\s*source-slicing:\s*allowed(?:\s*[\u2014\u2013-]+\s*(.*))?$/;
function waiverOf(comments) {
  for (const comment of comments ?? []) {
    if (comment.type !== "CommentLine" || comment.loc.start.line > 30) continue;
    const match = waiverLine.exec(comment.value);
    if (match) return { reason: (match[1] ?? "").trim() };
  }
  return null;
}
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
const mechanismOrder = [
  "vm",
  "function",
  "eval",
  "load",
  "transpile",
  "esbuild",
];
const writeCalls = new Set([
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
]);

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
    if (inner.type === "ThisExpression") names.add("this");
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

function rootName(node) {
  let current = node;
  while (current?.type === "MemberExpression") current = current.object;
  if (
    current?.type === "Identifier" &&
    !["process", "globalThis"].includes(current.name)
  )
    return current.name;
  return null;
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
  const callbacks = []; // { call, fn }
  const loads = []; // { kind: "specifier" | "compile", node }
  const written = []; // { target, content } from writeFile calls
  const seeded = new Set(); // names bound to production text directly
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
        if (/\?raw$/.test(node.source.value))
          for (const spec of node.specifiers)
            if (productionText(node.source.value.replace(/\?raw$/, "")))
              seeded.add(spec.local.name);
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
      case "AssignmentExpression": {
        for (const name of patternNames(node.left)) bind(name, node.right);
        const owner = rootName(node.left);
        if (node.left.type === "MemberExpression" && owner)
          bind(owner, node.right);
        break;
      }
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
        for (const argument of node.arguments)
          if (
            argument.type === "ArrowFunctionExpression" ||
            argument.type === "FunctionExpression"
          )
            callbacks.push({ call: node, fn: argument });
        const name = calleeName(node.callee);
        if (writeCalls.has(name) && node.arguments.length >= 2) {
          // writeFile(target, derived): the target file holds derived text.
          const target = rootName(node.arguments[0]);
          if (target) written.push({ target, content: node.arguments[1] });
        }
        const first = node.arguments[0];
        if (node.type === "CallExpression" && node.callee.type === "Import") {
          if (first?.type !== "StringLiteral") {
            dynamicLoad = true;
            if (first) loads.push({ kind: "specifier", node: first });
          }
        }
        if (name === "_compile") {
          dynamicLoad = true;
          if (first) loads.push({ kind: "compile", node: first });
        }
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          first?.type !== "StringLiteral"
        ) {
          dynamicLoad = true;
          if (first) loads.push({ kind: "specifier", node: first });
        }
        break;
      }
      default:
        break;
    }
  });
  return {
    aliases,
    bindings,
    funcs,
    calls,
    callbacks,
    loads,
    written,
    seeded,
    dynamicLoad,
  };
}

function analyzeFacts(facts) {
  const {
    aliases,
    bindings,
    funcs,
    calls,
    callbacks,
    loads,
    written,
    seeded,
    dynamicLoad,
  } = facts;
  const aliasFrom = (name, modules) => {
    const alias = aliases.get(name);
    return alias && modules.includes(alias.module) ? alias : null;
  };

  // Candidate path strings a node can spell (bounded). Bindings contribute one
  // alternative each; callee identifiers and function bodies are skipped, so a
  // shadowing `const resolve = vi.fn(...)` cannot pollute a path.
  const maxCandidates = 96;
  const candidateCache = [new Map(), new Map(), new Map(), new Map()];
  const cross = (lists, glue) => {
    let out = [];
    let first = true;
    for (const list of lists) {
      const options = list.length > 0 ? list : [""];
      if (first) {
        out = options.slice(0, maxCandidates);
        first = false;
        continue;
      }
      const next = [];
      for (const left of out)
        for (const right of options) {
          if (next.length < maxCandidates) next.push(left + glue + right);
        }
      out = next;
    }
    return out;
  };
  // `import("...")` and `require("...")`: their specifier is never a read path.
  const moduleLoad = (node) =>
    node.type === "CallExpression" &&
    (node.callee.type === "Import" ||
      (node.callee.type === "Identifier" && node.callee.name === "require"));
  function candidates(node, depth = 0) {
    if (!node || depth > 3) return [];
    const cache = candidateCache[depth];
    if (cache.has(node)) return cache.get(node);
    cache.set(node, []);
    let result = [];
    switch (node.type) {
      case "StringLiteral":
        result = [node.value];
        break;
      case "TemplateLiteral": {
        const parts = [];
        node.quasis.forEach((quasi, index) => {
          parts.push([quasi.value.cooked ?? quasi.value.raw]);
          if (node.expressions[index])
            parts.push(candidates(node.expressions[index], depth));
        });
        result = cross(parts, "");
        break;
      }
      case "CallExpression":
      case "NewExpression":
        // A module specifier names code to load, not a file to read.
        if (moduleLoad(node)) break;
        // A method call contributes its receiver as well as its arguments.
        result = [
          ...(node.callee.type === "MemberExpression"
            ? candidates(node.callee.object, depth)
            : []),
          ...cross(
            node.arguments.map((argument) => candidates(argument, depth)),
            "/",
          ),
        ];
        break;
      case "SpreadElement":
        result = candidates(node.argument, depth);
        break;
      case "ObjectExpression":
        for (const property of node.properties)
          if (property.type === "ObjectProperty")
            result.push(...candidates(property.value, depth));
          else if (property.type === "SpreadElement")
            result.push(...candidates(property.argument, depth));
        break;
      case "Identifier":
        for (const bound of bindings.get(node.name) ?? [])
          if (
            bound.type !== "FunctionDeclaration" &&
            bound.type !== "ArrowFunctionExpression" &&
            bound.type !== "FunctionExpression"
          )
            result.push(...candidates(bound, depth + 1));
        break;
      case "BinaryExpression":
        result = cross(
          [candidates(node.left, depth), candidates(node.right, depth)],
          "",
        );
        break;
      case "ConditionalExpression":
        result = [
          ...candidates(node.consequent, depth),
          ...candidates(node.alternate, depth),
        ];
        break;
      case "LogicalExpression":
        result = [
          ...candidates(node.left, depth),
          ...candidates(node.right, depth),
        ];
        break;
      case "ArrayExpression":
        for (const element of node.elements)
          result.push(...candidates(element, depth));
        break;
      case "AwaitExpression":
      case "ParenthesizedExpression":
        result = candidates(node.argument ?? node.expression, depth);
        break;
      case "TSAsExpression":
      case "TSNonNullExpression":
      case "TSSatisfiesExpression":
        result = candidates(node.expression, depth);
        break;
      case "MemberExpression":
        result = candidates(node.object, depth);
        break;
      default:
        // Unknown shapes (callbacks, object values, ...) still contribute each
        // string literal they spell, as separate candidates.
        {
          const specifiers = new Set();
          walk(node, (inner) => {
            if (moduleLoad(inner))
              for (const argument of inner.arguments) specifiers.add(argument);
            if (specifiers.has(inner)) return;
            const text = literalText(inner);
            if (text !== null && result.length < maxCandidates)
              result.push(text.replaceAll("\u0000", "/"));
          });
        }
        break;
    }
    result = result.slice(0, maxCandidates);
    cache.set(node, result);
    return result;
  }
  const production = (node) => candidates(node).some(productionText);

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
      const entry = readers.get(name) ?? {
        bodyProd: false,
        prefixRoot: false,
        params: new Set(),
      };
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
        if (target?.prefixRoot) entry.prefixRoot = true;
        for (const [, argument] of pathArgs) {
          if (!argument) continue;
          if (production(argument)) entry.bodyProd = true;
          // The helper adds the production root itself: read(rel) -> src/rel.
          if (candidates(argument).some(prefixesProduction))
            entry.prefixRoot = true;
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
        (index) =>
          node.arguments[index] &&
          (production(node.arguments[index]) ||
            (reader.prefixRoot &&
              candidates(node.arguments[index]).some((text) =>
                codeFileEnding.test(text),
              ))),
      )
    );
  }

  const containsCache = new Map();
  function containsProductionRead(node) {
    if (containsCache.has(node)) return containsCache.get(node);
    let found = false;
    walk(node, (inner) => {
      if (!found && isProductionRead(inner)) found = true;
    });
    containsCache.set(node, found);
    return found;
  }
  const namesCache = new Map();
  const namesOf = (node) => {
    if (!namesCache.has(node)) namesCache.set(node, referencedNames(node));
    return namesCache.get(node);
  };

  // Names that hold text read from production source, or text derived from it.
  const tainted = new Set(seeded);
  const derived = (node) =>
    containsProductionRead(node) ||
    [...namesOf(node)].some((name) => tainted.has(name));
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, nodes] of bindings) {
      if (!tainted.has(name) && nodes.some(derived)) {
        tainted.add(name);
        changed = true;
      }
    }
    // A callback receives the call's result: fs.readFile(p, (e, text) => ...),
    // read(p).then((text) => ...).
    for (const { call, fn } of callbacks) {
      const source =
        derived(call.callee) ||
        isProductionRead(call) ||
        call.arguments.some((argument) => argument !== fn && derived(argument));
      if (!source) continue;
      for (const param of fn.params)
        for (const name of patternNames(param))
          if (!tainted.has(name)) {
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
  // load: the LOADED CONTENT is derived text. A specifier merely computed
  // from text is not: it names real modules.
  const writtenTargets = new Set(
    written
      .filter(({ content }) => derived(content))
      .map(({ target }) => target),
  );
  const contentUrl = (node) =>
    candidates(node).some((text) => /^data:/.test(text)) ||
    (node.type === "TemplateLiteral" &&
      /^data:/.test(node.quasis[0]?.value.raw ?? ""));
  for (const { kind, node } of loads) {
    if (kind === "compile" && derived(node)) mechanisms.add("load");
    if (
      kind === "specifier" &&
      ((contentUrl(node) && derived(node)) ||
        [...namesOf(node)].some((name) => writtenTargets.has(name)))
    )
      mechanisms.add("load");
  }
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
        moduleOrigin(callee.object, aliases)?.module === "vm");
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
            modules
              .map(moduleName)
              .includes(moduleOrigin(callee.object, aliases)?.module);
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
    waiver: waiverOf(ast.comments),
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
  const waived = [];
  const waiverErrors = [];
  for (const file of files.sort()) {
    const relative = path.relative(scanRoot, file).split(path.sep).join("/");
    try {
      const result = analyze(fs.readFileSync(file, "utf8"), file);
      const waiver = result.waiver;
      if (waiver && waiver.reason.length < minimumReason) {
        waiverErrors.push({
          code: "SLICING_WAIVER_INVALID",
          detail: `${relative}: a source-slicing waiver needs a reason of at least ${minimumReason} characters`,
        });
        continue;
      }
      if (waiver && result.mechanisms.length === 0) {
        waiverErrors.push({
          code: "SLICING_WAIVER_STALE",
          detail: `${relative}: the waiver is not needed because the file is not flagged; remove it`,
        });
        continue;
      }
      if (waiver)
        waived.push({
          file: relative,
          reason: waiver.reason,
          mechanisms: result.mechanisms,
        });
      else if (result.mechanisms.length > 0)
        offenders[relative] = result.mechanisms;
      else if (result.textOnly) textOnly.push(relative);
    } catch (error) {
      unparsable.push(`${relative}: ${error.message}`);
    }
  }
  return {
    scanned: files.length,
    offenders,
    textOnly,
    unparsable,
    waived,
    waiverErrors,
  };
}

function loadAllowlist(scanRoot) {
  const file = path.join(scanRoot, allowlistRelative);
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed.files ?? {};
}

export function diff(result, allowlist) {
  const findings = [...(result.waiverErrors ?? [])];
  for (const entry of result.waived)
    if (allowlist[entry.file])
      findings.push({
        code: "SLICING_WAIVER_ON_LEGACY",
        detail: `${entry.file} is an allowlisted legacy slicer and cannot be waived; fix the test or remove the waiver`,
      });
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
  for (const entry of result.waived)
    if (current[entry.file])
      growth.push(
        `${entry.file}: a legacy slicer cannot be waived; fix the test or keep the entry`,
      );
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
    const target = path.join(root, allowlistRelative);
    if (fs.existsSync(target) && !flag("--force-init")) {
      console.error(
        `refused: ${allowlistRelative} already exists (${Object.keys(current).length} files); use --write-allowlist to shrink it`,
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
    waived: result.waived.length,
    waivedFiles: result.waived,
    findings,
  };
  if (json) console.log(JSON.stringify(summary));
  else {
    for (const entry of result.waived)
      console.log(`waived: ${entry.file} (${entry.reason})`);
    for (const finding of findings)
      console.error(`${finding.code}: ${finding.detail}`);
    console.log(
      `source-slicing: ${summary.scanned} test files, ${summary.offenders} allowlisted offenders, ${summary.textOnly} text-only, ${summary.waived} waived, ${findings.length} findings`,
    );
  }
  process.exit(findings.length > 0 ? 1 : 0);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
