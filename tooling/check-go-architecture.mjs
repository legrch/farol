#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
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
  "crypto/sha256",
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
  // Fixed-input SHA-256 has no ambient entropy, IO or clock access.
  ["crypto/sha256", new Set(["Sum256"])],
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

// ADR-0002: one closed vocabulary admits package AND file names. It is an
// admission list, not a dictionary or word splitter; add a word only in review.
// The first block is ADR-0001's list; later blocks name the ADR-0002 request.
const words = new Set(
  `access account admission approval archive authority boot browse browser
  catalogue checkpoint claude client clock codex connector container control
  conversation desktop domain egress execution farol filesystem gate git guard handoff id inference
  intent ipc journal lease lifecycle main migration mutation observation output
  parent policy port process provider rejection release repo reservation resolver response
  result state stream task turn update workflow workspace
  budget credential history model openai peer plan progress recovery settings sse thread
  audit channel check clone connection dev document identity input inspect lock
  machine move probe protocol route scratch slot stop tree wait
  activation chat cli computer delegation install ledger publication read relay
  retirement session
  descriptor digest exchange failure fake fence limit profile root
  contract doc server service unsupported`
    .trim()
    .split(/\s+/u),
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
  "info",
  "record",
  "base",
  "impl",
]);
// Go applies these file-name constraints itself (go/build goodOSArchFile with
// internal/syslist at Go 1.27.3). "unix" is a build tag, never a file suffix.
const toolchainOS = new Set(
  `aix android darwin dragonfly freebsd hurd illumos ios js linux nacl netbsd
  openbsd plan9 solaris wasip1 windows zos`
    .trim()
    .split(/\s+/u),
);
const toolchainArch = new Set(
  `386 amd64 amd64p32 arm armbe arm64 arm64be loong64 mips mipsle mips64
  mips64le mips64p32 mips64p32le ppc ppc64 ppc64le riscv riscv64 s390 s390x
  sparc sparc64 wasm`
    .trim()
    .split(/\s+/u),
);
// Migration rules report everywhere and block only in migrated scopes listed
// in the enforcement file. Every other rule in this checker always blocks.
const migrationCodes = [
  "GO_PACKAGE_NAME",
  "GO_PACKAGE_DIR",
  "GO_FILE_WORD",
  "GO_CATCH_ALL_NAME",
  "GO_TEST_ORPHAN",
  "GO_TEST_MISSING",
  "GO_BOOT_TEST",
  "GO_BOOT_FILE",
  "GO_BOOT_LOGIC",
  "GO_OPERATION_SHAPE",
  "GO_CAPABILITY_DIRECTION",
  "GO_INFRA_SERVICE",
  "GO_DTO_ALIAS",
];
const scopes = [
  "boot",
  "chat",
  "cmd",
  "computer",
  "gen",
  "pkg",
  "release",
  "task",
  "transport",
];
const enforcementFile = "tooling/go-architecture-enforcement.json";
const bootFiles = new Set(["boot", ...modules]);
const bootLineBudget = 400;
// ADR-0001 session protocols keep role-style methods. Exempt exact service
// package paths only by owner decision; none is listed yet.
const sessionPackages = new Set([]);
const dtoPattern = /^(.*?)(Command|Query|Request|Response|Result|View)$/u;
const findingKey = (finding) =>
  JSON.stringify([finding.code, finding.file, finding.detail]);
const compareFinding = (a, b) =>
  findingKey(a) < findingKey(b) ? -1 : findingKey(a) > findingKey(b) ? 1 : 0;
const scopeOf = (file) => {
  const parts = file.split("/");
  return parts[0] === "modules" && parts[1] ? parts[1] : parts[0];
};
const safePath = (file) =>
  typeof file === "string" &&
  file !== "" &&
  !path.posix.isAbsolute(file) &&
  !/[\\*?]/u.test(file) &&
  !file.split("/").some((part) => ["", ".", ".."].includes(part));

