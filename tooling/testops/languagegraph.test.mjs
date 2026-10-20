import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { focusedGoCounts } from "./affected-focused.mjs";
import {
  typescriptGraph,
  dynamicLoads,
  goGraph,
  goRuntimeGraph,
  goRuntimePatterns,
  jsonObjects,
  snapshot,
} from "./languagegraph.mjs";

const focusedPolicy = JSON.parse(
  fs.readFileSync(
    new URL("./affected-go-policy.json", import.meta.url),
    "utf8",
  ),
);
const eventStream = (rows) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
function focusedEvents(packages = focusedPolicy.packages) {
  return packages.flatMap((row) => [
    { Action: "start", Package: row.path },
    ...row.topLevelTests.flatMap((Test) => [
      { Action: "run", Package: row.path, Test },
      { Action: "pass", Package: row.path, Test },
    ]),
    { Action: "pass", Package: row.path },
  ]);
}

test("focused Go policy matches all six audited source files and 66 authored top-level tests", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  assert.equal(focusedPolicy.packages.length, 4);
  for (const row of focusedPolicy.packages) {
    const declarations = row.files
      .flatMap((file) => {
        const text = fs.readFileSync(path.join(root, file), "utf8");
        assert.doesNotMatch(text, /^func TestMain\(/mu);
        return [...text.matchAll(/^func (Test\w+)\(t \*testing\.T\)/gmu)].map(
          (match) => match[1],
        );
      })
      .sort();
    assert.deepEqual(declarations, row.topLevelTests);
  }
  assert.equal(focusedPolicy.packages.flatMap((row) => row.files).length, 6);
  assert.equal(
    focusedPolicy.packages.flatMap((row) => row.topLevelTests).length,
    66,
  );
});

test("focused Go accounting requires exact audited package and top-level membership", () => {
  const names = focusedPolicy.packages.map((row) => row.path);
  const rows = focusedEvents();
  const counts = focusedGoCounts(eventStream(rows), names);
  assert.equal(counts.total, 66);
  assert.equal(counts.topLevelTests, 66);
  assert.equal(counts.packages, 4);
  assert.equal(counts.reportedSuccess, true);
  assert.equal(counts.caseMembership.length, 66);
  for (const required of [[], names.concat(names[0]), ["unqualified/package"]])
    assert.throws(
      () => focusedGoCounts(eventStream(rows), required),
      /PACKAGES_UNQUALIFIED/u,
    );
  assert.throws(
    () => focusedGoCounts(eventStream(rows), names.slice(1)),
    /UNEXPECTED/u,
  );
  const missing = rows.filter(
    (row) => row.Test !== focusedPolicy.packages[0].topLevelTests[0],
  );
  assert.throws(
    () => focusedGoCounts(eventStream(missing), names),
    /MEMBERSHIP/u,
  );
  const extra = structuredClone(rows);
  extra.splice(
    1,
    0,
    { Action: "run", Package: names[0], Test: "TestAddedWithoutAdmission" },
    { Action: "pass", Package: names[0], Test: "TestAddedWithoutAdmission" },
  );
  assert.throws(
    () => focusedGoCounts(eventStream(extra), names),
    /MEMBERSHIP/u,
  );
});

test("focused Go accounting retains every nested subtest and fails on skips or failures", () => {
  const owned = focusedPolicy.packages[1];
  const rows = focusedEvents([owned]);
  const child = owned.topLevelTests[0] + "/unicode_λ";
  rows.splice(
    2,
    0,
    { Action: "run", Package: owned.path, Test: child },
    { Action: "pause", Package: owned.path, Test: child },
    { Action: "cont", Package: owned.path, Test: child },
    { Action: "pass", Package: owned.path, Test: child },
  );
  const counts = focusedGoCounts(eventStream(rows), [owned.path]);
  assert.equal(counts.total, owned.topLevelTests.length + 1);
  assert.equal(counts.reportedSuccess, true);
  for (const Action of ["skip", "fail"]) {
    const changed = rows.map((row) =>
      row.Test === child && row.Action === "pass" ? { ...row, Action } : row,
    );
    const result = focusedGoCounts(eventStream(changed), [owned.path]);
    assert.equal(result.reportedSuccess, false);
    assert.equal(
      result.caseMembership.find((row) => row.test === child).status,
      Action,
    );
  }
});

