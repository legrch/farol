import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const checker = path.join(root, "tooling/check-go-architecture.mjs");
const prefix = "github.com/legrch/farol/";
const moduleFile = "module github.com/legrch/farol\n\ngo 1.26.2\n";

type Finding = { code: string; file: string; detail: string };

type Report = {
  productionFiles: number;
  testFiles: number;
  excludedModules: string[];
  violations: Finding[];
  report: {
    mode: "report";
    findings: (Finding & { baseline: "existing" | "new" })[];
    baseline: {
      source: string | null;
      unbaselined: Finding[];
      stale: Finding[];
    };
  };
};

// These are source/import-graph fixtures, not compiler, platform-selection or
// native-host evidence. Each runs the actual executable against a fresh root.
function check(
  files: Record<string, string>,
  withModule = true,
  symlinks: Record<string, string> = {},
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "farol-go-architecture-"),
  );
  try {
    if (withModule)
      fs.writeFileSync(path.join(directory, "go.mod"), moduleFile);
    for (const [name, source] of Object.entries(files)) {
      const destination = path.join(directory, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, source);
    }
    for (const [name, target] of Object.entries(symlinks)) {
      const destination = path.join(directory, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(target, destination);
    }
    const result = spawnSync(
      process.execPath,
      [checker, "--root", directory, "--json"],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    return {
      status: result.status,
      report: JSON.parse(result.stdout) as Report,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function source(specifier?: string) {
  return `package fixture\n${specifier ? `import _ "${specifier}"\n` : ""}`;
}

function edge(from: string, to: string) {
  return check({
    [`${from}/policy.go`]: source(prefix + to),
    [`${to}/contract.go`]: source(),
  });
}

function denied(result: ReturnType<typeof check>, code: string, file?: string) {
  expect(result.status, JSON.stringify(result.report)).toBe(1);
  expect(result.report.violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code, ...(file ? { file } : {}) }),
    ]),
  );
}

