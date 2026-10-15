import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import {
  RUNTIME_LAUNCH_MANIFEST,
  assertRuntimeLaunchManifest,
} from "./runtime-launch-manifest.mjs";

const apis = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]);
const processModule = (name) =>
  ["child_process", "node:child_process"].includes(name);
const toolchain = (value) =>
  /(?:^|[\s/])(?:python(?:\d+(?:\.\d+)*)?|node|npm|npx|go|gcc|clang|xcrun|xcodebuild)(?:$|[\s])/u.test(
    value,
  );
const python = (value) =>
  /(?:^|[\s/])python(?:\d+(?:\.\d+)*)?(?:$|[\s])/u.test(value);
const children = (node) =>
  Object.entries(node)
    .filter(
      ([key]) =>
        ![
          "loc",
          "extra",
          "comments",
          "leadingComments",
          "trailingComments",
          "innerComments",
        ].includes(key),
    )
    .flatMap(([, value]) =>
      Array.isArray(value)
        ? value.filter((x) => x?.type)
        : value?.type
          ? [value]
          : [],
    );
const unwrap = (node) =>
  [
    "TSAsExpression",
    "TSTypeAssertion",
    "TSNonNullExpression",
    "ParenthesizedExpression",
    "AwaitExpression",
    "ChainExpression",
  ].includes(node?.type)
    ? unwrap(node.expression ?? node.argument)
    : node;
function expression(node) {
  node = unwrap(node);
  if (!node) return "<missing>";
  if (node.type === "Identifier") return node.name;
  if (
    [
      "StringLiteral",
      "NumericLiteral",
      "BooleanLiteral",
      "NullLiteral",
    ].includes(node.type)
  )
    return JSON.stringify(node.value ?? null);
  if (["MemberExpression", "OptionalMemberExpression"].includes(node.type))
    return (
      expression(node.object) +
      (node.optional ? "?." : node.computed ? "" : ".") +
      (node.computed
        ? `[${expression(node.property)}]`
        : expression(node.property))
    );
  if (["LogicalExpression", "BinaryExpression"].includes(node.type))
    return expression(node.left) + node.operator + expression(node.right);
  if (node.type === "CallExpression" || node.type === "OptionalCallExpression")
    return (
      expression(node.callee) +
      "(" +
      node.arguments.map(expression).join(",") +
      ")"
    );
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return JSON.stringify(node.quasis[0].value.cooked);
  return `<${node.type}>`;
}
function value(node, scope, seen = new Set()) {
  node = unwrap(node);
  if (!node) return null;
  if (node.type === "Identifier") {
    const binding = scope.get(node.name);
    if (!binding || seen.has(binding)) return null;
    if (!binding.node) return binding;
    seen.add(binding);
    const result = value(binding.node, binding.scope, seen);
    return binding.property && result?.kind === "namespace"
      ? { kind: "launcher", api: binding.property }
      : result;
  }
  if (node.type === "StringLiteral")
    return { kind: "literal", text: node.value };
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return { kind: "literal", text: node.quasis[0].value.cooked };
  if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)) {
    const owner = value(node.object, scope, seen);
    const member = node.computed ? node.property.value : node.property.name;
    if (owner?.kind === "namespace" && apis.has(member))
      return { kind: "launcher", api: member };
  }
  if (node.type === "CallExpression") {
    const name = expression(node.callee);
    if (
      ["require", "module.require", "process.getBuiltinModule"].includes(
        name,
      ) &&
      processModule(node.arguments[0]?.value)
    )
      return { kind: "namespace" };
    if (value(node.callee, scope, seen)?.kind === "promisify")
      return value(node.arguments[0], scope, seen);
    if (
      node.callee.type === "MemberExpression" &&
      node.callee.property.name === "bind"
    )
      return value(node.callee.object, scope, seen);
  }
  if (node.type === "ImportExpression" && processModule(node.source.value))
    return { kind: "namespace" };
  return null;
}
function scopeFor(statements, parent) {
  const scope = new Map(parent);
  for (let statement of statements) {
    if (
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
    )
      statement = statement.declaration ?? statement;
    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type") continue;
      for (const spec of statement.specifiers) {
        if (spec.importKind === "type") continue;
        const name = spec.imported?.name;
        scope.set(
          spec.local.name,
          processModule(statement.source.value)
            ? name
              ? { kind: "launcher", api: name }
              : { kind: "namespace" }
            : statement.source.value === "node:util" && name === "promisify"
              ? { kind: "promisify" }
              : null,
        );
      }
    }
    if (statement.type === "VariableDeclaration")
      for (const declaration of statement.declarations) {
        if (declaration.id.type === "Identifier")
          scope.set(declaration.id.name, { node: declaration.init, scope });
        if (declaration.id.type === "ObjectPattern")
          for (const property of declaration.id.properties) {
            if (
              property.type === "ObjectProperty" &&
              property.value.type === "Identifier"
            )
              scope.set(property.value.name, {
                node: declaration.init,
                scope,
                property: property.key.name ?? property.key.value,
              });
          }
      }
    if (statement.type === "FunctionDeclaration" && statement.id)
      scope.set(statement.id.name, null);
  }
  return scope;
}
function literals(node, scope) {
  const resolved = value(node, scope);
  if (resolved?.kind === "literal") return [resolved.text];
  return node ? children(node).flatMap((child) => literals(child, scope)) : [];
}
function parseSource(source) {
  return parse(source, {
    sourceType: "unambiguous",
    createImportExpressions: true,
    plugins: ["typescript", "jsx"],
  });
}