test("focused Go accounting accepts slash-containing labels without inventing intermediate run events", () => {
  const owned = focusedPolicy.packages.find((row) =>
    row.dir.endsWith("/planruntime"),
  );
  const parent = "TestRuntimeWithdrawalAcrossOriginalIOAndFinalPublication";
  const rows = focusedEvents([owned]);
  const index = rows.findIndex(
    (row) => row.Test === parent && row.Action === "run",
  );
  const children = ["reserve", "credentials", "http", "settle"].flatMap(
    (point) =>
      ["source", "omitted_original", "account", "estimate_expiry"].flatMap(
        (kind) => [
          {
            Action: "run",
            Package: owned.path,
            Test: parent + "/" + point + "/" + kind,
          },
          {
            Action: "pass",
            Package: owned.path,
            Test: parent + "/" + point + "/" + kind,
          },
        ],
      ),
  );
  rows.splice(index + 1, 0, ...children);
  const counts = focusedGoCounts(eventStream(rows), [owned.path]);
  assert.equal(counts.reportedSuccess, true);
  assert.equal(counts.total, owned.topLevelTests.length + 16);
  assert.equal(
    counts.caseMembership.filter((row) => row.test.startsWith(parent + "/"))
      .length,
    16,
  );
  const late = focusedEvents([owned]);
  late.splice(late.length - 1, 0, ...children.slice(0, 2));
  assert.throws(
    () => focusedGoCounts(eventStream(late), [owned.path]),
    /PARENT_RUN_REQUIRED/u,
  );
});

test("focused Go accounting refuses missing starts, runs, terminals, parents and late events", () => {
  const owned = focusedPolicy.packages[1];
  const rows = focusedEvents([owned]);
  const input = eventStream(rows);
  assert.throws(
    () => focusedGoCounts(input.trimEnd(), [owned.path]),
    /STREAM_INCOMPLETE/u,
  );
  assert.throws(
    () => focusedGoCounts(eventStream(rows.slice(1)), [owned.path]),
    /START_REQUIRED/u,
  );
  assert.throws(
    () => focusedGoCounts(eventStream(rows.slice(0, -1)), [owned.path]),
    /TERMINAL_REQUIRED/u,
  );
  assert.throws(
    () =>
      focusedGoCounts(eventStream([rows[0], ...rows.slice(2)]), [owned.path]),
    /RUN_REQUIRED/u,
  );
  assert.throws(
    () =>
      focusedGoCounts(eventStream([rows[0], rows[0], ...rows.slice(1)]), [
        owned.path,
      ]),
    /START_DUPLICATE/u,
  );
  assert.throws(
    () =>
      focusedGoCounts(eventStream([rows[0], rows[1], ...rows.slice(1)]), [
        owned.path,
      ]),
    /RUN_DUPLICATE/u,
  );
  assert.throws(
    () =>
      focusedGoCounts(
        eventStream([rows[0], rows[1], rows[2], ...rows.slice(2)]),
        [owned.path],
      ),
    /CASE_INVALID_OR_LATE/u,
  );
  assert.throws(
    () => focusedGoCounts(eventStream(rows.concat(rows.at(-1))), [owned.path]),
    /UNEXPECTED_OR_LATE/u,
  );
  const unfinished = [rows[0], rows[1], ...rows.slice(3)];
  assert.throws(
    () => focusedGoCounts(eventStream(unfinished), [owned.path]),
    /CASE_TERMINAL_REQUIRED/u,
  );
  const orphan = [
    rows[0],
    { Action: "run", Package: owned.path, Test: "TestMissing/child" },
    ...rows.slice(1),
  ];
  assert.throws(
    () => focusedGoCounts(eventStream(orphan), [owned.path]),
    /PARENT_RUN_REQUIRED/u,
  );
  const unknown = [
    rows[0],
    { Action: "unknown", Package: owned.path },
    ...rows.slice(1),
  ];
  assert.throws(
    () => focusedGoCounts(eventStream(unknown), [owned.path]),
    /ACTION_UNQUALIFIED/u,
  );
});