function readEnforcement(root) {
  const file = path.join(root, enforcementFile);
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const invalid = (reason) => {
    throw new Error(`Invalid Go architecture enforcement: ${reason}`);
  };
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).sort().join(",") !==
      "ceilings,exceptions,migrated,source,version" ||
    data.version !== 2 ||
    !/^[a-f0-9]{40}$/u.test(data.source)
  )
    invalid("envelope");
  const migrated = new Map();
  for (const code of migrationCodes) {
    const list = data.migrated?.[code];
    if (
      !Array.isArray(list) ||
      list.some((scope) => !scopes.includes(scope)) ||
      list.join() !== [...new Set(list)].sort().join()
    )
      invalid(`migrated ${code}`);
    migrated.set(code, new Set(list));
  }
  if (Object.keys(data.migrated).length !== migrationCodes.length)
    invalid("unknown migrated rule");
  const ceilings = new Map();
  if (
    !data.ceilings ||
    typeof data.ceilings !== "object" ||
    Object.keys(data.ceilings).some((code) => !migrationCodes.includes(code))
  )
    invalid("ceilings");
  for (const [code, counts] of Object.entries(data.ceilings)) {
    if (!counts || typeof counts !== "object" || Array.isArray(counts))
      invalid(`ceilings ${code}`);
    for (const [scope, count] of Object.entries(counts))
      if (
        !/^[a-z][a-z0-9]*$/u.test(scope) ||
        !Number.isSafeInteger(count) ||
        count < 1
      )
        invalid(`ceiling ${code} ${scope}`);
    ceilings.set(code, new Map(Object.entries(counts)));
  }
  const exceptions = new Map();
  if (!Array.isArray(data.exceptions)) invalid("exceptions");
  for (const item of data.exceptions) {
    if (
      !item ||
      Object.keys(item).sort().join(",") !==
        "code,detail,file,reason,removal" ||
      !migrationCodes.includes(item.code) ||
      !safePath(item.file) ||
      typeof item.detail !== "string" ||
      !item.detail ||
      typeof item.reason !== "string" ||
      !item.reason.trim() ||
      typeof item.removal !== "string" ||
      !item.removal.trim() ||
      exceptions.has(findingKey(item))
    )
      invalid("exception row");
    exceptions.set(findingKey(item), item);
  }
  return { source: data.source, migrated, ceilings, exceptions };
}

// Split migration findings by the enforcement switch. A migrated scope blocks
// a rule except for exact, reasoned exception rows; report scopes may not grow
// past their declared ceiling. Without the file every finding is a report.
function enforce(root, findings, add) {
  const enforcement = readEnforcement(root);
  const unique = [
    ...new Map(findings.map((item) => [findingKey(item), item])).values(),
  ]
    .sort(compareFinding)
    .map((item) => ({ ...item, scope: scopeOf(item.file) }));
  const reported = [];
  const excepted = [];
  const counts = {};
  const used = new Set();
  for (const item of unique) {
    const migrated = enforcement?.migrated.get(item.code)?.has(item.scope);
    const exception = migrated && enforcement.exceptions.get(findingKey(item));
    if (exception) {
      used.add(findingKey(item));
      excepted.push({
        ...item,
        reason: exception.reason,
        removal: exception.removal,
      });
      continue;
    }
    counts[item.code] ??= {};
    counts[item.code][item.scope] = (counts[item.code][item.scope] ?? 0) + 1;
    if (migrated) add(item.code, item.file, item.detail);
    else reported.push(item);
  }
  if (enforcement) {
    for (const [key, item] of enforcement.exceptions)
      if (!used.has(key))
        add(
          "GO_EXCEPTION_STALE",
          enforcementFile,
          `${item.code} ${item.file}: ${item.detail}`,
        );
    // Ceilings are exact: growth fails, and so does unused slack, so a fix
    // in one place cannot pay for a new finding elsewhere in the scope.
    for (const [code, byScope] of Object.entries(counts))
      for (const [scope, count] of Object.entries(byScope)) {
        if (enforcement.migrated.get(code).has(scope)) continue;
        const ceiling = enforcement.ceilings.get(code)?.get(scope) ?? 0;
        if (count > ceiling)
          add(
            "GO_REPORT_CEILING",
            enforcementFile,
            `${code} ${scope}: ${count} findings exceed the ceiling ${ceiling}; fix the new findings`,
          );
      }
    for (const [code, byScope] of enforcement.ceilings)
      for (const [scope, ceiling] of byScope) {
        const count = enforcement.migrated.get(code).has(scope)
          ? 0
          : (counts[code]?.[scope] ?? 0);
        if (count < ceiling)
          add(
            "GO_CEILING_STALE",
            enforcementFile,
            count
              ? `${code} ${scope}: ${count} findings are below the ceiling ${ceiling}; lower the ceiling to ${count} in this change`
              : `${code} ${scope}: no report findings remain under the ceiling ${ceiling}; delete the ceiling in this change`,
          );
      }
  }
  return {
    mode: "report",
    source: enforcement?.source ?? null,
    migrated: Object.fromEntries(
      migrationCodes.map((code) => [
        code,
        [...(enforcement?.migrated.get(code) ?? [])],
      ]),
    ),
    findings: reported,
    excepted,
    counts,
  };
}