describe("the executable root Go architecture boundary", () => {
  it("owns only the fixed Dev launcher utility and denies application imports", () => {
    const valid = check({
      "cmd/faroldevcontrol/main.go": source("golang.org/x/sys/unix"),
    });
    expect(valid.status).toBe(0);
    for (const target of [
      "boot",
      "modules/computer/contracts/workspace",
      "pkg/ipc",
    ]) {
      denied(edge("cmd/faroldevcontrol", target), "GO_DEV_TOOL_DEPENDENCY");
    }
    denied(
      check({ "cmd/anotherhelper/main.go": source("os") }),
      "GO_UNCLASSIFIED",
    );
  });
  it("checks production Go in the real checkout during the existing test gate", () => {
    const result = spawnSync(
      process.execPath,
      [checker, "--root", root, "--json"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(0);
    expect((JSON.parse(result.stdout) as Report).violations).toEqual([]);
  });
  it("checks a representative K0 root without needing Go installed", () => {
    const result = check({
      "cmd/farol/main.go": source(prefix + "boot"),
      "boot/main.go": source(prefix + "transport/desktop"),
      "transport/desktop/server.go": source(
        prefix + "modules/task/contracts/task",
      ),
      "modules/task/contracts/task/contract.go": source(
        prefix + "modules/task/app/services/task",
      ),
      "modules/task/app/services/task/create.go": source(
        prefix + "modules/task/domain/task",
      ),
      "modules/task/domain/task/task.go": source("errors"),
      "modules/task/infra/peer/computer/client.go": source(
        prefix + "modules/computer/contracts/workspace",
      ),
      "modules/computer/contracts/workspace/contract.go": source(
        prefix + "pkg/kernel/domain/id",
      ),
      "pkg/kernel/domain/id/id.go": source(),
      "pkg/kernel/app/port/clock.go": source(prefix + "pkg/kernel/domain/id"),
      "pkg/kernel/infra/clock/clock.go": source("time"),
      "modules/chat/infra/client/client.go": source("example.org/provider/sdk"),
      "modules/release/infra/repos/release/repo.go": source("os"),
      "pkg/ipc/frame.go": source("io"),
      "gen/desktop/v1/types.go": source("encoding/json"),
      "modules/task/domain/task/task_test.go": source("os"),
    });
    expect(result.status, JSON.stringify(result.report)).toBe(0);
    expect(result.report.productionFiles).toBe(15);
    expect(result.report.testFiles).toBe(1);
  });

  it("allows an independent contract adapter to delegate through context", () => {
    const result = check({
      "modules/computer/contracts/workspace/contract.go": `package fixture\nimport ("context"; _ "${prefix}modules/computer/app/services/workspace")\n`,
      "modules/computer/app/services/workspace/service.go": source("context"),
    });
    expect(result.status, JSON.stringify(result.report)).toBe(0);
  });

  const allowed = [
    ["modules/chat/domain/turn", "modules/chat/domain/id"],
    ["modules/chat/domain/turn", "pkg/kernel/domain/id"],
    ["modules/chat/app/services/turn", "modules/chat/app/port"],
    ["modules/chat/app/services/turn", "modules/chat/app/capabilities/guard"],
    ["modules/chat/app/capabilities/guard", "pkg/kernel/app/port"],
    ["modules/chat/infra/peer/task", "modules/task/contracts/task"],
    ["modules/chat/contracts/turn", "pkg/kernel/domain/id"],
    ["modules/chat/contracts/turn", "modules/chat/domain/turn"],
    ["modules/chat/contracts/turn", "modules/chat/app/services/turn"],
    ["pkg/kernel/app/port", "pkg/kernel/domain/id"],
    ["pkg/kernel/infra/clock", "pkg/kernel/app/port"],
  ] as const;
  for (const [from, to] of allowed)
    it(`accepts ${from} -> ${to}`, () => {
      const result = edge(from, to);
      expect(result.status, JSON.stringify(result.report)).toBe(0);
    });

  const forbidden = [
    [
      "modules/chat/domain/turn",
      "modules/chat/infra/client",
      "GO_LAYER_DIRECTION",
    ],
    ["modules/chat/domain/turn", "pkg/kernel/app/port", "GO_LAYER_DIRECTION"],
    [
      "modules/chat/app/services/turn",
      "modules/chat/infra/client",
      "GO_LAYER_DIRECTION",
    ],
    [
      "modules/chat/app/services/turn",
      "transport/desktop",
      "GO_LAYER_DIRECTION",
    ],
    ["modules/chat/app/services/turn", "boot", "GO_MODULE_TO_BOOT"],
    ["modules/chat/app/services/turn", "pkg/ipc", "GO_LAYER_DIRECTION"],
    ["modules/chat/app/services/turn", "gen/desktop/v1", "GO_LAYER_DIRECTION"],
    [
      "modules/chat/app/services/turn",
      "modules/chat/app/services/slot",
      "GO_SERVICE_DEPENDENCY",
    ],
    ["modules/chat/infra/client", "boot", "GO_MODULE_TO_BOOT"],
    [
      "modules/chat/infra/client",
      "pkg/kernel/infra/clock",
      "GO_MODULE_TO_KERNEL_INFRA",
    ],
    [
      "modules/chat/infra/client",
      "modules/task/contracts/task",
      "GO_CROSS_MODULE",
    ],
    [
      "modules/chat/infra/peer/task",
      "modules/task/app/services/task",
      "GO_CROSS_MODULE",
    ],
    [
      "modules/chat/infra/peer/task",
      "modules/task/domain/task",
      "GO_CROSS_MODULE",
    ],
    [
      "modules/chat/infra/peer/task",
      "modules/task/infra/client",
      "GO_CROSS_MODULE",
    ],
    [
      "modules/chat/app/services/turn",
      "modules/task/contracts/task",
      "GO_CROSS_MODULE",
    ],
    ["pkg/kernel/domain/id", "modules/task/domain/task", "GO_KERNEL_TO_MODULE"],
    ["pkg/kernel/app/port", "pkg/kernel/infra/clock", "GO_LAYER_DIRECTION"],
    [
      "pkg/kernel/infra/clock",
      "modules/task/contracts/task",
      "GO_KERNEL_TO_MODULE",
    ],
    [
      "pkg/kernel/infra/peer/task",
      "modules/task/contracts/task",
      "GO_KERNEL_TO_MODULE",
    ],
    [
      "pkg/kernel/infra/peer/task",
      "modules/task/contracts/task/extra",
      "GO_KERNEL_TO_MODULE",
    ],
    [
      "pkg/kernel/infra/peer/task",
      "modules/task/domain/task",
      "GO_KERNEL_TO_MODULE",
    ],
    ["cmd/farol", "modules/task/app/services/task", "GO_CMD_NOT_THIN"],
    [
      "gen/desktop/v1",
      "modules/task/contracts/task",
      "GO_GENERATED_DEPENDENCY",
    ],
  ] as const;
  for (const [from, to, code] of forbidden)
    it(`rejects ${from} -> ${to}`, () =>
      denied(edge(from, to), code, `${from}/policy.go`));

  for (const dependency of [
    "os",
    "io",
    "io/fs",
    "net/http",
    "os/exec",
    "syscall",
    "math/rand/v2",
    "crypto/rand",
    "log",
    "runtime",
    "reflect",
    "example.org/sdk",
  ]) {
    for (const layer of ["domain", "app/services"] as const)
      it(`rejects ${dependency} in ${layer}`, () =>
        denied(
          check({
            [`modules/chat/${layer}/turn/policy.go`]: source(dependency),
          }),
          "GO_PURE_IMPORT",
        ));
  }

  for (const dependency of [
    "golang.org/x/text/cases",
    "golang.org/x/text/collate",
    "golang.org/x/text/language",
    "golang.org/x/text/unicode/norm",
  ]) {
    for (const layer of ["domain", "app/services"] as const)
      it(`accepts exact approved Unicode import ${dependency} in ${layer}`, () => {
        const result = check({
          [`modules/computer/${layer}/workspace/policy.go`]: source(dependency),
        });
        expect(result.status, JSON.stringify(result.report)).toBe(0);
      });
  }
  for (const dependency of [
    "golang.org/x/text",
    "golang.org/x/text/encoding",
    "golang.org/x/text/transform",
    "golang.org/x/text/message",
    "golang.org/x/text/unicode/bidi",
    "golang.org/x/text/unicode",
    "golang.org/x/text/internal/language",
    "golang.org/x/text/cases/extra",
    "golang.org/x/text/unicode/norm/extra",
    "golang.org/x/text/cases-extra",
    "golang.org/x/sys/unix",
  ]) {
    for (const layer of ["domain", "app/services"] as const)
      it(`rejects unapproved Unicode/native import ${dependency} in ${layer}`, () =>
        denied(
          check({
            [`modules/computer/${layer}/workspace/policy.go`]:
              source(dependency),
          }),
          "GO_PURE_IMPORT",
        ));
  }

  const escapeFixtures = [
    ["unsafe", source("unsafe"), "GO_PURE_ESCAPE"],
    [
      "cgo",
      'package turn\n/* void effect(void); */\nimport "C"\nfunc effect() { C.effect() }\n',
      "GO_PURE_ESCAPE",
    ],
    [
      "loader",
      'package turn\nimport p "plugin"\nvar loader = p.Open\n',
      "GO_DYNAMIC_LOADER",
    ],
    [
      "linkname",
      'package turn\nimport _ "unsafe"\n//go:linkname effect runtime.effect\nfunc effect()\n',
      "GO_LINKNAME",
    ],
    [
      "aliased-clock",
      'package turn\nimport clock "time"\nvar now = clock.Now\n',
      "GO_PURE_AMBIENT",
    ],
    [
      "dot-clock",
      'package turn\nimport . "time"\nvar now = Now\n',
      "GO_PURE_DOT_IMPORT",
    ],
    [
      "stdout",
      'package turn\nimport "fmt"\nvar output = fmt.Println\n',
      "GO_PURE_AMBIENT",
    ],
    [
      "builtin-output",
      'package turn\nfunc effect() { println("effect") }\n',
      "GO_PURE_AMBIENT",
    ],
    [
      "deadline",
      'package turn\nimport "context"\nvar timer = context.WithTimeout\n',
      "GO_PURE_AMBIENT",
    ],
    [
      "timezone",
      'package turn\nimport "time"\nvar zone = time.Local\n',
      "GO_PURE_AMBIENT",
    ],
    [
      "local-method",
      'package turn\nimport "time"\nfunc local(t time.Time) time.Time { return t.Local() }\n',
      "GO_PURE_AMBIENT",
    ],
    ["escaped-import", 'package turn\nimport _ "o\\x73"\n', "GO_PURE_IMPORT"],
    ["raw-import", "package turn\nimport _ `os`\n", "GO_PURE_IMPORT"],
  ] as const;
  for (const [name, fixture, code] of escapeFixtures)
    it(`rejects the ${name} escape`, () =>
      denied(
        check({ "modules/chat/app/services/turn/policy.go": fixture }),
        code,
      ));

  it("ignores fake imports and loader directives in strings/comments", () => {
    const result = check({
      "modules/chat/domain/turn/policy.go":
        'package turn\n// import "os"\n/* //go:linkname hidden */\nconst text = `import "plugin"\n//go:linkname hidden`\nconst quoted = "import \"os\""\n',
    });
    expect(result.status, JSON.stringify(result.report)).toBe(0);
  });
  it("does not interpret directives embedded in block comments", () => {
    const result = check({
      "modules/chat/domain/turn/policy.go":
        "package turn\n/*\n//go:linkname hidden runtime.hidden\n*/\n",
    });
    expect(result.status, JSON.stringify(result.report)).toBe(0);
  });
  it("rejects a real linkname directive even without an unsafe import", () =>
    denied(
      check({
        "modules/chat/domain/turn/policy.go":
          "package turn\n//go:linkname hidden runtime.hidden\nfunc hidden()\n",
      }),
      "GO_LINKNAME",
    ));
  it("accepts pure formatting, explicit UTC time values and app context ports", () => {
    const result = check({
      "modules/chat/app/port/clock.go":
        'package port\nimport ("fmt"; clock "time"; "context")\ntype Clock interface { Read(context.Context) clock.Time }\nvar duration = clock.Second\nvar zone = clock.UTC\nvar format = fmt.Sprintf\n',
    });
    expect(result.status, JSON.stringify(result.report)).toBe(0);
  });
  it("accepts the declared generated schema validator imports", () => {
    const result = check({
      "gen/desktop/v1/wire.go": `// Code generated by Farol schema generator. DO NOT EDIT.
package v1
import ("encoding/json"; "errors"; "math"; "regexp"; "strconv"; "strings"; "time")
var decode = json.Unmarshal
var invalid = errors.New
var finite = math.IsInf
var pattern = regexp.MatchString
var number = strconv.ParseFloat
var trim = strings.TrimSpace
var timestamp = time.Parse
`,
      "tooling/desktop-validator.go.txt": 'package escape\nimport "os"\n',
    });
    expect(result.status, JSON.stringify(result.report)).toBe(0);
    expect(result.report.productionFiles).toBe(1);
  });
  it("does not extend the generated timestamp exception to domain", () =>
    denied(
      check({
        "modules/chat/domain/turn/policy.go":
          'package turn\nimport "time"\nvar timestamp = time.Parse\n',
      }),
      "GO_PURE_AMBIENT",
    ));
  it("still rejects ambient clocks in generated validators", () =>
    denied(
      check({
        "gen/desktop/v1/wire.go":
          'package v1\nimport "time"\nvar now = time.Now\n',
      }),
      "GO_PURE_AMBIENT",
    ));
  it("checks platform-tagged sources even on another host", () =>
    denied(
      check({
        "modules/chat/domain/turn/windows.go":
          "//go:build windows\n\n" + source("os"),
      }),
      "GO_PURE_IMPORT",
    ));
  it("finds package cycles with their complete path", () => {
    const result = check({
      "modules/chat/domain/turn/turn.go": source(
        prefix + "modules/chat/domain/slot",
      ),
      "modules/chat/domain/slot/slot.go": source(
        prefix + "modules/chat/domain/id",
      ),
      "modules/chat/domain/id/id.go": source(
        prefix + "modules/chat/domain/turn",
      ),
    });
    denied(result, "GO_CYCLE");
    expect(
      result.report.violations.find((item) => item.code === "GO_CYCLE")?.detail,
    ).toContain(
      "modules/chat/domain/id -> modules/chat/domain/turn -> modules/chat/domain/slot -> modules/chat/domain/id",
    );
  });
  it("rejects unresolved local package imports", () =>
    denied(
      check({
        "modules/chat/domain/turn/turn.go": source(
          prefix + "modules/chat/domain/missing",
        ),
      }),
      "GO_LOCAL_IMPORT",
    ));
  for (const location of [
    "unexpected/policy.go",
    "modules/agent/domain/task/task.go",
    "modules/chat/service/service.go",
    "modules/chat/app/service/turn/create.go",
    "pkg/misc/policy.go",
  ])
    it(`fails closed for ${location}`, () =>
      denied(check({ [location]: source() }), "GO_UNCLASSIFIED", location));
  for (const filename of [
    "read_helpers.go",
    "farol-task.go",
    "Read.go",
    "_read.go",
    ".read.go",
    "read_darwin.go",
    "20261002.go",
  ])
    it(`rejects the filename ${filename}`, () =>
      denied(
        check({ [`modules/task/domain/task/${filename}`]: source() }),
        "GO_SHORT_NAME",
      ));
  it("rejects generic helper names", () =>
    denied(
      check({ "modules/task/domain/task/utils.go": source() }),
      "GO_GENERIC_NAME",
    ));
  it("permits a documented generated naming exception only in gen", () => {
    const generated = "// Code generated by protoc. DO NOT EDIT.\npackage v1\n";
    expect(check({ "gen/desktop/v1/desktop.pb.go": generated }).status).toBe(0);
    denied(
      check({ "modules/task/domain/task/desktop.pb.go": generated }),
      "GO_SHORT_NAME",
    );
    denied(
      check({ "gen/desktop/v1/desktop.pb.go": source() }),
      "GO_SHORT_NAME",
    );
  });
  it("reports the transitional nested module without claiming root coverage", () => {
    const result = check(
      {
        "resources/native/go/go.mod": "module native\ngo 1.24\n",
        "resources/native/go/archive.go": source("os"),
      },
      false,
    );
    expect(result.status).toBe(0);
    expect(result.report.productionFiles).toBe(0);
    expect(result.report.excludedModules).toEqual(["resources/native/go"]);
  });
  it("does not exclude native Go without the explicit nested module", () =>
    denied(
      check({ "resources/native/go/archive.go": source() }),
      "GO_UNCLASSIFIED",
    ));
  it("rejects other nested modules", () =>
    denied(
      check({
        "modules/chat/go.mod": "module escape\n",
        "modules/chat/domain/turn/turn.go": source(),
      }),
      "GO_NESTED_MODULE",
    ));
  it("does not silently exempt authored Go under desktop", () =>
    denied(check({ "apps/desktop/escape.go": source() }), "GO_UNCLASSIFIED"));
  it("excludes checker fixtures and build/dependency products", () => {
    expect(
      check({
        "tests/architecture/go-fixtures/invalid/escape.go": source(),
        "_output/build/escape.go": source(),
        "node_modules/sdk/escape.go": source(),
      }).status,
    ).toBe(0);
  });
  it("excludes historical root dist output including framework symlinks", () => {
    const result = check(
      {
        "modules/chat/domain/turn/policy.go": source(),
        "dist/package/go.mod": "module historical\n",
        "dist/package/Electron.framework/Versions/A/escape.go": source("os"),
      },
      true,
      { "dist/package/Electron.framework/Versions/Current": "A" },
    );
    expect(result.status, JSON.stringify(result.report)).toBe(0);
    expect(result.report.violations).toEqual([]);
    expect(result.report.productionFiles).toBe(1);
  });
  it("still checks authored Go in nested source directories named dist", () =>
    denied(
      check({ "modules/chat/domain/dist/policy.go": source("os") }),
      "GO_PURE_IMPORT",
      "modules/chat/domain/dist/policy.go",
    ));
  it.each([
    ["modules/chat/domain/turn/linked.go", "policy.go"],
    ["modules/chat/domain/dist", "turn"],
  ])("still rejects source symlinks at %s", (name, target) =>
    denied(
      check({ "modules/chat/domain/turn/policy.go": source() }, true, {
        [name]: target,
      }),
      "GO_SYMLINK",
      name,
    ),
  );
  it("does not classify test-only Go packages as production", () => {
    const result = check({
      "tests/protocol/server.go": source("net/http"),
      "tests/native/main.go": source("os"),
    });
    expect(result.status).toBe(0);
    expect(result.report.productionFiles).toBe(0);
  });
  it("requires a root module once root production Go exists", () =>
    denied(check({ "boot/main.go": source() }, false), "GO_MODULE_MISSING"));
  it("rejects an unexpected root module identity", () =>
    denied(
      check({ "go.mod": "module githubXcom/legrch/farol\ngo 1.26.2\n" }),
      "GO_MODULE_IDENTITY",
    ));
  it("rejects toolchain drift", () =>
    denied(
      check({ "go.mod": "module github.com/legrch/farol\ngo 1.25.0\n" }),
      "GO_TOOLCHAIN",
    ));
  it("fails closed for malformed import declarations", () =>
    denied(
      check({
        "modules/chat/domain/turn/policy.go":
          'package turn\nimport ("errors"; os)\n',
      }),
      "GO_PARSE",
    ));
  it("does not mistake external prefix lookalikes for owned imports", () =>
    denied(
      check({
        "modules/chat/domain/turn/policy.go": source(
          "github.com/legrch/farol-extra/modules/chat/domain/turn",
        ),
      }),
      "GO_PURE_IMPORT",
    ));
  it.each(["app/services/task", "domain/task", "infra/peer/computer"])(
    "rejects transport bypass of module contracts: %s",
    (layer) => {
      const result = check({
        "transport/desktop/server.go": source(prefix + "modules/task/" + layer),
        ["modules/task/" + layer + "/target.go"]: source(),
      });
      denied(result, "GO_TRANSPORT_DEPENDENCY");
    },
  );
});

// Checked-in synthetic snippets exercise lexical rules, not Go compilation,
// runtime behavior, semantic ownership, or native-host qualification.
const reportFixtures = JSON.parse(
  fs.readFileSync(
    path.join(root, "tests/fixtures/go-architecture/cases.json"),
    "utf8",
  ),
) as {
  name: string;
  files: Record<string, string>;
  reports: Finding[];
  blocking: string[];
}[];
const baselineFile = "tooling/go-architecture-baseline.json";
const baselineSource = "df8efa37eef45ead673db071c9579a9111b67ac7";
const baseline = (findings: Finding[]) =>
  JSON.stringify({
    version: 1,
    mode: "report",
    source: baselineSource,
    findings,
  });
const withoutStatus = (report: Report) =>
  report.report.findings.map(({ baseline: _status, ...finding }) => finding);

describe("ADR-0001 report-mode architecture guards", () => {
  it.each(reportFixtures)("reports $name", ({ files, reports, blocking }) => {
    const result = check(files);
    expect(result.status, JSON.stringify(result.report)).toBe(
      blocking.length ? 1 : 0,
    );
    expect(result.report.report.mode).toBe("report");
    expect(withoutStatus(result.report)).toEqual(
      expect.arrayContaining(reports),
    );
    expect(withoutStatus(result.report)).toHaveLength(reports.length);
    expect(result.report.violations.map(({ code }) => code).sort()).toEqual(
      [...blocking].sort(),
    );
    expect(result.report.report.baseline.unbaselined).toEqual(
      withoutStatus(result.report),
    );
  });

  it("enumerates the real baseline exactly without new or stale exceptions", () => {
    const result = spawnSync(
      process.execPath,
      [checker, "--root", root, "--json"],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    const stored = JSON.parse(
      fs.readFileSync(path.join(root, baselineFile), "utf8"),
    ) as { source: string; findings: Finding[] };
    expect(stored.source).toBe(baselineSource);
    expect(stored.findings.length).toBeGreaterThan(0);
    expect(withoutStatus(report)).toEqual(stored.findings);
    expect(report.report.baseline).toEqual({
      source: baselineSource,
      unbaselined: [],
      stale: [],
    });
    expect(
      report.report.findings.every(({ baseline }) => baseline === "existing"),
    ).toBe(true);
  });

  it("keeps additions visible and reports stale exact exceptions deterministically", () => {
    const file = "modules/chat/app/services/turn/read.go";
    const files = { [file]: "package turn\ntype ReadRequest = CheckRequest\n" };
    const original = withoutStatus(check(files).report);
    const existing = check({ ...files, [baselineFile]: baseline(original) });
    expect(existing.status).toBe(0);
    expect(existing.report.report.findings[0]?.baseline).toBe("existing");
    const changed = check({
      ...files,
      [file]: files[file] + "type ReadResponse = CheckResponse\n",
      [baselineFile]: baseline(original),
    });
    expect(changed.status).toBe(0); // New ADR findings remain reports.
    expect(changed.report.report.baseline.unbaselined).toEqual([
      {
        code: "GO_DTO_ALIAS",
        file,
        detail: "DTO alias ReadResponse = CheckResponse",
      },
    ]);
    const removed = check({ [baselineFile]: baseline(original) });
    expect(removed.report.report.baseline.stale).toEqual(original);
    expect(
      check({ ...files, [baselineFile]: baseline(original) }).report,
    ).toEqual(existing.report);
  });

  it("cannot baseline away an existing blocking import violation", () => {
    const file = "modules/chat/app/services/turn/read.go";
    const files = {
      [file]: 'package turn\nimport _ "os"\ntype ReadRequest = CheckRequest\n',
    };
    const reports = withoutStatus(check(files).report);
    const result = check({ ...files, [baselineFile]: baseline(reports) });
    denied(result, "GO_PURE_IMPORT", file);
    expect(result.report.report.baseline.unbaselined).toEqual([]);
  });

  it.each([
    [{ code: "GO_PURE_IMPORT", file: "policy.go", detail: "os" }],
    [{ code: "GO_DTO_ALIAS", file: "modules/**", detail: "wildcard" }],
    [{ code: "GO_DTO_ALIAS", file: "../escape.go", detail: "escape" }],
    [
      { code: "GO_DTO_ALIAS", file: "policy.go", detail: "duplicate" },
      { code: "GO_DTO_ALIAS", file: "policy.go", detail: "duplicate" },
    ],
  ])("rejects malformed or blocking baseline entries %#", (...entries) => {
    // Baseline errors go to stderr, unlike ordinary architecture findings.
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "farol-go-baseline-"),
    );
    try {
      fs.mkdirSync(path.join(directory, "tooling"));
      fs.writeFileSync(path.join(directory, baselineFile), baseline(entries));
      const result = spawnSync(
        process.execPath,
        [checker, "--root", directory, "--json"],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Invalid or duplicate Go architecture baseline finding",
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each([
    null,
    false,
    0,
    { version: 2, mode: "report", source: baselineSource, findings: [] },
  ])("rejects invalid baseline envelopes %#", (envelope) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "farol-go-baseline-"),
    );
    try {
      fs.mkdirSync(path.join(directory, "tooling"));
      fs.writeFileSync(
        path.join(directory, baselineFile),
        JSON.stringify(envelope),
      );
      const result = spawnSync(
        process.execPath,
        [checker, "--root", directory, "--json"],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Invalid Go architecture report baseline",
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
