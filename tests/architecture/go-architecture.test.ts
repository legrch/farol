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
const moduleFile = "module github.com/legrch/farol\n\ngo 1.27.3\n";

type Finding = { code: string; file: string; detail: string };
type Scoped = Finding & { scope: string };

type Report = {
  productionFiles: number;
  testFiles: number;
  excludedModules: string[];
  violations: Finding[];
  report: {
    mode: "report";
    source: string | null;
    migrated: Record<string, string[]>;
    findings: Scoped[];
    excepted: (Scoped & { reason: string; removal: string })[];
    counts: Record<string, Record<string, number>>;
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
      "pkg/kernel/app/port/clock/clock.go": source(
        prefix + "pkg/kernel/domain/id",
      ),
      "pkg/clock/clock.go": source("time"),
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
    ["modules/chat/app/capabilities/guard", "pkg/kernel/app/port/clock"],
    ["modules/chat/infra/peer/task", "modules/task/contracts/task"],
    ["modules/chat/contracts/turn", "pkg/kernel/domain/id"],
    ["modules/chat/contracts/turn", "modules/chat/domain/turn"],
    ["modules/chat/contracts/turn", "modules/chat/app/services/turn"],
    ["pkg/kernel/app/port/clock", "pkg/kernel/domain/id"],
    ["pkg/kernel/infra/peer", "pkg/kernel/app/port/clock"],
    // ADR-0002 shared code: flat kits serve infrastructure, adapters and kits.
    ["modules/chat/infra/client", "pkg/limit"],
    ["modules/chat/infra/peer", "pkg/limit"],
    ["transport/desktop", "pkg/limit"],
    ["pkg/limit", "pkg/kernel/domain/digest"],
    ["pkg/limit", "pkg/kernel/app/port/clock"],
    ["pkg/limit", "pkg/clock"],
    ["pkg/limit", "pkg/ipc"],
    ["modules/chat/domain/turn", "pkg/kernel/domain/digest"],
    ["modules/chat/contracts/turn", "pkg/kernel/domain/digest"],
    // ADR-0002 module-owned desktop adapter.
    ["modules/chat/desktop/turn", "modules/chat/contracts/turn"],
    ["modules/chat/desktop/turn", "modules/chat/app/services/turn"],
    ["modules/chat/desktop/turn", "modules/chat/domain/turn"],
    ["modules/chat/desktop/turn", "pkg/kernel/domain/digest"],
    ["modules/chat/desktop/turn", "pkg/limit"],
    ["modules/chat/desktop/turn", "pkg/ipc"],
    ["modules/chat/desktop/turn", "gen/desktop/v1"],
    ["modules/chat/desktop/turn", "transport/desktop"],
    ["boot", "modules/chat/desktop/turn"],
    ["boot", "pkg/kernel/infra/peer"],
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
    [
      "modules/chat/domain/turn",
      "pkg/kernel/app/port/clock",
      "GO_LAYER_DIRECTION",
    ],
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
      "pkg/kernel/infra/peer",
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
    [
      "pkg/kernel/app/port/clock",
      "pkg/kernel/infra/peer",
      "GO_LAYER_DIRECTION",
    ],
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
    // ADR-0002 shared code: kits stay out of pure layers and import no owner.
    ["modules/chat/domain/turn", "pkg/limit", "GO_LAYER_DIRECTION"],
    ["modules/chat/app/services/turn", "pkg/limit", "GO_LAYER_DIRECTION"],
    ["modules/chat/app/port", "pkg/limit", "GO_LAYER_DIRECTION"],
    ["modules/chat/contracts/turn", "pkg/limit", "GO_CONTRACT_LEAK"],
    ["pkg/kernel/domain/digest", "pkg/limit", "GO_LAYER_DIRECTION"],
    ["pkg/kernel/app/port/clock", "pkg/limit", "GO_LAYER_DIRECTION"],
    ["pkg/kernel/infra/peer", "pkg/limit", "GO_LAYER_DIRECTION"],
    ["pkg/limit", "modules/chat/contracts/turn", "GO_KIT_DEPENDENCY"],
    ["pkg/limit", "boot", "GO_KIT_DEPENDENCY"],
    ["pkg/limit", "transport/desktop", "GO_KIT_DEPENDENCY"],
    ["pkg/limit", "gen/desktop/v1", "GO_KIT_DEPENDENCY"],
    ["pkg/limit", "pkg/kernel/infra/peer", "GO_KIT_DEPENDENCY"],
    ["pkg/ipc", "pkg/limit", "GO_IPC_DEPENDENCY"],
    ["cmd/farol", "pkg/limit", "GO_CMD_NOT_THIN"],
    ["transport/desktop", "pkg/kernel/infra/peer", "GO_TRANSPORT_DEPENDENCY"],
    // ADR-0002 module-owned desktop adapter: own contracts/app/domain only.
    [
      "modules/chat/desktop/turn",
      "modules/chat/infra/client",
      "GO_DESKTOP_DEPENDENCY",
    ],
    ["modules/chat/desktop/turn", "boot", "GO_MODULE_TO_BOOT"],
    [
      "modules/chat/desktop/turn",
      "modules/task/contracts/task",
      "GO_CROSS_MODULE",
    ],
    [
      "modules/chat/desktop/turn",
      "pkg/kernel/infra/peer",
      "GO_MODULE_TO_KERNEL_INFRA",
    ],
    [
      "modules/chat/infra/client",
      "modules/chat/desktop/turn",
      "GO_LAYER_DIRECTION",
    ],
    [
      "modules/chat/app/services/turn",
      "modules/chat/desktop/turn",
      "GO_LAYER_DIRECTION",
    ],
    [
      "modules/chat/contracts/turn",
      "modules/chat/desktop/turn",
      "GO_CONTRACT_LEAK",
    ],
    [
      "transport/desktop",
      "modules/chat/desktop/turn",
      "GO_TRANSPORT_DEPENDENCY",
    ],
  ] as const;
  for (const [from, to, code] of forbidden)
    it(`rejects ${from} -> ${to}`, () =>
      denied(edge(from, to), code, `${from}/policy.go`));

  it("allows only deterministic SHA-256 value hashing in pure code", () => {
    const file = "modules/computer/domain/connector/policy.go";
    const valid = check({
      [file]:
        'package connector\nimport "crypto/sha256"\nvar _ = sha256.Sum256([]byte("x"))\n',
    });
    expect(valid.status, JSON.stringify(valid.report)).toBe(0);
    const invalid = check({
      [file]:
        'package connector\nimport "crypto/sha256"\nvar _ = sha256.New()\n',
    });
    denied(invalid, "GO_PURE_AMBIENT", file);
  });

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
    "pkg/turnkit/policy.go",
    "pkg/chat/policy.go",
    "pkg/limit/extra/policy.go",
  ])
    it(`fails closed for ${location}`, () =>
      denied(check({ [location]: source() }), "GO_UNCLASSIFIED", location));
  for (const filename of [
    "read_helpers.go",
    "farol-task.go",
    "Read.go",
    "_read.go",
    ".read.go",
    "20261002.go",
    "read_unix.go",
    "read_darwin_helpers.go",
    "read_amd64_darwin.go",
    "read_test_darwin.go",
    "read_test_test.go",
  ])
    it(`rejects the filename ${filename}`, () =>
      denied(
        check({ [`modules/task/domain/task/${filename}`]: source() }),
        "GO_SHORT_NAME",
      ));
  for (const filename of [
    "read_darwin.go",
    "read_linux_arm64.go",
    "read_arm64.go",
    "read_darwin_test.go",
    "read_windows_amd64_test.go",
  ])
    it(`accepts the Go toolchain suffix in ${filename}`, () => {
      const result = check({
        "modules/task/domain/task/read.go": source(),
        [`modules/task/domain/task/${filename}`]: source(),
      });
      expect(result.status, JSON.stringify(result.report)).toBe(0);
    });
  for (const location of [
    "pkg/kernel/domain/policy.go",
    "pkg/kernel/domain/digest/extra/policy.go",
    "pkg/kernel/app/port/policy.go",
    "pkg/kernel/app/clock/policy.go",
    "pkg/kernel/infra/clock/policy.go",
    "pkg/kernel/infra/peer/chat/policy.go",
  ])
    it(`rejects the kernel layout ${location}`, () =>
      denied(check({ [location]: source() }), "GO_KERNEL_LAYOUT", location));
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
      check({ "go.mod": "module githubXcom/legrch/farol\ngo 1.27.3\n" }),
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
const adr0001Codes = new Set([
  "GO_PACKAGE_NAME",
  "GO_CATCH_ALL_NAME",
  "GO_CAPABILITY_DIRECTION",
  "GO_INFRA_SERVICE",
  "GO_DTO_ALIAS",
]);
const plain = (findings: Scoped[]) =>
  findings.map(({ scope: _scope, ...finding }) => finding);