// Parse stem(_goos)?(_goarch)?(_test)?.go exactly as the Go toolchain reads
// suffixes. Any other underscore makes the name invalid (null).
function goFileName(base) {
  if (!base.endsWith(".go")) return null;
  const parts = base.slice(0, -3).split("_");
  const test = parts.length > 1 && parts.at(-1) === "test";
  if (test) parts.pop();
  const stem = parts.shift();
  if (!/^[a-z][a-z0-9]*$/u.test(stem)) return null;
  const [first, second] = parts;
  const valid =
    parts.length === 0 ||
    (parts.length === 1 &&
      (toolchainOS.has(first) || toolchainArch.has(first))) ||
    (parts.length === 2 && toolchainOS.has(first) && toolchainArch.has(second));
  if (!valid) return null;
  return { stem, platform: parts.join("_"), test };
}

function nameReports(file, zone, tokens, report) {
  const directory = path.posix.dirname(file);
  const leaf = path.posix.basename(directory);
  const clause = tokens.findIndex(
    (token) => token.kind === "identifier" && token.value === "package",
  );
  const declared = clause >= 0 ? tokens[clause + 1]?.value : undefined;
  for (const name of new Set([leaf, declared].filter(Boolean))) {
    if (catchAllNames.has(name))
      report("GO_CATCH_ALL_NAME", directory, `Catch-all package name: ${name}`);
    else if (!words.has(name))
      report(
        "GO_PACKAGE_NAME",
        directory,
        `Package name outside the admitted vocabulary: ${name}`,
      );
  }
  const expected = ["cmd", "devtool"].includes(zone.kind) ? "main" : leaf;
  if (declared && declared !== expected)
    report(
      "GO_PACKAGE_DIR",
      directory,
      `Package clause ${declared} must equal ${expected}`,
    );
  const stem = goFileName(path.posix.basename(file))?.stem;
  if (!stem) return;
  if (catchAllNames.has(stem))
    report(
      "GO_CATCH_ALL_NAME",
      file,
      `Catch-all production file name: ${stem}`,
    );
  else if (!words.has(stem))
    report(
      "GO_FILE_WORD",
      file,
      `File name outside the admitted vocabulary: ${stem}`,
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
    // ADR-0002 admits pkg/kernel/domain/<word>, pkg/kernel/app/port/<topic>
    // and pkg/kernel/infra/peer only; other kernel paths keep their layer
    // for import checks and fail GO_KERNEL_LAYOUT.
    const layout =
      (parts[2] === "domain" && parts.length === 4) ||
      (parts[2] === "app" && parts[3] === "port" && parts.length === 5) ||
      (parts[2] === "infra" && parts[3] === "peer" && parts.length === 4);
    return {
      kind: "kernel",
      layer: parts[2],
      peer: parts[3] === "peer",
      layout,
    };
  }
  // A flat infrastructure kit is one admitted, non-catch-all word.
  if (
    parts[0] === "pkg" &&
    parts.length === 2 &&
    !["ipc", "kernel"].includes(parts[1]) &&
    words.has(parts[1]) &&
    !catchAllNames.has(parts[1])
  )
    return { kind: "kit", name: parts[1] };
  if (
    parts[0] === "modules" &&
    modules.has(parts[1]) &&
    ["domain", "app", "contracts", "infra", "desktop"].includes(parts[2])
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
// Each token records its starting line for Go's semicolon-insertion rule.
function lex(source) {
  const tokens = [];
  const comments = [];
  let i = 0;
  let line = 1;
  const move = (end) => {
    for (let k = i; k < end; k++) if (source.charCodeAt(k) === 10) line++;
    i = end;
  };
  while (i < source.length) {
    const start = i;
    const char = source[i];
    if (/\s/u.test(char)) {
      move(i + 1);
      continue;
    }
    if (source.startsWith("//", i) || source.startsWith("/*", i)) {
      const single = source.startsWith("//", i);
      const end = single
        ? source.indexOf("\n", i + 2)
        : source.indexOf("*/", i + 2);
      if (end === -1 && !single) throw new Error("Unterminated Go comment");
      const stop = end === -1 ? source.length : end + (single ? 0 : 2);
      comments.push(source.slice(start, stop));
      move(stop);
    } else if (['"', "`", "'"].includes(char)) {
      let j = i + 1;
      while (j < source.length && source[j] !== char) {
        if (char !== "`" && source[j] === "\\") j++;
        j++;
      }
      if (j >= source.length) throw new Error("Unterminated Go literal");
      j++;
      tokens.push({
        kind: char === "'" ? "rune" : "string",
        value: source.slice(start, j),
        line,
      });
      move(j);
    } else if (/[\p{L}_]/u.test(char)) {
      i++;
      while (i < source.length && /[\p{L}\p{N}_]/u.test(source[i])) i++;
      tokens.push({ kind: "identifier", value: source.slice(start, i), line });
    } else {
      tokens.push({ kind: "punctuation", value: char, line });
      i++;
    }
  }
  return { tokens, comments };
}

// Lexical statement structure for ADR-0002 shape rules. This is not a Go
// parser: it implements the spec's semicolon insertion over the token stream
// (digits lex as one-character punctuation) and assumes gofmt-able source.
const goKeywords = new Set(
  `break case chan const continue default defer else fallthrough for func go
  goto if import interface map package range return select struct switch type
  var`
    .trim()
    .split(/\s+/u),
);
const openers = new Set(["(", "[", "{"]);
const closers = new Set([")", "]", "}"]);

function endsStatement(tokens, k) {
  const token = tokens[k];
  if (!token) return false;
  if (token.kind === "string" || token.kind === "rune") return true;
  if (token.kind === "identifier")
    return (
      !goKeywords.has(token.value) ||
      ["break", "continue", "fallthrough", "return"].includes(token.value)
    );
  if (closers.has(token.value) || /^[0-9]$/u.test(token.value)) return true;
  return (
    ["+", "-"].includes(token.value) && tokens[k - 1]?.value === token.value
  );
}

// A statement boundary lies between tokens k-1 and k.
function boundary(tokens, k) {
  return (
    k === 0 ||
    (tokens[k - 1].kind === "punctuation" && tokens[k - 1].value === ";") ||
    (tokens[k].line > tokens[k - 1].line && endsStatement(tokens, k - 1))
  );
}

function closing(tokens, k) {
  let depth = 0;
  for (let j = k; j < tokens.length; j++) {
    if (tokens[j].kind !== "punctuation") continue;
    if (openers.has(tokens[j].value)) depth++;
    else if (closers.has(tokens[j].value) && !--depth) return j;
  }
  return tokens.length;
}

// After a parameter list: skip the result type; return the body brace index
// (-1 when the signature ends without a body) and the next token index.
function signature(tokens, k) {
  for (let j = k; j < tokens.length; j++) {
    const token = tokens[j];
    if (boundary(tokens, j)) return { body: -1, next: j };
    if (token.kind !== "punctuation") continue;
    if (token.value === "{") {
      if (["struct", "interface"].includes(tokens[j - 1]?.value)) {
        j = closing(tokens, j);
        continue;
      }
      return { body: j, next: closing(tokens, j) + 1 };
    }
    if (token.value === "(" || token.value === "[") j = closing(tokens, j);
    else if ([")", "]", "}", ",", "="].includes(token.value))
      return { body: -1, next: j };
  }
  return { body: -1, next: tokens.length };
}

// Top-level function and method declarations, plus whether any function
// literal with a body appears outside them. A function type followed by a
// composite literal on the same line reads as a literal (conservative).
function declarations(tokens) {
  const functions = [];
  let literal = false;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "punctuation") {
      if (openers.has(token.value)) depth++;
      else if (closers.has(token.value)) depth--;
      continue;
    }
    if (token.kind !== "identifier" || token.value !== "func") continue;
    if (!depth && boundary(tokens, i)) {
      let j = i + 1;
      let receiver = null;
      if (tokens[j]?.value === "(") {
        const end = closing(tokens, j);
        receiver = [j + 1, end];
        j = end + 1;
      }
      const name = tokens[j]?.kind === "identifier" ? tokens[j].value : "";
      j++;
      if (tokens[j]?.value === "[") j = closing(tokens, j) + 1;
      if (tokens[j]?.value !== "(") continue;
      const close = closing(tokens, j);
      const sig = signature(tokens, close + 1);
      functions.push({
        name,
        receiver,
        params: [j + 1, close],
        results: [close + 1, sig.body === -1 ? sig.next : sig.body],
        body: sig.body === -1 ? null : [sig.body + 1, sig.next - 1],
      });
      i = sig.next - 1;
      continue;
    }
    if (tokens[i + 1]?.value !== "(") continue;
    if (signature(tokens, closing(tokens, i + 1) + 1).body !== -1)
      literal = true;
  }
  return { functions, literal };
}

