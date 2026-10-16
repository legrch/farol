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
  // Exact pure Unicode APIs used by Computer; no x/text namespace wildcard.
  "golang.org/x/text/cases",
  "golang.org/x/text/collate",
  "golang.org/x/text/language",
  "golang.org/x/text/unicode/norm",
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

// ADR-0001 W0 rules are reports, separate from the existing blocking rules.
// A closed vocabulary makes package admission reviewable without word splitting.
const packageWords = new Set(
  `access account admission approval archive authority boot browse browser
  catalogue checkpoint claude client clock codex connector container control
  conversation desktop domain execution farol filesystem gate guard handoff id inference
  intent ipc journal lease lifecycle main migration mutation observation output
  parent policy port process provider release repo reservation resolver response
  result state stream task turn update workflow workspace`.split(/\s+/u),
);
const catchAllNames = new Set([
  "util",
  "utils",
  "common",
  "helper",
  "helpers",
  "types",
  "values",
  "misc",
  "manager",
]);
const reportCodes = new Set([
  "GO_PACKAGE_NAME",
  "GO_CATCH_ALL_NAME",
  "GO_CAPABILITY_DIRECTION",
  "GO_INFRA_SERVICE",
  "GO_DTO_ALIAS",
]);
const dtoPattern = /^(.*?)(Command|Query|Request|Response|Result|View)$/u;
const findingKey = (finding) =>
  JSON.stringify([finding.code, finding.file, finding.detail]);
const compareFinding = (a, b) =>
  findingKey(a) < findingKey(b) ? -1 : findingKey(a) > findingKey(b) ? 1 : 0;

function reportBaseline(root, findings) {
  const file = path.join(root, "tooling/go-architecture-baseline.json");
  const exists = fs.existsSync(file);
  const baseline = exists ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  if (
    exists &&
    (!baseline ||
      baseline.version !== 1 ||
      baseline.mode !== "report" ||
      !/^[a-f0-9]{40}$/u.test(baseline.source) ||
      !Array.isArray(baseline.findings))
  )
    throw new Error("Invalid Go architecture report baseline");
  const entries = new Map();
  for (const item of baseline?.findings ?? []) {
    if (
      !item ||
      !reportCodes.has(item.code) ||
      typeof item.file !== "string" ||
      !item.file ||
      path.posix.isAbsolute(item.file) ||
      /[\\*?]/u.test(item.file) ||
      item.file.split("/").some((part) => ["", ".", ".."].includes(part)) ||
      typeof item.detail !== "string" ||
      !item.detail ||
      Object.keys(item).sort().join(",") !== "code,detail,file" ||
      entries.has(findingKey(item))
    )
      throw new Error("Invalid or duplicate Go architecture baseline finding");
    entries.set(findingKey(item), item);
  }
  const current = new Map(findings.map((item) => [findingKey(item), item]));
  const sorted = [...current.values()].sort(compareFinding);
  return {
    findings: sorted.map((item) => ({
      ...item,
      baseline: entries.has(findingKey(item)) ? "existing" : "new",
    })),
    baseline: {
      source: baseline?.source ?? null,
      unbaselined: sorted.filter((item) => !entries.has(findingKey(item))),
      stale: [...entries.values()]
        .filter((item) => !current.has(findingKey(item)))
        .sort(compareFinding),
    },
  };
}

function nameReports(file, tokens, report) {
  const directory = path.posix.dirname(file);
  const leaf = path.posix.basename(directory);
  const clause = tokens.findIndex(
    (token) => token.kind === "identifier" && token.value === "package",
  );
  const declared = clause >= 0 ? tokens[clause + 1]?.value : undefined;
  for (const name of new Set([leaf, declared].filter(Boolean))) {
    if (catchAllNames.has(name))
      report("GO_CATCH_ALL_NAME", directory, `Catch-all package name: ${name}`);
    else if (!packageWords.has(name))
      report(
        "GO_PACKAGE_NAME",
        directory,
        `Package token outside the explicit ADR-0001 vocabulary: ${name}`,
      );
  }
  const stem = path.posix.basename(file, ".go");
  if (catchAllNames.has(stem))
    report(
      "GO_CATCH_ALL_NAME",
      file,
      `Catch-all production file name: ${stem}`,
    );
}

function dependencyReports(from, to, specifier, file, report) {
  if (from.layer === "app" && from.capability && to.service)
    report("GO_CAPABILITY_DIRECTION", file, specifier);
  if (from.layer === "infra" && to.service)
    report("GO_INFRA_SERVICE", file, specifier);
}