test("runtime package discovery uses source-owned directories and respects nested modules", () => {
  const digest = "a".repeat(64);
  const files = {
    "go.mod": digest,
    "main.go": digest,
    "modules/chat/policy.go": digest,
    "modules/chat/policy_test.go": digest,
    "deleted/old.go": null,
    "resources/native/go/go.mod": digest,
    "resources/native/go/policy.go": digest,
    "resources/native/go/child/native_test.go": digest,
  };
  assert.deepEqual(goRuntimePatterns({ files }, "go.mod"), [
    ".",
    "./modules/chat",
  ]);
  assert.deepEqual(goRuntimePatterns({ files }, "resources/native/go/go.mod"), [
    ".",
    "./child",
  ]);
  for (const file of [
    "../escape.go",
    "/absolute.go",
    "a/../escape.go",
    "a\\escape.go",
  ])
    assert.throws(
      () =>
        goRuntimePatterns({ files: { ...files, [file]: digest } }, "go.mod"),
      /SOURCE_PATH_UNQUALIFIED/u,
    );
  assert.throws(
    () => goRuntimePatterns({ files: { "go.mod": digest } }, "go.mod"),
    /PACKAGES_EMPTY/u,
  );
  assert.throws(
    () => goRuntimePatterns({ files }, "constructor"),
    /MODULE_UNQUALIFIED/u,
  );
});

function runtimeFixture(action) {
  const files = {
    "go.mod": "module github.com/legrch/farol\n\ngo 1.26.2\n",
    "modules/chat/domain/contextbudget/policy.go": "package contextbudget\n",
    "modules/chat/domain/contextbudget/policy_test.go":
      "package contextbudget\n",
    "modules/chat/domain/contextbudget/platform_darwin_test.go":
      "package contextbudget\n",
    "modules/chat/domain/contextbudget/schema.json": '{"version":1}\n',
  };
  fixture(files, (root) => {
    const source = {
      files: Object.fromEntries(
        Object.entries(files).map(([name, bytes]) => [
          name,
          createHash("sha256").update(bytes).digest("hex"),
        ]),
      ),
    };
    const record = {
      ImportPath: "github.com/legrch/farol/modules/chat/domain/contextbudget",
      Dir: path.join(root, "modules/chat/domain/contextbudget"),
      Module: {
        Path: "github.com/legrch/farol",
        Main: true,
        GoMod: path.join(root, "go.mod"),
      },
      GoFiles: ["policy.go"],
      TestGoFiles: ["policy_test.go"],
      IgnoredGoFiles: ["platform_darwin_test.go"],
      EmbedFiles: ["schema.json"],
    };
    action(root, source, record);
  });
}

test("default race membership records ignored native files without executing or unioning them", () => {
  runtimeFixture((root, source, record) => {
    const result = goRuntimeGraph([record], root, source, "go.mod");
    assert.deepEqual(result.gaps, []);
    assert.deepEqual(result.packages[0].testFiles, [
      "modules/chat/domain/contextbudget/policy_test.go",
    ]);
    assert.deepEqual(result.packages[0].ignoredFiles, [
      "modules/chat/domain/contextbudget/platform_darwin_test.go",
    ]);
    assert.equal(
      result.packages[0].files.includes(result.packages[0].ignoredFiles[0]),
      false,
    );
    assert.equal(result.packages[0].inputs.length, 4);
    assert.equal(
      result.packages[0].inputs.find((item) =>
        item.path.endsWith("schema.json"),
      ).sha256,
      source.files["modules/chat/domain/contextbudget/schema.json"],
    );
  });
});

test("default race input drift, missing provenance and source redirects refuse", () => {
  runtimeFixture((root, source, record) => {
    const file = "modules/chat/domain/contextbudget/policy_test.go";
    assert.throws(
      () => goRuntimeGraph([record], root, { files: {} }, "go.mod"),
      /INPUT_UNBOUND/u,
    );
    assert.throws(
      () =>
        goRuntimeGraph(
          [record],
          root,
          { files: { ...source.files, [file]: "0".repeat(64) } },
          "go.mod",
        ),
      /INPUT_CHANGED/u,
    );
    assert.throws(
      () =>
        goRuntimeGraph(
          [{ ...record, TestGoFiles: ["../../outside_test.go"] }],
          root,
          source,
          "go.mod",
        ),
      /INPUT_PATH_REFUSED/u,
    );
    fs.unlinkSync(path.join(root, file));
    fs.symlinkSync(
      path.join(root, "modules/chat/domain/contextbudget/policy.go"),
      path.join(root, file),
    );
    assert.throws(
      () => goRuntimeGraph([record], root, source, "go.mod"),
      /INPUT_REDIRECT/u,
    );
  });
});