// ADR-0002 declaration-only predicate: a function counts as behavior unless
// it has no body, or it is a constructor (New, New<Upper>...) or a String,
// Error, GoString or Unwrap method whose body is exactly one return statement
// with no function literal.
function trivial(tokens, fn) {
  if (!fn.body) return true;
  const named = fn.receiver
    ? ["String", "Error", "GoString", "Unwrap"].includes(fn.name)
    : /^New(?:\p{Lu}|$)/u.test(fn.name);
  const [start, end] = fn.body;
  if (!named || tokens[start]?.value !== "return") return false;
  let depth = 0;
  for (let k = start; k < end; k++) {
    const token = tokens[k];
    if (k > start && !depth && boundary(tokens, k)) return false;
    if (token.kind === "identifier" && token.value === "func") return false;
    if (token.kind !== "punctuation") continue;
    if (openers.has(token.value)) depth++;
    else if (closers.has(token.value)) depth--;
  }
  return true;
}

function hasBehavior(tokens, parsed) {
  return parsed.literal || parsed.functions.some((fn) => !trivial(tokens, fn));
}

// Names of top-level type specs, including every spec of a grouped type.
function typeSpecs(tokens) {
  const names = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "punctuation") {
      if (openers.has(token.value)) depth++;
      else if (closers.has(token.value)) depth--;
      continue;
    }
    if (depth || token.kind !== "identifier" || token.value !== "type")
      continue;
    if (tokens[i + 1]?.value !== "(") {
      if (tokens[i + 1]?.kind === "identifier") names.push(tokens[i + 1].value);
      continue;
    }
    const end = closing(tokens, i + 1);
    let inner = 0;
    for (let j = i + 2; j < end; j++) {
      const part = tokens[j];
      if (part.kind === "punctuation") {
        if (openers.has(part.value)) inner++;
        else if (closers.has(part.value)) inner--;
        continue;
      }
      if (
        !inner &&
        part.kind === "identifier" &&
        (j === i + 2 || boundary(tokens, j))
      )
        names.push(part.value);
    }
    i = end;
  }
  return names;
}

