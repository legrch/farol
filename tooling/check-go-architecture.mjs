#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = "github.com/legrch/farol";
const modules = new Set(["computer", "task", "chat", "release"]);
// No kernel-to-module peer dependency is approved at K0. Add exact contract
// package paths here only with a deliberate ownership decision.
const kernelPeerContracts = new Set([]);
const pureStandard = new Set([
  "bytes",
  "cmp",
  "encoding/base32",
  "encoding/base64",
  "encoding/binary",
  "encoding/hex",
  "encoding/json",
  "encoding/xml",
  "errors",
  "fmt",
  "hash",
  "hash/adler32",
  "hash/crc32",
  "hash/crc64",
  "hash/fnv",
  "math",
  "math/big",
  "math/bits",
  "net/netip",
  "regexp",
  "regexp/syntax",
  "slices",
  "sort",
  "strconv",
  "strings",
  "time",
  "unicode",
  "unicode/utf8",
  "unicode/utf16",
]);
const pureSelectors = new Map([
  [
    "fmt",
    new Set([
      "Errorf",
      "Sprintf",
      "Sprint",
      "Sprintln",
      "Stringer",
      "Formatter",
      "State",
      "GoStringer",
    ]),
  ],
  [
    "time",
    new Set([
      "Duration",
      "Time",
      "Month",
      "Weekday",
      "Location",
      "ParseError",
      "UTC",
      "Nanosecond",
      "Microsecond",
      "Millisecond",
      "Second",
      "Minute",
      "Hour",
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Date",
      "Unix",
      "UnixMilli",
      "UnixMicro",
      "ParseInLocation",
      "ParseDuration",
      "FixedZone",
      "ANSIC",
      "UnixDate",
      "RubyDate",
      "RFC822",
      "RFC822Z",
      "RFC850",
      "RFC1123",
      "RFC1123Z",
      "RFC3339",
      "RFC3339Nano",
      "Kitchen",
      "Stamp",
      "StampMilli",
      "StampMicro",
      "StampNano",
      "DateTime",
      "DateOnly",
      "TimeOnly",
      "Layout",
    ]),
  ],
  [
    "context",
    new Set([
      "Context",
      "CancelFunc",
      "CancelCauseFunc",
      "Canceled",
      "DeadlineExceeded",
      "Background",
      "TODO",
      "WithValue",
      "WithCancel",
      "WithCancelCause",
      "Cause",
      "WithoutCancel",
    ]),
  ],
]);

function classify(directory) {
  const parts = directory.split("/");
  if (directory === "cmd/farol") return { kind: "cmd" };
  if (parts[0] === "boot") return { kind: "boot" };
  if (parts[0] === "transport" && parts[1] === "desktop")
    return { kind: "transport" };
  if (parts[0] === "gen" && parts[1] === "desktop" && parts[2] === "v1")
    return { kind: "generated" };
  if (parts[0] === "pkg" && parts[1] === "ipc") return { kind: "ipc" };
  if (
    parts[0] === "pkg" &&
    parts[1] === "kernel" &&
    ["domain", "app", "infra"].includes(parts[2])
  ) {
    return { kind: "kernel", layer: parts[2], peer: parts[3] === "peer" };
  }
  if (
    parts[0] === "modules" &&
    modules.has(parts[1]) &&
    ["domain", "app", "contracts", "infra"].includes(parts[2])
  ) {
    if (
      parts[2] === "app" &&
      !["services", "capabilities", "port"].includes(parts[3])
    )
      return { kind: "unclassified" };
    return {
      kind: "module",
      module: parts[1],
      layer: parts[2],
      peer: parts[3] === "peer",
      service: parts[2] === "app" && parts[3] === "services",
    };
  }
  return { kind: "unclassified" };
}

function pure(zone) {
  return (
    ["domain", "app", "contracts"].includes(zone.layer) ||
    zone.kind === "generated"
  );
}