describe("ADR-0001 report-mode architecture guards", () => {
  it.each(reportFixtures)("reports $name", ({ files, reports, blocking }) => {
    const result = check(files);
    expect(result.status, JSON.stringify(result.report)).toBe(
      blocking.length ? 1 : 0,
    );
    expect(result.report.report.mode).toBe("report");
    // ADR-0002 rules also report on these snippets; this suite pins ADR-0001.
    const findings = plain(result.report.report.findings).filter(({ code }) =>
      adr0001Codes.has(code),
    );
    expect(findings).toEqual(expect.arrayContaining(reports));
    expect(findings).toHaveLength(reports.length);
    expect(result.report.violations.map(({ code }) => code).sort()).toEqual(
      [...blocking].sort(),
    );
  });
});

const enforcementFile = "tooling/go-architecture-enforcement.json";
const enforcementSource = "bb8381d7682318524963506a3ae091a17d6560e0";
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
// The migration switch only grows. When a module migrates a rule, add the
// scope to the enforcement file AND here in the same pull request; removing a
// migrated scope from the file fails this floor.
const migratedFloor: Record<string, string[]> = {};
type Enforcement = {
  version: number;
  source: string;
  migrated: Record<string, string[]>;
  exceptions: (Finding & { reason: string; removal: string })[];
  ceilings: Record<string, Record<string, number>>;
};
const enforcement = (overrides: Partial<Enforcement> = {}) =>
  JSON.stringify({
    version: 2,
    source: enforcementSource,
    migrated: Object.fromEntries(migrationCodes.map((code) => [code, []])),
    exceptions: [],
    ceilings: {},
    ...overrides,
  });