// The whole if header must be `err != nil`, optionally after one init
// statement that only assigns (`v, err := f(x)`) and holds no && or ||.
function errorCheck(header) {
  const values = header.map(({ value }) => value);
  let split = -1;
  for (let k = 0, depth = 0; k < header.length; k++) {
    if (header[k].kind !== "punctuation") continue;
    if (openers.has(values[k])) depth++;
    else if (closers.has(values[k])) depth--;
    else if (values[k] === ";" && !depth) {
      if (split !== -1) return false;
      split = k;
    }
  }
  if (values.slice(split + 1).join(" ") !== "err ! = nil") return false;
  if (split === -1) return true;
  const init = values.slice(0, split).join(" ");
  return (
    /^[\p{L}_][\p{L}\p{N}_]*(?: , [\p{L}_][\p{L}\p{N}_]*)* : = /u.test(init) &&
    !/& &|\| \|/u.test(init)
  );
}

// Boot composes; it decides nothing. Report each kind of logic per file.
function bootReports(file, source, tokens, report) {
  const counts = new Map();
  const count = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== "identifier") continue;
    if (["switch", "for", "select", "go"].includes(token.value))
      count(`${token.value} statements`);
    if (token.value !== "if") continue;
    let j = i + 1;
    for (let depth = 0; j < tokens.length; j++) {
      const value = tokens[j].kind === "punctuation" ? tokens[j].value : "";
      if (value === "(" || value === "[") depth++;
      else if (value === ")" || value === "]") depth--;
      else if (value === "{" && !depth) break;
    }
    if (!errorCheck(tokens.slice(i + 1, j)))
      count("conditions other than err != nil");
  }
  for (const [kind, total] of [...counts].sort())
    report("GO_BOOT_LOGIC", file, `${kind}: ${total}`);
  const types = typeSpecs(tokens).length;
  if (types > 1)
    report(
      "GO_BOOT_LOGIC",
      file,
      `top-level types: ${types}; at most one namespace type`,
    );
  const lines = source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  if (lines > bootLineBudget)
    report("GO_BOOT_LOGIC", file, `lines: ${lines}; budget ${bootLineBudget}`);
}