test("default race context rejects foreign modules, duplicate packages and synthetic test packages", () => {
  runtimeFixture((root, source, record) => {
    for (const field of ["other/go.mod", "constructor", "__proto__"])
      assert.throws(
        () => goRuntimeGraph([record], root, source, field),
        /MODULE_UNQUALIFIED/u,
      );
    assert.throws(
      () => goRuntimeGraph([record, record], root, source, "go.mod"),
      /DUPLICATE_OR_MISMATCH/u,
    );
    for (const extra of [
      { ForTest: record.ImportPath },
      { Module: { ...record.Module, Main: false } },
      { Module: { ...record.Module, Path: "example.invalid/foreign" } },
      { ImportPath: "unsafe" },
      { Dir: root },
    ])
      assert.throws(
        () => goRuntimeGraph([{ ...record, ...extra }], root, source, "go.mod"),
        /PACKAGE_/u,
      );
  });
});

test("incomplete, CGO and contradictory default metadata stay explicit non-execution gaps", () => {
  runtimeFixture((root, source, record) => {
    assert.equal(
      goRuntimeGraph([{ ...record, Incomplete: true }], root, source, "go.mod")
        .gaps[0].reason,
      "GO_RUNTIME_METADATA_INCOMPLETE",
    );
    assert.equal(
      goRuntimeGraph(
        [{ ...record, CgoFiles: ["policy.go"] }],
        root,
        source,
        "go.mod",
      ).gaps[0].reason,
      "GO_RUNTIME_CGO_OR_SWIG_UNQUALIFIED",
    );
    for (const extra of [
      { XTestGoFiles: ["policy_test.go"] },
      { TestGoFiles: ["policy.go"] },
      { IgnoredGoFiles: ["policy_test.go"] },
      { IgnoredGoFiles: ["policy.go"] },
      { GoFiles: "policy.go" },
    ])
      assert.throws(
        () => goRuntimeGraph([{ ...record, ...extra }], root, source, "go.mod"),
        /MEMBERSHIP_INVALID|COLLISION|FILE_LIST_INVALID/u,
      );
  });
});

test("runtime metadata CLI requires an explicit qualified context and all Go inputs before collection", () => {
  for (const [args, reason] of [
    [["--go-runtime", "linux-arm64-race"], "GRAPH_GO_OPTIONS_INCOMPLETE"],
    [
      [
        "--go",
        "/not-a-tool",
        "--go-sha256",
        "0".repeat(64),
        "--cache",
        "/not-a-cache",
        "--go-runtime",
        "arbitrary",
      ],
      "GRAPH_GO_RUNTIME_CONTEXT_UNQUALIFIED",
    ],
  ]) {
    let failure;
    try {
      execFileSync(
        process.execPath,
        [path.join(import.meta.dirname, "languagegraph.mjs"), ...args],
        {
          encoding: "utf8",
          timeout: 10000,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            PATH: path.dirname(process.execPath) + ":/usr/bin:/bin",
            HOME: "/var/empty",
            GOENV: "off",
            GOTOOLCHAIN: "local",
          },
        },
      );
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.status, 2);
    const report = JSON.parse(failure.stdout);
    assert.equal(report.status, "BLOCKED");
    assert.equal(report.reason, reason);
    assert.equal(report.acceptance, false);
  }
});