export function inventoryJavaScript(file, source) {
  const launches = [],
    commands = [],
    templates = [],
    issues = [];
  let ast;
  try {
    ast = parseSource(source);
  } catch {
    return { launches, commands, templates, issues: [`SOURCE_PARSE:${file}`] };
  }
  function visit(node, scope, names = [], className = "", parent = null) {
    if (node.type === "Program" || node.type === "BlockStatement")
      scope = scopeFor(node.body, scope);
    if (["ClassDeclaration", "ClassExpression"].includes(node.type))
      className = node.id?.name ?? "<anonymous-class>";
    const isFunction = [
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
      "ObjectMethod",
      "ClassMethod",
      "ClassPrivateMethod",
    ].includes(node.type);
    if (isFunction) {
      const own =
        node.id?.name ??
        (node.type.includes("Method")
          ? (node.key.name ?? node.key.value)
          : parent?.type === "VariableDeclarator"
            ? parent.id.name
            : null);
      if (own)
        names = [
          ...names,
          node.type.startsWith("Class") ? `${className}.${own}` : own,
        ];
      scope = new Map(scope);
      for (const parameter of node.params) {
        const p =
          parameter.type === "TSParameterProperty"
            ? parameter.parameter
            : parameter;
        const id = p.type === "AssignmentPattern" ? p.left : p;
        if (id.type === "Identifier") scope.set(id.name, null);
        if (id.type === "ObjectPattern")
          for (const entry of id.properties)
            if (entry.value?.type === "Identifier")
              scope.set(entry.value.name, null);
      }
    }
    const symbol = names.join(".") || "<module>";
    if (
      ["MemberExpression", "OptionalMemberExpression"].includes(node.type) &&
      value(node.object, scope)?.kind === "namespace" &&
      node.computed &&
      node.property.type !== "StringLiteral"
    )
      issues.push(`DYNAMIC_LAUNCHER_MEMBER:${file}:${symbol}`);
    if (
      node.type === "AssignmentExpression" &&
      ["launcher", "namespace"].includes(value(node.right, scope)?.kind)
    )
      issues.push(`LAUNCHER_ASSIGNMENT:${file}:${symbol}`);
    if (["CallExpression", "OptionalCallExpression"].includes(node.type)) {
      let target = value(node.callee, scope),
        args = node.arguments;
      if (
        !target &&
        node.callee.type === "MemberExpression" &&
        ["call", "apply"].includes(node.callee.property.name)
      ) {
        target = value(node.callee.object, scope);
        args =
          node.callee.property.name === "call"
            ? args.slice(1)
            : (args[1]?.elements ?? []);
      }
      if (target?.kind === "launcher" && apis.has(target.api)) {
        const selected = args[0];
        const literalValues = literals(selected, scope);
        if (
          literalValues.some(
            (x) =>
              /(?:^|\/)env$/u.test(x) || /(?:^|\/)(?:ba|z|fi)?sh$/u.test(x),
          )
        )
          literalValues.push(...literals(args[1], scope));
        launches.push({
          file,
          symbol,
          api: target.api,
          executable: expression(selected),
          toolchain: literalValues.some(toolchain),
          nonPythonToolchain: literalValues.some(
            (x) => toolchain(x) && !python(x),
          ),
        });
      }
    }
    if (node.type === "SwitchCase" && node.test?.type === "StringLiteral") {
      const calls = [],
        tries = [];
      function caseWalk(n) {
        if (["CallExpression", "OptionalCallExpression"].includes(n.type))
          calls.push(expression(n.callee));
        if (n.type === "TryStatement") tries.push(n);
        for (const child of children(n)) caseWalk(child);
      }
      for (const statement of node.consequent) caseWalk(statement);
      commands.push({ file, symbol, command: node.test.value, calls, tries });
    }
    if (node.type === "TemplateLiteral") {
      const text = node.quasis
        .map((q) =>
          parent?.type === "TaggedTemplateExpression" &&
          expression(parent.tag) === "String.raw"
            ? q.value.raw
            : (q.value.cooked ?? q.value.raw),
        )
        .join("0");
      if (text.includes("child_process"))
        templates.push({
          file,
          symbol:
            parent?.type === "VariableDeclarator"
              ? parent.id.name
              : parent?.type === "TaggedTemplateExpression"
                ? null
                : null,
          node,
          text,
        });
      if (/^#![^\n]*\b(?:python\d*|node|npm|go)\b/u.test(text.trimStart()))
        issues.push(`SCRIPT_TOOLCHAIN:${file}:${symbol}`);
    }
    for (const child of children(node)) {
      // Carry the declaration name through String.raw`...` as well.
      if (
        node.type === "TaggedTemplateExpression" &&
        child.type === "TemplateLiteral" &&
        parent?.type === "VariableDeclarator"
      ) {
        const before = templates.length;
        visit(child, scope, names, className, node);
        if (templates.length > before) templates.at(-1).symbol = parent.id.name;
      } else visit(child, scope, names, className, node);
    }
  }
  visit(ast.program, new Map());
  return { launches, commands, templates, issues };
}

// Native scope is intentionally a small token inventory, not a Go type checker.
// It recognizes os/exec import aliases and named function/receiver boundaries;
// aliasing Command itself is refused for review rather than silently missed.
export function inventoryGo(file, source) {
  const launches = [],
    issues = [];
  const matches = [
    ...source.matchAll(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|`[^`]*`|[A-Za-z_]\w*|:=|[^\s]/gu,
    ),
  ].filter((m) => !m[0].startsWith("//") && !m[0].startsWith("/*"));
  const tokens = matches.map((m) => m[0]);
  const imports = new Map();
  const nativeModules = {
    '"os/exec"': "exec",
    '"syscall"': "syscall",
    '"golang.org/x/sys/unix"': "unix",
    '"os"': "os",
  };
  for (let i = 0; i < tokens.length; i++)
    if (nativeModules[tokens[i]]) {
      if (tokens[i - 1] === ".") issues.push(`GO_DYNAMIC_IMPORT_ALIAS:${file}`);
      imports.set(
        /^[A-Za-z_]\w*$/u.test(tokens[i - 1] ?? "") &&
          tokens[i - 1] !== "import"
          ? tokens[i - 1]
          : nativeModules[tokens[i]],
        nativeModules[tokens[i]],
      );
    }
  if (imports.size === 0) return { launches, issues };
  function end(start, open, close) {
    let depth = 0;
    for (let i = start; i < tokens.length; i++) {
      if (tokens[i] === open) depth++;
      if (tokens[i] === close && --depth === 0) return i;
    }
    return tokens.length - 1;
  }
  const functions = [];
  for (let i = 0; i < tokens.length; i++)
    if (tokens[i] === "func") {
      let next = i + 1,
        receiver = "";
      if (tokens[next] === "(") {
        const last = end(next, "(", ")");
        receiver =
          tokens
            .slice(next + 1, last)
            .filter((x) => /^[A-Za-z_]\w*$/u.test(x))
            .at(-1) + ".";
        next = last + 1;
      }
      if (
        !/^[A-Za-z_]\w*$/u.test(tokens[next] ?? "") ||
        tokens[next + 1] !== "("
      )
        continue;
      const symbol = receiver + tokens[next];
      next = end(next + 1, "(", ")") + 1;
      while (next < tokens.length && tokens[next] !== "{") next++;
      functions.push({ symbol, start: next, end: end(next, "{", "}") });
    }
  for (let i = 0; i < tokens.length - 2; i++)
    if (
      imports.has(tokens[i]) &&
      tokens[i + 1] === "." &&
      (imports.get(tokens[i]) === "exec"
        ? ["Command", "CommandContext"].includes(tokens[i + 2])
        : ["syscall", "unix"].includes(imports.get(tokens[i]))
          ? tokens[i + 2] === "Exec"
          : tokens[i + 2] === "StartProcess")
    ) {
      const owner = functions
        .filter((f) => f.start < i && f.end > i)
        .sort((a, b) => b.start - a.start)[0];
      if (tokens[i + 3] !== "(") {
        issues.push(`GO_LAUNCHER_ALIAS:${file}:${owner?.symbol ?? "<module>"}`);
        continue;
      }
      const args = [];
      let depth = 0,
        current = [];
      for (let n = i + 4; n < tokens.length; n++) {
        if (depth === 0 && [",", ")"].includes(tokens[n])) {
          args.push(current.join(""));
          current = [];
          if (tokens[n] === ")") break;
          continue;
        }
        if (["(", "[", "{"].includes(tokens[n])) depth++;
        if ([")", "]", "}"].includes(tokens[n])) depth--;
        current.push(tokens[n]);
      }
      const executable = args[tokens[i + 2] === "CommandContext" ? 1 : 0];
      const api =
        imports.get(tokens[i]) === "exec"
          ? "go." + tokens[i + 2]
          : `go.${imports.get(tokens[i])}.${tokens[i + 2]}`;
      const direct =
        executable?.startsWith('"') && toolchain(executable.slice(1, -1));
      const shell =
        executable?.startsWith('"') &&
        /(?:^|\/)(?:env|(?:ba|z|fi)?sh)$/u.test(executable.slice(1, -1));
      launches.push({
        file,
        symbol: owner?.symbol ?? "<module>",
        api,
        executable,
        toolchain: Boolean(direct || (shell && args.slice(1).some(toolchain))),
        nonPythonToolchain: Boolean(
          (direct && !python(executable.slice(1, -1))) ||
          (shell && args.slice(1).some((x) => toolchain(x) && !python(x))),
        ),
      });
    }
  return { launches, issues };
}

export const RUNTIME_GUARD_LIMITS = Object.freeze([
  "Static inventory, not control-flow, entitlement, native execution or package acceptance evidence.",
  "JS scope: child_process imports/require/static import, const aliases, namespaces and promisify wrappers; no eval/reflection/arbitrary generated code proof.",
  "Dynamic executables are allowed only at their exact declared launcher identity; authority/value validation remains with that owner.",
  "Embedded launcher templates are parsed as JS with interpolation placeholders; interpolation semantics and user scripts/hooks are not proved.",
  "Go scope: imported os/exec Command/CommandContext, syscall/unix Exec and os.StartProcess token/function identities; rejects launcher aliases, does not type-check Go or prove FFI/indirect syscall launch closure.",
  "Selected Settings case has a closed direct-call inventory and terminal catch; callees' transitive semantics remain with behavior tests.",
  "Closure checks complement independently trusted existing build/package byte, native artifact and Electron runtime validators; Mach-O magic does not prove Go provenance.",
]);

export function inspectRuntimeLaunches(
  sources,
  manifest = RUNTIME_LAUNCH_MANIFEST,
) {
  assertRuntimeLaunchManifest(manifest);
  const launches = [],
    commands = [],
    templates = [],
    issues = [];
  for (const [file, source] of sources) {
    const result = file.endsWith(".go")
      ? inventoryGo(file, source)
      : inventoryJavaScript(file, source);
    launches.push(...result.launches);
    issues.push(...result.issues);
    commands.push(...(result.commands ?? []));
    templates.push(...(result.templates ?? []));
  }
  const key = (row) =>
    [row.file, row.symbol, row.api, row.executable].join("\0");
  const expected = new Map(manifest.launches.map((row) => [key(row), row]));
  if (expected.size !== manifest.launches.length)
    issues.push("DUPLICATE_LAUNCH_IDENTITY");
  const counts = new Map();
  for (const row of launches) {
    const known = expected.get(key(row));
    if (!known)
      issues.push(
        `UNDECLARED_LAUNCH:${row.file}:${row.symbol}:${row.api}:${row.executable}`,
      );
    if (
      row.toolchain &&
      (known?.classification !== "legacy-python-active" ||
        row.nonPythonToolchain)
    )
      issues.push(`DIRECT_TOOLCHAIN:${row.file}:${row.symbol}`);
    row.classification = known?.classification ?? null;
    row.manifestId = known?.id ?? null;
    row.resources = known?.resources ?? [];
    counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  }
  for (const row of manifest.launches)
    if (counts.get(key(row)) !== row.count)
      issues.push(`STALE_OR_CHANGED_LAUNCH:${row.id}`);
  for (const template of templates) {
    const row = manifest.embedded.find(
      (entry) =>
        entry.file === template.file && entry.symbol === template.symbol,
    );
    if (!row) {
      issues.push(
        `UNDECLARED_EMBEDDED_LAUNCHER:${template.file}:${template.symbol}`,
      );
      continue;
    }
    const result = inventoryJavaScript(template.file, template.text);
    issues.push(...result.issues);
    if (
      result.templates.length ||
      result.launches
        .map((x) => x.executable)
        .sort()
        .join("\0") !== [...row.expressions].sort().join("\0") ||
      result.launches.some((x) => x.toolchain)
    )
      issues.push(
        `EMBEDDED_LAUNCH_CHANGED:${template.file}:${template.symbol}`,
      );
  }
  for (const row of manifest.embedded)
    if (
      templates.filter((t) => t.file === row.file && t.symbol === row.symbol)
        .length !== 1
    )
      issues.push(`STALE_EMBEDDED_LAUNCHER:${row.file}:${row.symbol}`);
  for (const row of manifest.commands) {
    const found = commands.filter(
      (c) =>
        c.file === row.file &&
        c.symbol === row.symbol &&
        c.command === row.command,
    );
    const command = found[0];
    if (
      found.length !== 1 ||
      command.calls.filter((call) => call === row.requiredCall).length !== 1 ||
      command.calls.some((call) => !row.allowedCalls.includes(call))
    ) {
      issues.push(`SELECTED_ROUTE_CHANGED:${row.id}`);
      continue;
    }
    const guarded = command.tries.some((statement) => {
      const awaited = [];
      function walk(n) {
        if (
          n.type === "AwaitExpression" &&
          n.argument.type === "CallExpression"
        )
          awaited.push(expression(n.argument.callee));
        for (const child of children(n)) walk(child);
      }
      walk(statement.block);
      return (
        awaited.includes(row.requiredCall) &&
        ["ReturnStatement", "ThrowStatement"].includes(
          statement.handler?.body.body.at(-1)?.type,
        )
      );
    });
    if (!guarded) issues.push(`SELECTED_ROUTE_NOT_TERMINAL:${row.id}`);
  }
  return {
    ok: issues.length === 0,
    issues,
    launches,
    limits: RUNTIME_GUARD_LIMITS,
  };
}

export async function checkRuntimeLaunches(
  root = process.cwd(),
  manifest = RUNTIME_LAUNCH_MANIFEST,
) {
  assertRuntimeLaunchManifest(manifest);
  for (const owner of new Set(
    [...manifest.resources, ...manifest.boundaries].map((row) => row.owner),
  )) {
    const stat = await fs.lstat(path.join(root, owner));
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`RUNTIME_RESOURCE_OWNER_INVALID:${owner}`);
  }
  const sources = new Map();
  async function walk(directory) {
    for (const entry of await fs.readdir(path.join(root, directory), {
      withFileTypes: true,
    })) {
      const name = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new Error(`RUNTIME_SOURCE_SYMLINK:${name}`);
      if (entry.isDirectory()) await walk(name);
      else if (
        /\.(?:tsx?|jsx?|[cm]?[jt]s|go)$/u.test(name) &&
        !name.endsWith("_test.go")
      )
        sources.set(name, await fs.readFile(path.join(root, name), "utf8"));
    }
  }
  for (const directory of manifest.roots) await walk(directory);
  return inspectRuntimeLaunches(sources, manifest);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const index = process.argv.indexOf("--root");
  const result = await checkRuntimeLaunches(
    index < 0 ? process.cwd() : path.resolve(process.argv[index + 1]),
  );
  if (process.argv.includes("--json"))
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else
    process.stdout.write(
      result.ok
        ? `Runtime launch inventory: ${result.launches.length} declared launches; no acceptance claim.\n`
        : result.issues.join("\n") + "\n",
    );
  process.exitCode = result.ok ? 0 : 1;
}