function receiverType(tokens, [start, end]) {
  const ids = [];
  for (let k = start; k < end; k++) {
    if (tokens[k].value === "[") k = closing(tokens, k);
    else if (tokens[k].kind === "identifier") ids.push(tokens[k].value);
  }
  return ids.at(-1);
}

function splitList(tokens, [start, end]) {
  const groups = [[]];
  let depth = 0;
  for (let k = start; k < end; k++) {
    const value = tokens[k].value;
    if (tokens[k].kind === "punctuation") {
      if (openers.has(value)) depth++;
      else if (closers.has(value)) depth--;
      else if (value === "," && !depth) {
        groups.push([]);
        continue;
      }
    }
    groups.at(-1).push(value);
  }
  return groups.filter((group) => group.length);
}

// ADR-0002 operation shape: application services take Command or Query and
// return Result; contracts and the wire keep Request and Response.
function operationReports(file, zone, tokens, parsed, report) {
  const directory = path.posix.dirname(file);
  if (zone.service && !sessionPackages.has(directory))
    for (const fn of parsed.functions) {
      if (!fn.receiver || !/^\p{Lu}/u.test(fn.name)) continue;
      if (receiverType(tokens, fn.receiver) !== "Service") continue;
      const params = splitList(tokens, fn.params);
      const input = params[1] ?? [];
      const results = tokens
        .slice(...fn.results)
        .map(({ value }) => value)
        .join(" ");
      const valid =
        params.length === 2 &&
        params[0].length <= 4 &&
        params[0].slice(-3).join("") === "context.Context" &&
        input.length <= 2 &&
        [`${fn.name}Command`, `${fn.name}Query`].includes(input.at(-1)) &&
        results === `( * ${fn.name}Result , error )`;
      if (!valid)
        report(
          "GO_OPERATION_SHAPE",
          file,
          `Service.${fn.name} must take (context.Context, ${fn.name}Command or ${fn.name}Query) and return (*${fn.name}Result, error)`,
        );
    }
  for (const name of typeSpecs(tokens)) {
    if (!/^\p{Lu}/u.test(name)) continue;
    if (zone.service && /(?:Request|Response)$/u.test(name))
      report(
        "GO_OPERATION_SHAPE",
        file,
        `Application type ${name} uses a wire suffix; use Command, Query or Result`,
      );
    if (zone.layer === "contracts" && /(?:Command|Query)$/u.test(name))
      report(
        "GO_OPERATION_SHAPE",
        file,
        `Contract type ${name} uses an application suffix; use Request or Response`,
      );
  }
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
    if (from.layer === "desktop")
      return (to.kind === "module" &&
        ["contracts", "app", "domain", "desktop"].includes(to.layer)) ||
        (to.kind === "kernel" && ["domain", "app"].includes(to.layer)) ||
        ["kit", "ipc", "generated", "transport"].includes(to.kind)
        ? null
        : "GO_DESKTOP_DEPENDENCY";
    // Infrastructure may use stateless kits but never the inbound adapter.
    return ["module", "kernel", "ipc", "generated", "kit"].includes(to.kind) &&
      !(to.kind === "module" && to.layer === "desktop")
      ? null
      : "GO_LAYER_DIRECTION";
  }
  if (from.kind === "kit")
    return (to.kind === "kernel" && ["domain", "app"].includes(to.layer)) ||
      ["kit", "ipc"].includes(to.kind)
      ? null
      : "GO_KIT_DEPENDENCY";
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
    return ["module", "kernel", "ipc", "generated", "kit"].includes(to.kind) &&
      !(to.kind === "module" && to.layer !== "contracts") &&
      !(to.kind === "kernel" && to.layer === "infra")
      ? null
      : "GO_TRANSPORT_DEPENDENCY";
  if (from.kind === "ipc")
    return ["ipc", "generated"].includes(to.kind) ? null : "GO_IPC_DEPENDENCY";
  return null;
}