test("literal CommonJS consumers remain in the actual compiler-backed plan", () => {
  for (const load of [
    'require("./a.test")',
    'require?.("./a.test")',
    'module["require"]("./a.test")',
    'module?.require?.("./a.test")',
    '(0, require)("./a.test")',
    '(() => { const load = require; return load("./a.test"); })()',
    '(() => { const { ["require"]: load } = module; return load("./a.test"); })()',
  ])
    fixture(
      {
        ".gitignore": "_output/\n",
        "tsconfig.json": configuration,
        "tests/a.test.ts": "export const a=1;\n",
        "tests/consumer.test.ts": `const a = ${load}; console.log(a);\n`,
        "tests/unrelated.test.ts": "export const other=1;\n",
      },
      (root) => {
        const env = {
          PATH: "/usr/bin:/bin",
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
        };
        const git = (...args) =>
          execFileSync(
            "git",
            [
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "user.name=Fixture",
              "-c",
              "user.email=fixture@example.invalid",
              ...args,
            ],
            { cwd: root, env, stdio: "pipe" },
          );
        git("init", "-q");
        git("add", ".");
        git("commit", "--no-gpg-sign", "-qm", "fixture");
        fs.appendFileSync(
          path.join(root, "tests/a.test.ts"),
          "// changed iteration input\n",
        );
        const metadata = {
          schema: 1,
          kind: "compiler-graph-plan-input",
          acceptance: false,
          executionAllowed: false,
          source: snapshot(root),
          typescript: typescriptGraph(root, ["tsconfig.json"]),
          go: null,
        };
        fs.mkdirSync(path.join(root, "_output"));
        const file = path.join(root, "_output/compiler.json");
        fs.writeFileSync(file, JSON.stringify(metadata));
        const output = execFileSync(
          "/usr/bin/python3",
          [
            "-B",
            path.join(import.meta.dirname, "testops.py"),
            "--root",
            root,
            "affected",
            "--base",
            "HEAD",
            "--compiler-metadata",
            file,
          ],
          {
            cwd: root,
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const plan = JSON.parse(output);
        assert.equal(plan.status, "PLAN_ONLY");
        assert.deepEqual(
          plan.selected.map((p) => p.path),
          ["tests/a.test.ts", "tests/consumer.test.ts"],
        );
        assert.equal(plan.executionAllowed, false);
      },
    );
});

test("Go object streams preserve quoted braces and refuse truncation", () => {
  assert.deepEqual(jsonObjects('{"text":"a}\\\"b{"}\n{"nested":{"x":1}}\n'), [
    { text: 'a}"b{' },
    { nested: { x: 1 } },
  ]);
  for (const text of ["", '{"x":', "[{}]", "{} garbage"])
    assert.throws(() => jsonObjects(text));
});

function fixture(files, run) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "testops-language-")),
  );
  try {
    for (const [name, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), contents);
    }
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const configuration = JSON.stringify({
  compilerOptions: {
    module: "ESNext",
    moduleResolution: "Bundler",
    noEmit: true,
    paths: { "@demo/*": ["./src/*"] },
  },
  include: ["src/**/*", "tests/**/*"],
});

test("actual pinned native compiler resolves alias, JS extension and re-export edges", () => {
  fixture(
    {
      "tsconfig.json": configuration,
      "src/value.ts": "export const value = 1;",
      "src/barrel.ts": 'export {value} from "./value.js";',
      "tests/value.test.ts":
        'import {value} from "@demo/barrel"; console.log(value);',
    },
    (root) => {
      const result = typescriptGraph(root, ["tsconfig.json"]);
      assert.deepEqual(
        result.edges.map((e) => [e.from, e.to]),
        [
          ["src/barrel.ts", "src/value.ts"],
          ["tests/value.test.ts", "src/barrel.ts"],
        ],
      );
      assert.deepEqual(result.gaps, []);
      assert.equal(Object.keys(result.inputHashes).length, 3);
    },
  );
});

test("project inheritance and two compiler configurations retain their own graph edges", () => {
  fixture(
    {
      "base.json": configuration,
      "tsconfig.json": '{"extends":"./base.json"}',
      "tsconfig.renderer.json":
        '{"extends":"./tsconfig.json","include":["src/**/*"]}',
      "src/value.ts": "export const value = 1;",
      "src/view.tsx":
        'import {value} from "@demo/value"; export const View=()=> <div>{value}</div>;',
    },
    (root) => {
      const result = typescriptGraph(root);
      assert.equal(
        result.edges.filter(
          (e) => e.from === "src/view.tsx" && e.to === "src/value.ts",
        ).length,
        2,
      );
      assert.deepEqual(
        result.configs.map((c) => c.file),
        ["tsconfig.json", "tsconfig.renderer.json"],
      );
    },
  );
});