const migrate = (code: string, ...scopes: string[]) => ({
  ...Object.fromEntries(migrationCodes.map((item) => [item, [] as string[]])),
  [code]: scopes,
});

describe("ADR-0002 enforcement switch", () => {
  const wordFile = "modules/chat/domain/turn/turnpolicy.go";
  const wordFinding = {
    code: "GO_FILE_WORD",
    file: wordFile,
    detail: "File name outside the admitted vocabulary: turnpolicy",
  };
  const files = {
    [wordFile]: "package turn\n",
    "modules/task/domain/task/taskpolicy.go": "package task\n",
  };

  it("keeps the real checkout green with a growing switch and ceilings", () => {
    const result = spawnSync(
      process.execPath,
      [checker, "--root", root, "--json"],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    const stored = JSON.parse(
      fs.readFileSync(path.join(root, enforcementFile), "utf8"),
    ) as Enforcement;
    expect(stored.version).toBe(2);
    expect(Object.keys(stored.migrated)).toEqual(migrationCodes);
    for (const [code, scopes] of Object.entries(migratedFloor))
      expect(stored.migrated[code]).toEqual(expect.arrayContaining(scopes));
    expect(report.report.migrated).toEqual(stored.migrated);
    expect(report.report.source).toBe(stored.source);
    expect(report.violations).toEqual([]);
    for (const [code, byScope] of Object.entries(report.report.counts))
      for (const [scope, count] of Object.entries(byScope))
        if (!stored.migrated[code]?.includes(scope))
          expect(count, `${code} ${scope}`).toBe(
            stored.ceilings[code]?.[scope],
          );
    for (const [code, byScope] of Object.entries(stored.ceilings))
      for (const [scope, ceiling] of Object.entries(byScope))
        expect(report.report.counts[code]?.[scope], `${code} ${scope}`).toBe(
          ceiling,
        );
  });

  it("reports every scope without an enforcement file", () => {
    const result = check(files);
    expect(result.status, JSON.stringify(result.report)).toBe(0);
    expect(result.report.report.source).toBeNull();
    expect(plain(result.report.report.findings)).toContainEqual(wordFinding);
    expect(result.report.report.counts.GO_FILE_WORD).toEqual({
      chat: 1,
      task: 1,
    });
  });

  it("prints report lines for one scope and the count table", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "farol-go-architecture-"),
    );
    try {
      fs.writeFileSync(path.join(directory, "go.mod"), moduleFile);
      for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(directory, name)), {
          recursive: true,
        });
        fs.writeFileSync(path.join(directory, name), text);
      }
      const result = spawnSync(
        process.execPath,
        [checker, "--root", directory, "--scope", "chat"],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `REPORT GO_FILE_WORD ${wordFile}: ${wordFinding.detail}`,
      );
      expect(result.stdout).not.toContain("taskpolicy");
      expect(result.stdout).toMatch(/^GO_FILE_WORD +0 +1 +0 .* 2$/mu);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("blocks a rule only in its migrated scope", () => {
    const result = check({
      ...files,
      [enforcementFile]: enforcement({
        migrated: migrate("GO_FILE_WORD", "chat"),
        ceilings: { GO_FILE_WORD: { task: 1 } },
      }),
    });
    denied(result, "GO_FILE_WORD", wordFile);
    expect(
      result.report.violations.filter(({ code }) => code === "GO_FILE_WORD"),
    ).toEqual([wordFinding]);
    expect(
      result.report.report.findings.filter(
        ({ code }) => code === "GO_FILE_WORD",
      ),
    ).toEqual([
      {
        code: "GO_FILE_WORD",
        file: "modules/task/domain/task/taskpolicy.go",
        detail: "File name outside the admitted vocabulary: taskpolicy",
        scope: "task",
      },
    ]);
  });

  it("excepts an exact reasoned row in a migrated scope", () => {
    const result = check({
      ...files,
      [enforcementFile]: enforcement({
        migrated: migrate("GO_FILE_WORD", "chat"),
        exceptions: [
          { ...wordFinding, reason: "Fixture", removal: "Rename the file" },
        ],
        ceilings: { GO_FILE_WORD: { task: 1 } },
      }),
    });
    expect(result.status, JSON.stringify(result.report)).toBe(0);
    expect(result.report.report.excepted).toEqual([
      {
        ...wordFinding,
        scope: "chat",
        reason: "Fixture",
        removal: "Rename the file",
      },
    ]);
  });

  it("rejects stale and unused exception rows", () => {
    const row = { reason: "Fixture", removal: "Rename the file" };
    const stale = check({
      [enforcementFile]: enforcement({
        migrated: migrate("GO_FILE_WORD", "chat"),
        exceptions: [{ ...wordFinding, ...row }],
      }),
    });
    denied(stale, "GO_EXCEPTION_STALE", enforcementFile);
    const unused = check({
      ...files,
      [enforcementFile]: enforcement({
        exceptions: [{ ...wordFinding, ...row }],
        ceilings: { GO_FILE_WORD: { chat: 1, task: 1 } },
      }),
    });
    denied(unused, "GO_EXCEPTION_STALE", enforcementFile);
  });

  it("refuses report growth past a ceiling", () => {
    const within = check({
      ...files,
      [enforcementFile]: enforcement({
        ceilings: { GO_FILE_WORD: { chat: 1, task: 1 } },
      }),
    });
    expect(within.status, JSON.stringify(within.report)).toBe(0);
    const grown = check({
      ...files,
      [enforcementFile]: enforcement({
        ceilings: { GO_FILE_WORD: { task: 1 } },
      }),
    });
    denied(grown, "GO_REPORT_CEILING", enforcementFile);
    expect(
      grown.report.violations.find(({ code }) => code === "GO_REPORT_CEILING")
        ?.detail,
    ).toBe(
      "GO_FILE_WORD chat: 1 findings exceed the ceiling 0; fix the new findings",
    );
  });

  it("refuses slack under a ceiling and ceilings on migrated scopes", () => {
    const stale = (
      ceilings: Record<string, Record<string, number>>,
      migrated = migrate("GO_FILE_WORD"),
    ) =>
      check({
        ...files,
        [enforcementFile]: enforcement({ migrated, ceilings }),
      }).report.violations.filter(({ code }) => code === "GO_CEILING_STALE");
    expect(stale({ GO_FILE_WORD: { chat: 1, task: 1 } })).toEqual([]);
    expect(stale({ GO_FILE_WORD: { chat: 2, task: 1 } })).toEqual([
      {
        code: "GO_CEILING_STALE",
        file: enforcementFile,
        detail:
          "GO_FILE_WORD chat: 1 findings are below the ceiling 2; lower the ceiling to 1 in this change",
      },
    ]);
    expect(
      stale({ GO_FILE_WORD: { chat: 1, task: 1 }, GO_DTO_ALIAS: { chat: 1 } }),
    ).toEqual([
      {
        code: "GO_CEILING_STALE",
        file: enforcementFile,
        detail:
          "GO_DTO_ALIAS chat: no report findings remain under the ceiling 1; delete the ceiling in this change",
      },
    ]);
    expect(
      stale(
        { GO_FILE_WORD: { chat: 1, task: 1 } },
        migrate("GO_FILE_WORD", "chat"),
      ).map(({ detail }) => detail),
    ).toEqual([
      "GO_FILE_WORD chat: no report findings remain under the ceiling 1; delete the ceiling in this change",
    ]);
  });

  it("cannot migrate away an existing blocking rule", () => {
    const file = "modules/chat/app/services/turn/read.go";
    const result = check({
      [file]: 'package turn\nimport _ "os"\n',
      [enforcementFile]: enforcement(),
    });
    denied(result, "GO_PURE_IMPORT", file);
  });

  const row = { code: "GO_FILE_WORD", file: "a.go", detail: "x" };
  it.each([
    ["envelope", null],
    ["version", JSON.parse(enforcement({ version: 1 }))],
    ["source", JSON.parse(enforcement({ source: "main" }))],
    ["extra key", { ...JSON.parse(enforcement()), baseline: [] }],
    [
      "unknown scope",
      JSON.parse(enforcement({ migrated: migrate("GO_FILE_WORD", "apps") })),
    ],
    [
      "unsorted scopes",
      JSON.parse(
        enforcement({ migrated: migrate("GO_FILE_WORD", "task", "chat") }),
      ),
    ],
    [
      "missing rule",
      JSON.parse(enforcement({ migrated: { GO_FILE_WORD: [] } })),
    ],
    [
      "blocking rule",
      JSON.parse(enforcement({ migrated: migrate("GO_PURE_IMPORT", "chat") })),
    ],
    [
      "zero ceiling",
      JSON.parse(enforcement({ ceilings: { GO_FILE_WORD: { chat: 0 } } })),
    ],
    [
      "blocking ceiling",
      JSON.parse(enforcement({ ceilings: { GO_PURE_IMPORT: { chat: 1 } } })),
    ],
    [
      "blocking exception",
      JSON.parse(
        enforcement({
          exceptions: [
            { ...row, code: "GO_PURE_IMPORT", reason: "r", removal: "r" },
          ],
        }),
      ),
    ],
    [
      "reasonless exception",
      JSON.parse(
        enforcement({ exceptions: [{ ...row, reason: " ", removal: "r" }] }),
      ),
    ],
    [
      "wildcard exception",
      JSON.parse(
        enforcement({
          exceptions: [
            { ...row, file: "modules/**", reason: "r", removal: "r" },
          ],
        }),
      ),
    ],
    [
      "duplicate exception",
      JSON.parse(
        enforcement({
          exceptions: [
            { ...row, reason: "r", removal: "r" },
            { ...row, reason: "r", removal: "r" },
          ],
        }),
      ),
    ],
  ])("rejects an invalid enforcement file: %s", (_name, envelope) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "farol-go-enforcement-"),
    );
    try {
      fs.mkdirSync(path.join(directory, "tooling"));
      fs.writeFileSync(
        path.join(directory, enforcementFile),
        JSON.stringify(envelope),
      );
      const result = spawnSync(
        process.execPath,
        [checker, "--root", directory, "--json"],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Invalid Go architecture enforcement");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

// Each ADR-0002 migration rule: a violation fixture reports exactly the
// expected finding and a conforming fixture reports none of that code. These
// are lexical source fixtures, not compilation or runtime evidence.
function reportsOf(files: Record<string, string>, code: string) {
  const result = check(files);
  expect(result.status, JSON.stringify(result.report)).toBe(0);
  return plain(result.report.report.findings).filter(
    (finding) => finding.code === code,
  );
}
const turn = "modules/chat/domain/turn";
const service = "modules/chat/app/services/turn";
const behavior = 'package turn\nfunc Valid(s string) bool { return s != "" }\n';

describe("ADR-0002 migration rules", () => {
  it("GO_PACKAGE_NAME admits the ADR-0002 words", () => {
    for (const word of ["budget", "peer", "settings", "failure", "selftest"])
      expect(
        reportsOf(
          { [`modules/chat/domain/${word}/policy.go`]: `package ${word}\n` },
          "GO_PACKAGE_NAME",
        ),
      ).toEqual(
        word === "selftest"
          ? [
              {
                code: "GO_PACKAGE_NAME",
                file: "modules/chat/domain/selftest",
                detail:
                  "Package name outside the admitted vocabulary: selftest",
              },
            ]
          : [],
      );
  });

  it("GO_PACKAGE_DIR requires the clause to equal the directory", () => {
    expect(
      reportsOf({ [`${turn}/policy.go`]: "package turn\n" }, "GO_PACKAGE_DIR"),
    ).toEqual([]);
    expect(
      reportsOf({ "cmd/farol/main.go": "package main\n" }, "GO_PACKAGE_DIR"),
    ).toEqual([]);
    expect(
      reportsOf({ [`${turn}/policy.go`]: "package state\n" }, "GO_PACKAGE_DIR"),
    ).toEqual([
      {
        code: "GO_PACKAGE_DIR",
        file: turn,
        detail: "Package clause state must equal turn",
      },
    ]);
    expect(
      reportsOf({ "cmd/farol/main.go": "package farol\n" }, "GO_PACKAGE_DIR"),
    ).toEqual([
      {
        code: "GO_PACKAGE_DIR",
        file: "cmd/farol",
        detail: "Package clause farol must equal main",
      },
    ]);
  });

  it("GO_FILE_WORD checks the stem against the shared vocabulary", () => {
    expect(
      reportsOf(
        {
          [`${turn}/policy.go`]: "package turn\n",
          [`${turn}/policy_darwin.go`]: "package turn\n",
          [`${turn}/turn_linux_arm64.go`]: "package turn\n",
          [`${turn}/common.go`]: "package turn\n",
        },
        "GO_FILE_WORD",
      ),
    ).toEqual([]);
    expect(
      reportsOf(
        {
          [`${turn}/turnpolicy.go`]: "package turn\n",
          [`${turn}/policydarwin_darwin.go`]: "package turn\n",
        },
        "GO_FILE_WORD",
      ),
    ).toEqual([
      {
        code: "GO_FILE_WORD",
        file: `${turn}/policydarwin_darwin.go`,
        detail: "File name outside the admitted vocabulary: policydarwin",
      },
      {
        code: "GO_FILE_WORD",
        file: `${turn}/turnpolicy.go`,
        detail: "File name outside the admitted vocabulary: turnpolicy",
      },
    ]);
  });

  it("GO_TEST_ORPHAN pairs tests with sources, platform suffix included", () => {
    expect(
      reportsOf(
        {
          [`${turn}/policy.go`]: "package turn\n",
          [`${turn}/policy_test.go`]: "package turn\n",
          [`${turn}/turn_test.go`]: "package turn\n",
          [`${turn}/state_darwin.go`]: "package turn\n",
          [`${turn}/state_darwin_test.go`]: "package turn\n",
        },
        "GO_TEST_ORPHAN",
      ),
    ).toEqual([]);
    expect(
      reportsOf(
        {
          [`${turn}/policy.go`]: "package turn\n",
          [`${turn}/policy_darwin_test.go`]: "package turn\n",
          [`${turn}/native_test.go`]: "package turn\n",
          [`${turn}/turn_darwin_test.go`]: "package turn\n",
        },
        "GO_TEST_ORPHAN",
      ),
    ).toEqual([
      {
        code: "GO_TEST_ORPHAN",
        file: `${turn}/native_test.go`,
        detail: "No native.go beside this test",
      },
      {
        code: "GO_TEST_ORPHAN",
        file: `${turn}/policy_darwin_test.go`,
        detail: "No policy_darwin.go beside this test",
      },
      {
        code: "GO_TEST_ORPHAN",
        file: `${turn}/turn_darwin_test.go`,
        detail: "No turn_darwin.go beside this test",
      },
    ]);
  });

  it("GO_TEST_MISSING requires a test only for files with behavior", () => {
    const declarations = {
      [`${service}/doc.go`]: "// Package turn is a fixture.\npackage turn\n",
      [`${service}/port.go`]:
        'package turn\nimport "context"\ntype Store interface {\n\tLoad(ctx context.Context, id string) (string, error)\n}\ntype Handler func(context.Context) error\n',
      [`${service}/errors.go`]:
        'package turn\nimport "errors"\nvar ErrMissing = errors.New("missing")\n',
      [`${service}/state.go`]:
        "package turn\ntype State struct {\n\tName string\n\tNext func() error\n}\n",
      [`${service}/service.go`]:
        "package turn\ntype Service struct{ store Store }\nfunc NewService(store Store) *Service {\n\treturn &Service{\n\t\tstore: store,\n\t}\n}\n",
      [`${service}/code.go`]:
        'package turn\ntype Code string\nfunc (c Code) Error() string { return string(c) }\nfunc (c Code) String() string {\n\treturn "code:" + string(c)\n}\n',
      [`${service}/cause.go`]:
        "package turn\ntype Cause struct{ err error }\nfunc (c *Cause) Unwrap() error { return c.err }\n",
      [`${service}/policy.go`]: behavior,
      [`${service}/policy_test.go`]: "package turn\n",
      "cmd/farol/main.go": "package main\nfunc main() { run() }\n",
    };
    expect(reportsOf(declarations, "GO_TEST_MISSING")).toEqual([]);
    const behaviors = {
      [`${turn}/valid.go`]: behavior,
      [`${turn}/build.go`]:
        "package turn\nfunc NewService() *Service {\n\ts := &Service{}\n\treturn s\n}\n",
      [`${turn}/name.go`]:
        'package turn\nfunc (c Code) String() string {\n\tswitch c {\n\tcase "":\n\t\treturn "empty"\n\t}\n\treturn string(c)\n}\n',
      [`${turn}/accessor.go`]:
        'package turn\nfunc (c Code) Retry() string { return "never" }\n',
      [`${turn}/hook.go`]:
        "package turn\nvar hook = func() error { return nil }\n",
      [`${turn}/start.go`]: "package turn\nfunc init() {}\n",
      [`${turn}/wrap.go`]:
        "package turn\nfunc NewHandler() Handler { return func() error { return nil } }\n",
      [`${turn}/probe_darwin.go`]: behavior,
      [`${turn}/probe_test.go`]: "package turn\n",
    };
    expect(
      reportsOf(behaviors, "GO_TEST_MISSING")
        .map(({ file }) => path.posix.basename(file))
        .sort(),
    ).toEqual([
      "accessor.go",
      "build.go",
      "hook.go",
      "name.go",
      "probe_darwin.go",
      "start.go",
      "valid.go",
      "wrap.go",
    ]);
    expect(
      reportsOf({ [`${turn}/probe_darwin.go`]: behavior }, "GO_TEST_MISSING"),
    ).toEqual([
      {
        code: "GO_TEST_MISSING",
        file: `${turn}/probe_darwin.go`,
        detail: "Behavior without probe_darwin_test.go",
      },
    ]);
  });

  it("GO_BOOT_TEST rejects boot tests and test data", () => {
    expect(
      reportsOf({ "boot/boot.go": "package boot\n" }, "GO_BOOT_TEST"),
    ).toEqual([]);
    expect(
      reportsOf(
        {
          "boot/boot.go": "package boot\n",
          "boot/boot_test.go": "package boot\n",
          "boot/testdata/source.json": "{}\n",
        },
        "GO_BOOT_TEST",
      ),
    ).toEqual([
      {
        code: "GO_BOOT_TEST",
        file: "boot/boot_test.go",
        detail: "Boot has no tests; whole-graph tests live under tests/",
      },
      {
        code: "GO_BOOT_TEST",
        file: "boot/testdata",
        detail: "Boot has no test data",
      },
    ]);
  });

  it("GO_BOOT_FILE admits boot.go plus one file per module", () => {
    const valid = Object.fromEntries(
      ["boot", "computer", "task", "chat", "release"].map((stem) => [
        `boot/${stem}.go`,
        "package boot\n",
      ]),
    );
    expect(reportsOf(valid, "GO_BOOT_FILE")).toEqual([]);
    const set = "boot.go, chat.go, computer.go, release.go, task.go";
    expect(
      reportsOf(
        {
          "boot/wiring.go": "package boot\n",
          "boot/chat_darwin.go": "package boot\n",
          "boot/container/container.go": "package container\n",
        },
        "GO_BOOT_FILE",
      ),
    ).toEqual([
      {
        code: "GO_BOOT_FILE",
        file: "boot/chat_darwin.go",
        detail: `Boot holds only ${set}`,
      },
      {
        code: "GO_BOOT_FILE",
        file: "boot/container/container.go",
        detail: "Boot has no subpackages",
      },
      {
        code: "GO_BOOT_FILE",
        file: "boot/wiring.go",
        detail: `Boot holds only ${set}`,
      },
    ]);
  });

  it("GO_BOOT_LOGIC allows composition and error returns only", () => {
    const composition = `package boot
import "errors"
type chatModule struct{ root string }
func (m *chatModule) service() (*Service, error) {
\tstore, err := open(m.root)
\tif err != nil {
\t\treturn nil, err
\t}
\tif err := store.Check(); err != nil {
\t\treturn nil, errors.Join(err)
\t}
\treturn NewService(store), nil
}
`;
    expect(reportsOf({ "boot/chat.go": composition }, "GO_BOOT_LOGIC")).toEqual(
      [],
    );
    const logic = `package boot
type chatModule struct{}
type helper struct{}
func run(modes []string, ch chan int) {
\tfor _, mode := range modes {
\t\tswitch mode {
\t\tcase "serve":
\t\t\tgo serve()
\t\t}
\t}
\tselect {
\tcase <-ch:
\t}
\tif len(modes) == 0 {
\t\treturn
\t}
}
`;
    expect(
      reportsOf({ "boot/chat.go": logic }, "GO_BOOT_LOGIC").map(
        ({ detail }) => detail,
      ),
    ).toEqual([
      "conditions other than err != nil: 1",
      "for statements: 1",
      "go statements: 1",
      "select statements: 1",
      "switch statements: 1",
      "top-level types: 2; at most one namespace type",
    ]);
    expect(
      reportsOf(
        { "boot/task.go": "package boot\n" + "// line\n".repeat(400) },
        "GO_BOOT_LOGIC",
      ).map(({ detail }) => detail),
    ).toEqual(["lines: 401; budget 400"]);
    const compound = `package boot
type taskModule struct{}
func (m *taskModule) open(ok bool) error {
\tif v, err := load(); err != nil {
\t\treturn err
\t}
\tif ok || err != nil {
\t\treturn nil
\t}
\tif err != nil && ok {
\t\treturn nil
\t}
\tif err := load(a || b); err != nil {
\t\treturn err
\t}
\tif v.ok; err != nil {
\t\treturn err
\t}
\treturn nil
}
`;
    expect(
      reportsOf({ "boot/task.go": compound }, "GO_BOOT_LOGIC").map(
        ({ detail }) => detail,
      ),
    ).toEqual(["conditions other than err != nil: 4"]);
  });

  it("GO_OPERATION_SHAPE: Command or Query in, Result out", () => {
    const valid = `package turn
import "context"
type CreateCommand struct{ Name string }
type CreateResult struct{ ID string }
func (s *Service) Create(ctx context.Context, cmd CreateCommand) (*CreateResult, error) {
\treturn nil, nil
}
type ListQuery struct{}
type ListResult struct{}
func (s *Service) List(_ context.Context, q ListQuery) (*ListResult, error) { return nil, nil }
func (s *Service) close(id string) error { return nil }
func (r *Runner) Run(id string) error { return nil }
`;
    expect(
      reportsOf(
        {
          [`${service}/create.go`]: valid,
          "modules/chat/app/capabilities/guard/guard.go":
            "package guard\nfunc (g *Service) Admit(id string) error { return nil }\n",
          "modules/chat/contracts/turn/create.go":
            "package turn\ntype CreateRequest struct{}\ntype CreateResponse struct{}\n",
        },
        "GO_OPERATION_SHAPE",
      ),
    ).toEqual([]);
    const invalid = `package turn
import "context"
type ApproveRequest struct{}
func (s *Service) Approve(ctx context.Context, id string, revision uint64) error {
\treturn nil
}
func (s Service) Read(ctx context.Context, q ReadQuery) (ReadResult, error) { return ReadResult{}, nil }
func (s *Service) Write(ctx context.Context, cmd SaveCommand) (*SaveResult, error) { return nil, nil }
`;
    expect(
      reportsOf(
        {
          [`${service}/approve.go`]: invalid,
          "modules/chat/contracts/turn/create.go":
            "package turn\ntype (\n\tCreateCommand struct{}\n\tcreateQuery struct{}\n)\n",
        },
        "GO_OPERATION_SHAPE",
      ).map(({ detail }) => detail),
    ).toEqual([
      "Application type ApproveRequest uses a wire suffix; use Command, Query or Result",
      "Service.Approve must take (context.Context, ApproveCommand or ApproveQuery) and return (*ApproveResult, error)",
      "Service.Read must take (context.Context, ReadCommand or ReadQuery) and return (*ReadResult, error)",
      "Service.Write must take (context.Context, WriteCommand or WriteQuery) and return (*WriteResult, error)",
      "Contract type CreateCommand uses an application suffix; use Request or Response",
    ]);
  });
});

it("excludes only registered ignored child worktrees while retaining parent and unregistered checks", () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "farol-go-worktree-boundary-")),
  );
  const git = (...args: string[]) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-C",
        directory,
        ...args,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
  };
  try {
    git("init", "-q");
    fs.writeFileSync(path.join(directory, "go.mod"), moduleFile);
    fs.writeFileSync(
      path.join(directory, ".gitignore"),
      ".claude/worktrees/\n",
    );
    git("add", ".");
    git("commit", "-qm", "fixture root");
    const child = path.join(directory, ".claude/worktrees/worker");
    git("worktree", "add", "--detach", child, "HEAD");
    const unregistered = path.join(directory, ".claude/worktrees/unregistered");
    fs.mkdirSync(unregistered, { recursive: true });
    fs.writeFileSync(
      path.join(unregistered, "go.mod"),
      "module unregistered\n",
    );
    const bad = "modules/computer/domain/policy/policy.go";
    for (const root of [directory, child]) {
      fs.mkdirSync(path.dirname(path.join(root, bad)), { recursive: true });
      fs.writeFileSync(path.join(root, bad), source("os"));
    }
    const result = spawnSync(
      process.execPath,
      [checker, "--root", directory, "--json"],
      { encoding: "utf8" },
    );
    const report = JSON.parse(result.stdout) as Report;
    expect(result.status).toBe(1);
    expect(report.violations.some((f) => f.file === bad)).toBe(true);
    expect(
      report.violations.some(
        (f) =>
          f.file === ".claude/worktrees/unregistered/go.mod" &&
          f.code === "GO_NESTED_MODULE",
      ),
    ).toBe(true);
    expect(
      report.violations.some((f) =>
        f.file.startsWith(".claude/worktrees/worker/"),
      ),
    ).toBe(false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