// ADR-0002 file structure: x.go pairs with at most x_test.go (platform
// suffixes included), <package>_test.go is the only unpaired test, files with
// behavior outside boot, cmd and gen have their test, and boot holds boot.go
// plus one file per module with no tests or test data.
function structureReports(files, bootTestdata, behavior, clauses, report) {
  const directories = new Map();
  for (const file of files) {
    const name = goFileName(path.posix.basename(file));
    if (!name) continue;
    const directory = path.posix.dirname(file);
    if (!directories.has(directory))
      directories.set(directory, { sources: new Map(), tests: [] });
    const entry = directories.get(directory);
    const key = name.platform ? `${name.stem}_${name.platform}` : name.stem;
    if (name.test) entry.tests.push({ file, key, name });
    else entry.sources.set(key, file);
  }
  const bootSet = [...bootFiles].sort().map((stem) => `${stem}.go`);
  for (const [directory, entry] of directories) {
    const zone = classify(directory);
    if (zone.kind === "boot") {
      for (const { file } of entry.tests)
        report(
          "GO_BOOT_TEST",
          file,
          "Boot has no tests; whole-graph tests live under tests/",
        );
      for (const [key, file] of entry.sources)
        if (directory !== "boot")
          report("GO_BOOT_FILE", file, "Boot has no subpackages");
        else if (!bootFiles.has(key))
          report("GO_BOOT_FILE", file, `Boot holds only ${bootSet.join(", ")}`);
      continue;
    }
    const packageNames = new Set([
      path.posix.basename(directory),
      ...(clauses.get(directory) ?? []),
    ]);
    for (const { file, key, name } of entry.tests)
      if (
        !entry.sources.has(key) &&
        !(name.platform === "" && packageNames.has(name.stem))
      )
        report("GO_TEST_ORPHAN", file, `No ${key}.go beside this test`);
    if (["cmd", "gen"].includes(scopeOf(directory))) continue;
    const tested = new Set(entry.tests.map(({ key }) => key));
    for (const [key, file] of entry.sources)
      if (behavior.get(file) && !tested.has(key))
        report("GO_TEST_MISSING", file, `Behavior without ${key}_test.go`);
  }
  for (const directory of bootTestdata)
    report("GO_BOOT_TEST", directory, "Boot has no test data");
}

// A registered, ignored child checkout is another source owner, not this Go
// module. Never infer that boundary from a directory name or a .git file alone.
function registeredChildWorktrees(root) {
  if (!fs.existsSync(path.join(root, ".git"))) return new Set();
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error || result.status !== 0)
      throw Error("Git source boundary unavailable");
    return result.stdout;
  };
  const physicalRoot = fs.realpathSync(root);
  if (
    fs.realpathSync(git("rev-parse", "--show-toplevel").trim()) !== physicalRoot
  )
    throw Error("Git source root mismatch");
  const children = new Set();
  for (const field of git("worktree", "list", "--porcelain", "-z").split(
    "\0",
  )) {
    if (!field.startsWith("worktree ")) continue;
    const candidate = field.slice(9);
    const relative = path.relative(physicalRoot, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      continue;
    if (!fs.existsSync(candidate) || fs.realpathSync(candidate) !== candidate)
      continue;
    const ignored = spawnSync(
      "git",
      ["-C", root, "check-ignore", "--quiet", "--", relative],
      {
        timeout: 5000,
      },
    );
    if (ignored.error || ![0, 1].includes(ignored.status))
      throw Error("Git ignore boundary unavailable");
    if (ignored.status === 0 && git("ls-files", "-z", "--", relative) === "")
      children.add(relative.split(path.sep).join("/"));
  }
  return children;
}