test("unresolved static modules and dynamic loads remain explicit per-file gaps", () => {
  fixture(
    {
      "tsconfig.json": configuration,
      "src/use.ts":
        'import {x} from "@unknown/value"; export const result = import(target);',
    },
    (root) => {
      const result = typescriptGraph(root, ["tsconfig.json"]);
      assert.ok(
        result.gaps.some(
          (g) => g.file === "src/use.ts" && g.reason === "MODULE_UNRESOLVED",
        ),
      );
      assert.ok(
        result.gaps.some(
          (g) => g.file === "src/use.ts" && g.reason === "DYNAMIC_IMPORT",
        ),
      );
    },
  );
});

test("comments and strings are not load edges; opaque require and eval cannot narrow", () => {
  assert.deepEqual(
    dynamicLoads(
      '/* import(target) */ const text="require(target)"; import("./literal");',
    ),
    [],
  );
  assert.deepEqual(dynamicLoads('require(target); eval("synthetic");'), [
    "COMMONJS_LOAD",
    "DYNAMIC_LOAD",
  ]);
  assert.deepEqual(dynamicLoads("const syntax = ;"), ["PARSE_UNSUPPORTED"]);
  for (const code of [
    'require("./case.test");',
    'module.require("./case.test");',
    'require.resolve("./case.test");',
  ])
    assert.deepEqual(dynamicLoads(code), ["COMMONJS_LOAD"]);
  assert.deepEqual(
    dynamicLoads(
      'import {createRequire as load} from "node:module"; const requireHere = load(import.meta.url);',
    ),
    ["COMMONJS_FACTORY"],
  );
  assert.deepEqual(dynamicLoads('new Function("synthetic");'), [
    "DYNAMIC_LOAD",
  ]);
});

test("out-of-root source redirects are unavailable to compiler resolution", () => {
  fixture(
    {
      "tsconfig.json": configuration,
      "src/value.ts": 'export {x} from "./outside.js";',
    },
    (root) => {
      fs.symlinkSync("/etc/passwd", path.join(root, "src/outside.ts"));
      const result = typescriptGraph(root, ["tsconfig.json"]);
      assert.ok(
        result.gaps.some(
          (g) => g.file === "src/value.ts" && g.reason === "MODULE_UNRESOLVED",
        ),
      );
      assert.equal(result.inputHashes["src/outside.ts"], undefined);
    },
  );
});

test("Go metadata unions target-specific inputs, embeds and external-test imports", () => {
  fixture({ "pkg/a.go": "package pkg" }, (root) => {
    const records = [
      {
        ImportPath: "example.invalid/pkg",
        Dir: path.join(root, "pkg"),
        GoFiles: ["a.go"],
        TestGoFiles: ["a_test.go"],
        Imports: ["context"],
        TestImports: ["testing"],
        EmbedFiles: ["schema.json"],
      },
      {
        ImportPath: "example.invalid/pkg",
        Dir: path.join(root, "pkg"),
        GoFiles: ["darwin.go"],
        IgnoredGoFiles: ["linux.go"],
        XTestGoFiles: ["external_test.go"],
        XTestImports: ["example.invalid/peer"],
      },
    ];
    const result = goGraph(records, root);
    assert.equal(result.packages.length, 1);
    assert.deepEqual(result.packages[0].imports, [
      "context",
      "example.invalid/peer",
      "testing",
    ]);
    assert.deepEqual(result.packages[0].files, [
      "pkg/a.go",
      "pkg/a_test.go",
      "pkg/darwin.go",
      "pkg/external_test.go",
      "pkg/linux.go",
      "pkg/schema.json",
    ]);
    assert.deepEqual(result.gaps, []);
  });
});

test("incomplete Go metadata remains a gap; path escape and package collision refuse", () => {
  fixture({ "pkg/a.go": "package pkg" }, (root) => {
    const record = {
      ImportPath: "example.invalid/pkg",
      Dir: path.join(root, "pkg"),
      GoFiles: ["a.go"],
      Incomplete: true,
    };
    assert.equal(
      goGraph([record], root).gaps[0].reason,
      "GO_METADATA_INCOMPLETE",
    );
    assert.throws(
      () => goGraph([{ ...record, GoFiles: ["../../outside.go"] }], root),
      /GRAPH_GO_INPUT_ESCAPE/,
    );
    assert.throws(
      () => goGraph([record, { ...record, Dir: root }], root),
      /GRAPH_GO_PACKAGE_COLLISION/,
    );
  });
});
