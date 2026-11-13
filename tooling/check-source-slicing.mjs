#!/usr/bin/env node
// Refuses a NEW test that reads production source text and executes code
// derived from it. Existing offenders live in one shrink-only allowlist.
//
// A file offends when it BOTH reads production source text (an fs read call
// plus a string literal or path.join/resolve of literals naming a
// .ts/.tsx/.mts/.js/.go file under src/, apps/, boot/, modules/, pkg/,
// transport/ or cmd/) AND executes derived code by one of these mechanisms:
//   vm         imports node:vm
//   function   new Function(...) / Function(...)
//   eval       eval(...) or globalThis.eval(...)
//   transpile  a TypeScript/Babel/esbuild transpile call followed by a
//              dynamic import, require or module compile of the output
//   esbuild    an esbuild build with a non-literal `stdin.contents`
// Tests that only assert on source text are reported, never blocked.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(here, "..");
const allowlistRelative = "tests/architecture/source-slicing-allowlist.json";
const codeExtension = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const productionPath =
  /(?:^|\/)(?:src|apps|boot|modules|pkg|transport|cmd)\/[^\s"'`]*\.(?:ts|tsx|mts|js|go)(?![\w])/;
const readCalls = new Set(["readFileSync", "readFile", "createReadStream"]);
const transpileCalls = new Set([
  "transpileModule",
  "transpile",
  "stripTypeScriptTypes",
  "transformSync",
  "transformAsync",
  "transformFileSync",
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

// Analyze one file's source. Pure: no filesystem access.
export function analyze(source, file) {
  const ast = parse(source, {
    sourceType: "unambiguous",
    plugins: file.endsWith("x") ? ["typescript", "jsx"] : ["typescript"],
    errorRecovery: false,
  });
  const imports = new Set();
  let reads = false;
  let production = false;
  let newFunction = false;
  let evalCall = false;
  let transpile = false;
  let dynamicLoad = false;
  let esbuildInline = false;
  const importedFrom = (spec) =>
    [...imports].some((name) => name === spec || name === `node:${spec}`);
  walk(ast.program, (node) => {
    switch (node.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (node.source) imports.add(node.source.value);
        break;
      case "CallExpression":
      case "NewExpression": {
        const name = calleeName(node.callee);
        if (
          node.type === "CallExpression" &&
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments[0]?.type === "StringLiteral"
        )
          imports.add(node.arguments[0].value);
        if (node.type === "CallExpression" && node.callee.type === "Import") {
          if (node.arguments[0]?.type === "StringLiteral")
            imports.add(node.arguments[0].value);
          else dynamicLoad = true;
        }
        if (readCalls.has(name)) reads = true;
        if (name === "Function") newFunction = true;
        if (name === "eval") evalCall = true;
        if (transpileCalls.has(name)) transpile = true;
        if (name === "_compile") dynamicLoad = true;
        if (name === "require" && node.arguments[0]?.type !== "StringLiteral")
          dynamicLoad = true;
        if (name === "join" || name === "resolve" || name === "URL") {
          const joined = node.arguments
            .map(literalText)
            .filter((text) => text !== null)
            .join("/");
          if (productionPath.test(joined)) production = true;
        }
        break;
      }
      case "ObjectProperty": {
        const key = node.key.name ?? node.key.value;
        if (key === "stdin" && node.value.type === "ObjectExpression")
          for (const inner of node.value.properties)
            if (
              inner.type === "ObjectProperty" &&
              (inner.key.name ?? inner.key.value) === "contents" &&
              literalText(inner.value) === null
            )
              esbuildInline = true;
        break;
      }
      default:
        break;
    }
    if (node.type === "StringLiteral" || node.type === "TemplateLiteral") {
      const text = literalText(node);
      if (text !== null && productionPath.test(text.replaceAll("\u0000", "/")))
        production = true;
    }
  });
  const mechanisms = [];
  if (importedFrom("vm")) mechanisms.push("vm");
  if (newFunction) mechanisms.push("function");
  if (evalCall) mechanisms.push("eval");
  if (transpile && dynamicLoad) mechanisms.push("transpile");
  if (importedFrom("esbuild") && esbuildInline) mechanisms.push("esbuild");
  const readsProduction = reads && production;
  return {
    readsProduction,
    mechanisms: readsProduction
      ? mechanismOrder.filter((name) => mechanisms.includes(name))
      : [],
    textOnly: readsProduction && mechanisms.length === 0,
  };
}

function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (
      entry.name === "node_modules" ||
      full.endsWith(path.join("tests", "architecture", "fixtures"))
    )
      continue;
    if (entry.isDirectory()) collect(full, out);
    else if (codeExtension.test(entry.name)) out.push(full);
  }
}

export function scan(scanRoot) {
  const files = [];
  const testsDir = path.join(scanRoot, "tests");
  if (fs.existsSync(testsDir)) collect(testsDir, files);
  const srcDir = path.join(scanRoot, "src");
  if (fs.existsSync(srcDir)) {
    const colocated = [];
    collect(srcDir, colocated);
    files.push(...colocated.filter((f) => /\.(?:test|spec)\.[a-z]+$/.test(f)));
  }
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
    findings.push({ code: "SLICING_UNPARSABLE", detail: entry });
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

function writeAllowlist(scanRoot, result, current, admitNew) {
  const next = {};
  for (const [file, mechanisms] of Object.entries(result.offenders)) {
    if (!current[file] && !admitNew) continue;
    next[file] = mechanisms;
  }
  const dropped = Object.keys(current).filter((file) => !next[file]);
  const refused = Object.keys(result.offenders).filter(
    (file) => !current[file] && !admitNew,
  );
  const target = path.join(scanRoot, allowlistRelative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `${JSON.stringify({ schema: 1, files: next }, null, 2)}\n`,
  );
  return { dropped, refused };
}

function main() {
  const result = scan(root);
  const current = loadAllowlist(root);
  if (flag("--write-allowlist") || flag("--init-allowlist")) {
    const { dropped, refused } = writeAllowlist(
      root,
      result,
      current,
      flag("--init-allowlist"),
    );
    console.log(
      `allowlist written: ${Object.keys(result.offenders).length - refused.length} listed, ${dropped.length} dropped, ${refused.length} refused`,
    );
    for (const file of refused) console.error(`refused new offender: ${file}`);
    process.exit(refused.length > 0 ? 1 : 0);
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