// Lex Go comments and literals before inspecting imports. This scans every build
// variant without executing package initializers or downloading a Go toolchain.
// Go compilation remains responsible for syntax/types and platform selection.
function lex(source) {
  const tokens = [];
  const comments = [];
  let i = 0;
  while (i < source.length) {
    const start = i;
    const char = source[i];
    if (/\s/u.test(char)) {
      i++;
      continue;
    }
    if (source.startsWith("//", i) || source.startsWith("/*", i)) {
      const line = source.startsWith("//", i);
      const end = line
        ? source.indexOf("\n", i + 2)
        : source.indexOf("*/", i + 2);
      if (end === -1 && !line) throw new Error("Unterminated Go comment");
      i = end === -1 ? source.length : end + (line ? 0 : 2);
      comments.push(source.slice(start, i));
    } else if (['"', "`", "'"].includes(char)) {
      i++;
      while (i < source.length && source[i] !== char) {
        if (char !== "`" && source[i] === "\\") i++;
        i++;
      }
      if (i >= source.length) throw new Error("Unterminated Go literal");
      i++;
      tokens.push({
        kind: char === "'" ? "rune" : "string",
        value: source.slice(start, i),
      });
    } else if (/[\p{L}_]/u.test(char)) {
      i++;
      while (i < source.length && /[\p{L}\p{N}_]/u.test(source[i])) i++;
      tokens.push({ kind: "identifier", value: source.slice(start, i) });
    } else {
      tokens.push({ kind: "punctuation", value: char });
      i++;
    }
  }
  return { tokens, comments };
}

function unquote(literal) {
  if (literal[0] === "`") return literal.slice(1, -1).replaceAll("\r", "");
  return literal
    .slice(1, -1)
    .replace(
      /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{3}|[abfnrtv\\"'])/gu,
      (_, escape) => {
        if (escape[0] === "x" || escape[0] === "u" || escape[0] === "U")
          return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
        if (/^[0-7]/u.test(escape))
          return String.fromCodePoint(Number.parseInt(escape, 8));
        return (
          { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }[
            escape
          ] ?? escape
        );
      },
    );
}

function imports(tokens) {
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== "identifier" || tokens[i].value !== "import")
      continue;
    i++;
    const grouped = tokens[i]?.value === "(";
    if (grouped) i++;
    do {
      while (tokens[i]?.value === ";") i++;
      if (grouped && tokens[i]?.value === ")") break;
      let alias;
      if (tokens[i]?.kind === "identifier" || tokens[i]?.value === ".")
        alias = tokens[i++].value;
      if (tokens[i]?.kind !== "string")
        throw new Error("Malformed Go import declaration");
      const specifier = unquote(tokens[i++].value);
      if (
        !specifier ||
        /[\s\\]/u.test(specifier) ||
        specifier.split("/").some((part) => ["", ".", ".."].includes(part))
      )
        throw new Error("Invalid Go import path");
      result.push({ specifier, alias: alias ?? specifier.split("/").at(-1) });
    } while (grouped && i < tokens.length);
    if (grouped && tokens[i]?.value !== ")")
      throw new Error("Unterminated Go import block");
    if (!grouped) i--;
  }
  return result;
}

function localRule(from, to, target, source) {
  if (from.kind === "module") {
    if (to.kind === "boot" || to.kind === "cmd") return "GO_MODULE_TO_BOOT";
    if (to.kind === "kernel" && to.layer === "infra")
      return "GO_MODULE_TO_KERNEL_INFRA";
    if (to.kind === "module" && to.module !== from.module)
      return from.layer === "infra" && from.peer && to.layer === "contracts"
        ? null
        : "GO_CROSS_MODULE";
    if (from.layer === "domain")
      return (to.kind === "module" && to.layer === "domain") ||
        (to.kind === "kernel" && to.layer === "domain")
        ? null
        : "GO_LAYER_DIRECTION";
    if (from.layer === "contracts")
      return (to.kind === "module" &&
        ["contracts", "app", "domain"].includes(to.layer)) ||
        (to.kind === "kernel" && to.layer === "domain")
        ? null
        : "GO_CONTRACT_LEAK";
    if (from.layer === "app") {
      if (from.service && to.service && target !== source)
        return "GO_SERVICE_DEPENDENCY";
      return (to.kind === "module" && ["domain", "app"].includes(to.layer)) ||
        (to.kind === "kernel" && ["domain", "app"].includes(to.layer))
        ? null
        : "GO_LAYER_DIRECTION";
    }
    return ["module", "kernel", "ipc", "generated"].includes(to.kind)
      ? null
      : "GO_LAYER_DIRECTION";
  }
  if (from.kind === "kernel") {
    if (to.kind === "module")
      return from.layer === "infra" &&
        from.peer &&
        to.layer === "contracts" &&
        kernelPeerContracts.has(`${modulePath}/${target}`)
        ? null
        : "GO_KERNEL_TO_MODULE";
    if (from.layer === "domain")
      return to.kind === "kernel" && to.layer === "domain"
        ? null
        : "GO_LAYER_DIRECTION";
    if (from.layer === "app")
      return to.kind === "kernel" && ["domain", "app"].includes(to.layer)
        ? null
        : "GO_LAYER_DIRECTION";
    return to.kind === "kernel" ? null : "GO_LAYER_DIRECTION";
  }
  if (from.kind === "generated")
    return to.kind === "generated" ? null : "GO_GENERATED_DEPENDENCY";
  if (from.kind === "cmd") return to.kind === "boot" ? null : "GO_CMD_NOT_THIN";
  if (from.kind === "transport")
    return ["module", "kernel", "ipc", "generated"].includes(to.kind) &&
      !(to.kind === "module" && to.layer === "infra") &&
      !(to.kind === "kernel" && to.layer === "infra")
      ? null
      : "GO_TRANSPORT_DEPENDENCY";
  if (from.kind === "ipc")
    return ["ipc", "generated"].includes(to.kind) ? null : "GO_IPC_DEPENDENCY";
  return null;
}