export function checkGoArchitecture(root) {
  root = path.resolve(root);
  const violations = [];
  const reports = [];
  const report = (code, file, detail) => reports.push({ code, file, detail });
  const files = [];
  const bootTestdata = [];
  const excludedModules = [];
  const add = (code, file, detail) => violations.push({ code, file, detail });
  // Go packages under tests are test-only fixtures/harnesses, even when their
  // filenames do not end in _test.go. They are not production architecture.
  // Root dist preserves historical generated output; nested source dist stays scanned.
  const skip = new Set([".git", "node_modules", "_output", "dist", "tests"]);
  let childWorktrees = new Set();
  try {
    childWorktrees = registeredChildWorktrees(root);
  } catch {
    add(
      "GO_WORKTREE_BOUNDARY_UNAVAILABLE",
      ".git",
      "Cannot establish registered source ownership",
    );
  }
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
      if (entry.isDirectory() && childWorktrees.has(name)) continue;
      if (
        entry.isDirectory() &&
        entry.name === "testdata" &&
        name.startsWith("boot/")
      )
        bootTestdata.push(name);
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
    if (!/^go[ \t]+1\.27\.3[ \t]*$/mu.test(source))
      add("GO_TOOLCHAIN", "go.mod", "Expected Go 1.27.3");
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
  const behavior = new Map();
  const clauses = new Map();
  for (const file of files) {
    const directory = path.posix.dirname(file);
    const zone = classify(directory);
    const source = fs.readFileSync(path.join(root, file), "utf8");
    // Only this generator-owned surface may use protoc's .pb.go convention.
    const generated =
      zone.kind === "generated" &&
      /^\/\/ Code generated .* DO NOT EDIT\.$/mu.test(source);
    const name = goFileName(path.posix.basename(file));
    if (
      !(
        generated && /^[a-z][a-z0-9]*\.pb\.go$/u.test(path.posix.basename(file))
      ) &&
      !name
    )
      add(
        "GO_SHORT_NAME",
        file,
        "Use one lowercase stem with only the _test suffix and Go toolchain _GOOS/_GOARCH suffixes",
      );
    if (["utils", "helpers", "manager", "info", "record"].includes(name?.stem))
      add("GO_GENERIC_NAME", file, "Name the concrete responsibility");
    if (zone.kind === "kernel" && !zone.layout)
      add(
        "GO_KERNEL_LAYOUT",
        file,
        "Kernel admits only pkg/kernel/domain/<word>, pkg/kernel/app/port/<topic> and pkg/kernel/infra/peer",
      );
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
    const clause = parsed.tokens.findIndex(
      (token) => token.kind === "identifier" && token.value === "package",
    );
    if (clause >= 0 && parsed.tokens[clause + 1])
      clauses.set(
        directory,
        new Set([
          ...(clauses.get(directory) ?? []),
          parsed.tokens[clause + 1].value,
        ]),
      );
    if (zone.kind !== "generated") {
      nameReports(file, zone, parsed.tokens, report);
      aliasReports(file, parsed.tokens, dependencies, report);
      const shape = declarations(parsed.tokens);
      behavior.set(file, hasBehavior(parsed.tokens, shape));
      operationReports(file, zone, parsed.tokens, shape, report);
      if (zone.kind === "boot")
        bootReports(file, source, parsed.tokens, report);
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
  structureReports(files, bootTestdata, behavior, clauses, report);
  const result = enforce(root, reports, add);
  return {
    module: modulePath,
    go: "1.27.3",
    productionFiles: production.length,
    testFiles: files.length - production.length,
    excludedModules,
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
      else if (args[i] !== "--json")
        throw new Error(`Unknown or incomplete option: ${args[i]}`);
    }
    const result = checkGoArchitecture(root);
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
            `REPORT ${finding.code} ${finding.file}: ${finding.detail}\n`,
          );
      for (const finding of report.excepted)
        if (!only || finding.scope === only)
          process.stdout.write(
            `EXCEPTED ${finding.code} ${finding.file}: ${finding.detail} (${finding.reason}; removal: ${finding.removal})\n`,
          );
      // Counts per rule and scope; * marks a migrated (blocking) scope.
      const columns = [
        ...new Set([
          ...scopes,
          ...Object.values(report.counts).flatMap((byScope) =>
            Object.keys(byScope),
          ),
        ]),
      ].sort();
      const width = Math.max(...migrationCodes.map((code) => code.length));
      process.stdout.write(
        `\n${"rule".padEnd(width)} ${columns.map((scope) => scope.padStart(10)).join("")}     total\n`,
      );
      for (const code of migrationCodes) {
        const cells = columns.map((scope) => {
          const count = report.counts[code]?.[scope] ?? 0;
          const mark = report.migrated[code].includes(scope) ? "*" : " ";
          return `${count}${mark}`.padStart(10);
        });
        const total = Object.values(report.counts[code] ?? {}).reduce(
          (sum, count) => sum + count,
          0,
        );
        process.stdout.write(
          `${code.padEnd(width)} ${cells.join("")}${String(total).padStart(10)}\n`,
        );
      }
      process.stdout.write(
        `\nADR-0002 report mode: ${report.findings.length} report findings; ${report.excepted.length} excepted; * = migrated scope (blocking).\n`,
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