// Inspect type declarations, including grouped and generic aliases. The lexer
// removes comments/literals. Bracket/brace depth excludes nested struct fields
// and function-local declarations; no Go type checking or alias-chain resolution.
function aliasReports(file, tokens, dependencies, report) {
  const directory = path.posix.dirname(file);
  const imported = new Map(
    dependencies.map(({ alias, specifier }) => [alias, specifier]),
  );
  function inspect(index) {
    const left = tokens[index];
    if (left?.kind !== "identifier") return;
    let next = index + 1;
    if (tokens[next]?.value === "[") {
      let depth = 0;
      do {
        if (tokens[next]?.value === "[") depth++;
        if (tokens[next]?.value === "]") depth--;
        next++;
      } while (next < tokens.length && depth);
    }
    if (tokens[next]?.value !== "=") return;
    const right = tokens[next + 1];
    if (right?.kind !== "identifier") return;
    const qualified = tokens[next + 2]?.value === ".";
    const rightName = qualified ? tokens[next + 3]?.value : right.value;
    const leftDTO = dtoPattern.exec(left.value);
    const rightDTO = dtoPattern.exec(rightName ?? "");
    if (!leftDTO || !rightDTO) return;
    const specifier = qualified ? imported.get(right.value) : null;
    const target = specifier?.startsWith(`${modulePath}/`)
      ? specifier.slice(modulePath.length + 1)
      : null;
    // A local import is a different package owner, even within the same layer
    // or when operation prefixes match. Explicit mapping keeps that boundary.
    const crossOwner = target && target !== directory;
    if (leftDTO[1] !== rightDTO[1] || crossOwner)
      report(
        "GO_DTO_ALIAS",
        file,
        `DTO alias ${left.value} = ${qualified ? `${right.value}.` : ""}${rightName}`,
      );
  }
  let braces = 0;
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i].value;
    if (value === "{") braces++;
    if (value === "}") braces--;
    if (braces || value !== "type" || tokens[i].kind !== "identifier") continue;
    if (tokens[i + 1]?.value !== "(") inspect(i + 1);
    else {
      let parens = 1,
        brackets = 0,
        nestedBraces = 0;
      for (let j = i + 2; j < tokens.length && parens; j++) {
        const part = tokens[j].value;
        if (parens === 1 && !brackets && !nestedBraces) inspect(j);
        if (part === "(") parens++;
        if (part === ")") parens--;
        if (part === "[") brackets++;
        if (part === "]") brackets--;
        if (part === "{") nestedBraces++;
        if (part === "}") nestedBraces--;
      }
    }
  }
}

function classify(directory) {
  const parts = directory.split("/");
  if (directory === "cmd/farol") return { kind: "cmd" };
  // Fixed development launcher utility; it has no application-module access.
  if (directory === "cmd/faroldevcontrol") return { kind: "devtool" };
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
      capability: parts[2] === "app" && parts[3] === "capabilities",
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
  if (from.kind === "devtool") return "GO_DEV_TOOL_DEPENDENCY";
  if (from.kind === "transport")
    return ["module", "kernel", "ipc", "generated"].includes(to.kind) &&
      !(to.kind === "module" && to.layer !== "contracts") &&
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
  const reports = [];
  const report = (code, file, detail) => reports.push({ code, file, detail });
  const files = [];
  const excludedModules = [];
  const add = (code, file, detail) => violations.push({ code, file, detail });
  // Go packages under tests are test-only fixtures/harnesses, even when their
  // filenames do not end in _test.go. They are not production architecture.
  // Root dist preserves historical generated output; nested source dist stays scanned.
  const skip = new Set([".git", "node_modules", "_output", "dist", "tests"]);
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
    if (zone.kind !== "generated") {
      nameReports(file, parsed.tokens, report);
      aliasReports(file, parsed.tokens, dependencies, report);
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
        dependencyReports(zone, classify(target), specifier, file, report);
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
    report: { mode: "report", ...reportBaseline(root, reports) },
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
      for (const finding of result.report.findings)
        process.stdout.write(
          `REPORT ${finding.baseline} ${finding.code} ${finding.file}: ${finding.detail}\n`,
        );
      for (const finding of result.report.baseline.stale)
        process.stdout.write(
          `REPORT stale ${finding.code} ${finding.file}: ${finding.detail}\n`,
        );
      process.stdout.write(
        `ADR-0001 report mode: ${result.report.findings.length} findings; ${result.report.baseline.unbaselined.length} new; ${result.report.baseline.stale.length} stale exceptions.\n`,
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