export function checkGoArchitecture(root) {
  root = path.resolve(root);
  const violations = [];
  const files = [];
  const excludedModules = [];
  const add = (code, file, detail) => violations.push({ code, file, detail });
  // Go packages under tests are test-only fixtures/harnesses, even when their
  // filenames do not end in _test.go. They are not production architecture.
  const skip = new Set([".git", "node_modules", "_output", "tests"]);
  function walk(directory, relative = "") {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (
        skip.has(name) ||
        [
          "tests/architecture/go-fixtures",
          "tests/architecture/fixtures",
        ].includes(name)
      )
        continue;
      const absolute = path.join(directory, entry.name);
      if (
        name === "resources/native/go" &&
        entry.isDirectory() &&
        fs.existsSync(path.join(absolute, "go.mod"))
      ) {
        excludedModules.push(name);
        continue;
      }
      if (entry.isSymbolicLink()) {
        add("GO_SYMLINK", name, "Source tree symlinks are not scanned");
        continue;
      }
      if (entry.isDirectory()) walk(absolute, name);
      else if (entry.name === "go.mod" && relative)
        add(
          "GO_NESTED_MODULE",
          name,
          "Only resources/native/go is an explicit transitional exclusion",
        );
      else if (entry.name.endsWith(".go")) files.push(name);
    }
  }
  walk(root);
  const production = files.filter((file) => !file.endsWith("_test.go"));
  const mod = path.join(root, "go.mod");
  if (fs.existsSync(mod)) {
    const source = fs.readFileSync(mod, "utf8").replace(/\/\/[^\n]*/gu, "");
    if (/^module[ \t]+"?([^"\s]+)"?[ \t]*$/mu.exec(source)?.[1] !== modulePath)
      add("GO_MODULE_IDENTITY", "go.mod", `Expected ${modulePath}`);
    if (!/^go[ \t]+1\.26\.2[ \t]*$/mu.test(source))
      add("GO_TOOLCHAIN", "go.mod", "Expected Go 1.26.2");
  } else if (production.length)
    add(
      "GO_MODULE_MISSING",
      "go.mod",
      "Root production Go requires the declared module",
    );
  const packages = new Set(production.map((file) => path.posix.dirname(file)));
  const graph = new Map(
    [...packages].map((directory) => [directory, new Set()]),
  );
  for (const file of files) {
    const directory = path.posix.dirname(file);
    const zone = classify(directory);
    const source = fs.readFileSync(path.join(root, file), "utf8");
    // Only this generator-owned surface may use protoc's .pb.go convention.
    const generated =
      zone.kind === "generated" &&
      /^\/\/ Code generated .* DO NOT EDIT\.$/mu.test(source);
    if (
      !(
        generated && /^[a-z][a-z0-9]*\.pb\.go$/u.test(path.posix.basename(file))
      ) &&
      !/^[a-z][a-z0-9]*(?:_test)?\.go$/u.test(path.posix.basename(file))
    )
      add(
        "GO_SHORT_NAME",
        file,
        "Use short joined lowercase names and only the _test suffix",
      );
    if (
      /^(?:utils|helpers|manager|info|record)(?:_test)?\.go$/u.test(
        path.posix.basename(file),
      )
    )
      add("GO_GENERIC_NAME", file, "Name the concrete responsibility");
    // Tests may use filesystem doubles; they never grant production exceptions.
    if (file.endsWith("_test.go")) continue;
    if (zone.kind === "unclassified")
      add(
        "GO_UNCLASSIFIED",
        file,
        "Production Go has no approved architecture owner",
      );
    let parsed;
    let dependencies;
    try {
      parsed = lex(source);
      dependencies = imports(parsed.tokens);
    } catch (error) {
      add("GO_PARSE", file, error.message);
      continue;
    }
    if (
      parsed.comments.some((comment) =>
        /^\/\/go:linkname(?:\s|$)/u.test(comment),
      )
    )
      add("GO_LINKNAME", file, "Linkname bypasses the import graph");
    if (pure(zone)) {
      for (let i = 0; i < parsed.tokens.length; i++) {
        const token = parsed.tokens[i];
        if (
          token.kind === "identifier" &&
          ["print", "println"].includes(token.value) &&
          parsed.tokens[i + 1]?.value === "(" &&
          parsed.tokens[i - 1]?.value !== "."
        )
          add(
            "GO_PURE_AMBIENT",
            file,
            `Builtin ${token.value} writes to ambient output`,
          );
        if (
          token.kind === "identifier" &&
          token.value === "Local" &&
          parsed.tokens[i - 1]?.value === "." &&
          parsed.tokens[i + 1]?.value === "("
        )
          add("GO_PURE_AMBIENT", file, "Local reads the ambient timezone");
      }
    }
    for (const { specifier, alias } of dependencies) {
      if (specifier === "plugin")
        add(
          "GO_DYNAMIC_LOADER",
          file,
          "Plugin loading bypasses static dependencies",
        );
      if (pure(zone)) {
        if (specifier === "unsafe" || specifier === "C")
          add("GO_PURE_ESCAPE", file, `Forbidden escape import ${specifier}`);
        if (alias === ".")
          add(
            "GO_PURE_DOT_IMPORT",
            file,
            "Dot imports obscure ambient selectors",
          );
        const selectors = pureSelectors.get(specifier);
        if (selectors)
          for (let i = 0; i < parsed.tokens.length - 2; i++) {
            if (
              parsed.tokens[i].kind === "identifier" &&
              parsed.tokens[i].value === alias &&
              parsed.tokens[i + 1].value === "." &&
              !selectors.has(parsed.tokens[i + 2].value) &&
              // Generated schema validators may parse wire timestamps. Domain
              // and application code must supply an explicit location instead.
              !(
                zone.kind === "generated" &&
                specifier === "time" &&
                parsed.tokens[i + 2].value === "Parse"
              )
            )
              add(
                "GO_PURE_AMBIENT",
                file,
                `Unapproved pure selector ${specifier}.${parsed.tokens[i + 2].value}`,
              );
          }
      }
      if (specifier.startsWith(`${modulePath}/`)) {
        const target = specifier.slice(modulePath.length + 1);
        if (!packages.has(target))
          add("GO_LOCAL_IMPORT", file, `Missing root package ${target}`);
        else graph.get(directory).add(target);
        const code = localRule(zone, classify(target), target, directory);
        if (code) add(code, file, specifier);
      } else if (
        pure(zone) &&
        !(
          pureStandard.has(specifier) ||
          (specifier === "context" && ["app", "contracts"].includes(zone.layer))
        )
      )
        add(
          "GO_PURE_IMPORT",
          file,
          `Not on the pure standard-library allowlist: ${specifier}`,
        );
      else if (zone.kind === "cmd" && !["os"].includes(specifier))
        add("GO_CMD_NOT_THIN", file, specifier);
    }
  }
  const active = new Set();
  const done = new Set();
  const stack = [];
  function visit(node) {
    if (active.has(node)) {
      add(
        "GO_CYCLE",
        node,
        [...stack.slice(stack.indexOf(node)), node].join(" -> "),
      );
      return;
    }
    if (done.has(node)) return;
    active.add(node);
    stack.push(node);
    for (const target of graph.get(node) ?? []) visit(target);
    stack.pop();
    active.delete(node);
    done.add(node);
  }
  for (const node of graph.keys()) visit(node);
  return {
    module: modulePath,
    go: "1.26.2",
    productionFiles: production.length,
    testFiles: files.length - production.length,
    excludedModules,
    violations,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    let root = process.cwd();
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--root" && args[i + 1]) root = args[++i];
      else if (args[i] !== "--json")
        throw new Error(`Unknown or incomplete option: ${args[i]}`);
    }
    const result = checkGoArchitecture(root);
    if (args.includes("--json"))
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const violation of result.violations)
        process.stdout.write(
          `${violation.code} ${violation.file}: ${violation.detail}\n`,
        );
      process.stdout.write(
        `Go architecture: ${result.productionFiles} production files checked; ${result.testFiles} test files named; excluded nested modules: ${result.excludedModules.join(", ") || "none"}.\n`,
      );
    }
    process.exitCode = result.violations.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`Go architecture check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
