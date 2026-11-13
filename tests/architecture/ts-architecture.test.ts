import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { describe, expect, it } from "vitest";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const checker = path.join(root, "tooling/check-architecture.mjs");

type Finding = { code: string; file: string; detail: string };
type Row = Finding & { amount?: number };
type Scoped = Row & { scope: string };

type Report = {
  ok: boolean;
  files: number;
  testFiles: number;
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

const enforcementFile = "tooling/ts-architecture-enforcement.json";
const enforcementSource = "5b490cdf765ad86cffe363d8106e39bbe6b1236f";
const migrationCodes = [
  "TS_LAYER_FOLDER",
  "TS_FOLDER_WORD",
  "TS_FILE_WORD",
  "TS_TEST_MISSING",
  "TS_TEST_ORPHAN",
  "TS_BOOT_TEST",
  "TS_BOOT_LOGIC",
  "TS_APP_MODULE_INTERNAL",
];
// The migration switch only grows. When an area migrates a rule, add the
// scope to the enforcement file AND here in the same pull request; removing a
// migrated scope from the file fails this floor.
const migratedFloor: Record<string, string[]> = {};

type Enforcement = {
  version: number;
  source: string;
  migrated: Record<string, string[]>;
  exceptions: (Finding & { reason: string; removal: string })[];
  baseline: Row[];
};
const enforcement = (overrides: Partial<Enforcement> = {}) =>
  JSON.stringify({
    version: 1,
    source: enforcementSource,
    migrated: Object.fromEntries(migrationCodes.map((code) => [code, []])),
    exceptions: [],
    baseline: [],
    ...overrides,
  });
const migrate = (code: string, ...scopes: string[]) => ({
  ...Object.fromEntries(migrationCodes.map((item) => [item, [] as string[]])),
  [code]: scopes,
});

// These are synthetic source trees, not compiler, bundler or test-runner
// evidence. Each runs the actual executable against a fresh root and returns
// the enforcement file the run leaves behind (the write option rewrites it).
function run(files: Record<string, string>, args: string[] = []) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "farol-ts-architecture-"),
  );
  try {
    for (const [name, text] of Object.entries(files)) {
      const destination = path.join(directory, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, text);
    }
    const result = spawnSync(
      process.execPath,
      [checker, "--root", directory, ...args],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    const written = path.join(directory, enforcementFile);
    const text = fs.existsSync(written)
      ? fs.readFileSync(written, "utf8")
      : null;
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      text,
      stored: text ? (JSON.parse(text) as Enforcement) : null,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function check(files: Record<string, string>) {
  const result = run(files, ["--json"]);
  expect(result.stderr).toBe("");
  return { status: result.status, report: JSON.parse(result.stdout) as Report };
}

const plain = (findings: Scoped[]) =>
  findings.map(({ scope: _scope, ...finding }) => finding);
const byKey = (a: Row, b: Row) =>
  JSON.stringify([a.code, a.file, a.detail]).localeCompare(
    JSON.stringify([b.code, b.file, b.detail]),
  );

function denied(result: ReturnType<typeof check>, code: string, file?: string) {
  expect(result.status, JSON.stringify(result.report)).toBe(1);
  expect(result.report.violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code, ...(file ? { file } : {}) }),
    ]),
  );
}

const cases = JSON.parse(
  fs.readFileSync(
    path.join(root, "tests/fixtures/ts-architecture/cases.json"),
    "utf8",
  ),
) as {
  name: string;
  files: Record<string, string>;
  reports: Row[];
  blocking: string[];
}[];

describe("ADR-0002 TypeScript migration rules", () => {
  it.each(cases)("reports $name", ({ files, reports, blocking }) => {
    const result = check(files);
    expect(result.status, JSON.stringify(result.report)).toBe(
      blocking.length ? 1 : 0,
    );
    expect(result.report.report.mode).toBe("report");
    // Every TS_ finding of the tree, exactly: fixtures are clean apart from
    // the rule they exercise.
    expect(plain(result.report.report.findings).sort(byKey)).toEqual(
      [...reports].sort(byKey),
    );
    expect(result.report.violations.map(({ code }) => code).sort()).toEqual(
      [...blocking].sort(),
    );
  });

  it("TS_BOOT_LOGIC counts lines beyond the 400-line budget", () => {
    const result = check({
      "src/boot/boot.ts": `${"// wiring\n".repeat(402)}export const boot = 1;\n`,
    });
    expect(plain(result.report.report.findings)).toEqual([
      {
        code: "TS_BOOT_LOGIC",
        file: "src/boot/boot.ts",
        detail: "lines beyond the 400-line budget",
        amount: 3,
      },
    ]);
  });
});

describe("the blocking import rules around the new layout", () => {
  it("classifies the target contracts folder as the contract layer", () => {
    const peer = check({
      "src/modules/computer/contracts/workspace/contract.ts":
        "export type WorkspaceRequest = string;\n",
      "src/modules/chat/infra/peer/computer.ts":
        'import type { WorkspaceRequest } from "../../../computer/contracts/workspace/contract";\nexport type Peer = WorkspaceRequest;\n',
    });
    expect(peer.status, JSON.stringify(peer.report.violations)).toBe(0);
    const leak = check({
      "src/modules/chat/domain/turn/turn.ts": "export type Turn = string;\n",
      "src/modules/chat/contracts/turn/contract.ts":
        'import type { Turn } from "../../domain/turn/turn";\nexport type TurnRequest = Turn;\n',
    });
    denied(leak, "ARCH_CONTRACT_LEAK");
    const backdoor = check({
      "src/modules/computer/domain/access/access.ts":
        "export type Access = string;\n",
      "src/modules/chat/infra/peer/computer.ts":
        'import type { Access } from "../../../computer/domain/access/access";\nexport type Peer = Access;\n',
    });
    denied(backdoor, "ARCH_CROSS_MODULE");
  });

  it("keeps co-located tests out of the production import graph", () => {
    const result = check({
      "src/modules/chat/domain/turn/turn.ts":
        "export function next(value: number) {\n  return value + 1;\n}\n",
      "src/modules/chat/domain/turn/turn.test.ts":
        'import fs from "node:fs";\nimport { expect, it } from "vitest";\nimport { next } from "./turn";\nit("advances", () => expect(next(fs.constants.F_OK)).toBe(1));\n',
    });
    expect(result.status, JSON.stringify(result.report.violations)).toBe(0);
    expect(result.report.files).toBe(1);
    expect(result.report.testFiles).toBe(1);
    expect(result.report.report.findings).toEqual([]);
  });

  it("refuses production code that imports a co-located test", () => {
    denied(
      check({
        "src/modules/chat/domain/turn/turn.ts":
          'import { cases } from "./turn.test";\nexport const all = cases;\n',
        "src/modules/chat/domain/turn/turn.test.ts":
          "export const cases = [];\n",
      }),
      "ARCH_PRODUCTION_TESTKIT",
      "src/modules/chat/domain/turn/turn.ts",
    );
  });

  it("cannot migrate away an existing blocking rule", () => {
    const file = "src/modules/chat/domain/turn/turn.ts";
    denied(
      check({
        [file]:
          'import fs from "node:fs";\nexport const read = fs.readFileSync;\n',
        [enforcementFile]: enforcement(),
      }),
      "ARCH_PURE_HOST_IMPORT",
      file,
    );
  });
});

describe("ADR-0002 TypeScript enforcement switch", () => {
  const wordFile = "src/modules/chat/domain/turn/turn-policy.ts";
  const wordFinding = {
    code: "TS_FILE_WORD",
    file: wordFile,
    detail: "File name is not one lowercase word: turn-policy",
  };
  const taskFinding = {
    code: "TS_FILE_WORD",
    file: "src/modules/task/domain/task/task-policy.ts",
    detail: "File name is not one lowercase word: task-policy",
  };
  const files = {
    [wordFile]: "export type Policy = string;\n",
    [taskFinding.file]: "export type Policy = string;\n",
  };

  it("keeps the real checkout green with a growing switch and exact rows", () => {
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
    expect(stored.version).toBe(1);
    expect(Object.keys(stored.migrated)).toEqual(migrationCodes);
    for (const [code, scopes] of Object.entries(migratedFloor))
      expect(stored.migrated[code]).toEqual(expect.arrayContaining(scopes));
    expect(report.report.migrated).toEqual(stored.migrated);
    expect(report.report.source).toBe(stored.source);
    expect(report.violations).toEqual([]);
    // Every report finding is exactly one baseline row and vice versa.
    expect(plain(report.report.findings)).toEqual(stored.baseline);
  });

  it("reports every scope without an enforcement file", () => {
    const result = check(files);
    expect(result.status, JSON.stringify(result.report)).toBe(0);
    expect(result.report.report.source).toBeNull();
    expect(plain(result.report.report.findings)).toContainEqual(wordFinding);
    expect(result.report.report.counts.TS_FILE_WORD).toEqual({
      chat: 1,
      task: 1,
    });
  });

  it("prints report lines for one scope and the count table", () => {
    const result = run(files, ["--scope", "chat"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      `REPORT TS_FILE_WORD ${wordFile}: ${wordFinding.detail}`,
    );
    expect(result.stdout).not.toContain("task-policy");
    expect(result.stdout).toMatch(/^TS_FILE_WORD +0 +0 +0 +1 .* 2$/mu);
    expect(result.stdout).toMatch(/^PASS: 2 files, 0 violation\(s\)$/mu);
  });

  it("blocks a rule only in its migrated scope", () => {
    const result = check({
      ...files,
      [enforcementFile]: enforcement({
        migrated: migrate("TS_FILE_WORD", "chat"),
        baseline: [taskFinding],
      }),
    });
    denied(result, "TS_FILE_WORD", wordFile);
    expect(
      result.report.violations.filter(({ code }) => code === "TS_FILE_WORD"),
    ).toEqual([wordFinding]);
    expect(
      result.report.report.findings.filter(
        ({ code }) => code === "TS_FILE_WORD",
      ),
    ).toEqual([{ ...taskFinding, scope: "task" }]);
  });

  it("excepts an exact reasoned row in a migrated scope", () => {
    const result = check({
      ...files,
      [enforcementFile]: enforcement({
        migrated: migrate("TS_FILE_WORD", "chat"),
        exceptions: [
          { ...wordFinding, reason: "Fixture", removal: "Rename the file" },
        ],
        baseline: [taskFinding],
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
    denied(
      check({
        [enforcementFile]: enforcement({
          migrated: migrate("TS_FILE_WORD", "chat"),
          exceptions: [{ ...wordFinding, ...row }],
        }),
      }),
      "TS_EXCEPTION_STALE",
      enforcementFile,
    );
    denied(
      check({
        ...files,
        [enforcementFile]: enforcement({
          exceptions: [{ ...wordFinding, ...row }],
          baseline: [wordFinding, taskFinding],
        }),
      }),
      "TS_EXCEPTION_STALE",
      enforcementFile,
    );
  });

  it("fails a new finding even when a fix keeps the count equal", () => {
    // Renaming one kebab file into another keeps TS_FILE_WORD at one in chat;
    // the new row fails as new and the old row as stale.
    const result = check({
      "src/modules/chat/domain/turn/turn-state.ts": "export type S = string;\n",
      [enforcementFile]: enforcement({ baseline: [wordFinding] }),
    });
    expect(result.report.report.counts.TS_FILE_WORD).toEqual({ chat: 1 });
    expect(
      result.report.violations.filter(({ code }) =>
        ["TS_REPORT_NEW", "TS_BASELINE_STALE"].includes(code),
      ),
    ).toEqual([
      {
        code: "TS_BASELINE_STALE",
        file: wordFile,
        detail:
          "TS_FILE_WORD File name is not one lowercase word: turn-policy: no matching report finding; delete the row (node tooling/check-architecture.mjs --write-baseline)",
      },
      {
        code: "TS_REPORT_NEW",
        file: "src/modules/chat/domain/turn/turn-state.ts",
        detail:
          "TS_FILE_WORD File name is not one lowercase word: turn-state: not in the baseline; fix it (adding a row needs reviewed --write-baseline --admit-new)",
      },
    ]);
  });

  it("fails a baseline row in a migrated scope as stale", () => {
    denied(
      check({
        ...files,
        [enforcementFile]: enforcement({
          migrated: migrate("TS_FILE_WORD", "chat"),
          baseline: [wordFinding, taskFinding],
        }),
      }),
      "TS_BASELINE_STALE",
      wordFile,
    );
  });

  const boot = (conditions: number) => ({
    "src/boot/chat.ts": `export function open(a: boolean) {\n${"  if (a) {\n  }\n".repeat(conditions)}}\n`,
  });
  const conditionRow = (amount: number) => ({
    code: "TS_BOOT_LOGIC",
    file: "src/boot/chat.ts",
    detail: "if statements",
    amount,
  });

  it("fails boot logic growth and a stale higher amount", () => {
    const at = (amount: number, conditions: number) =>
      check({
        ...boot(conditions),
        [enforcementFile]: enforcement({ baseline: [conditionRow(amount)] }),
      }).report.violations;
    expect(at(2, 2)).toEqual([]);
    expect(at(2, 3)).toEqual([
      {
        code: "TS_REPORT_NEW",
        file: "src/boot/chat.ts",
        detail:
          "TS_BOOT_LOGIC if statements: amount 3 exceeds the baseline 2; remove the new occurrences",
      },
    ]);
    expect(at(2, 1)).toEqual([
      {
        code: "TS_BASELINE_STALE",
        file: "src/boot/chat.ts",
        detail:
          "TS_BOOT_LOGIC if statements: amount 1 is below the baseline 2; set it to 1 (node tooling/check-architecture.mjs --write-baseline)",
      },
    ]);
  });

  it("writes the baseline only downward unless new rows are admitted", () => {
    const tree = {
      ...boot(1),
      [wordFile]: "export type Policy = string;\n",
      [enforcementFile]: enforcement({
        baseline: [
          conditionRow(4),
          taskFinding,
          { ...wordFinding, file: "src/modules/chat/domain/turn/gone-file.ts" },
        ],
      }),
    };
    const shrink = run(tree, ["--write-baseline"]);
    // The new chat finding is still refused; stale rows and amounts are gone.
    expect(shrink.status).toBe(1);
    expect(shrink.stdout).toContain(`TS_REPORT_NEW ${wordFile}`);
    expect(shrink.stdout).not.toContain("TS_BASELINE_STALE");
    expect(shrink.stored?.baseline).toEqual([conditionRow(1)]);
    const admit = run(tree, ["--write-baseline", "--admit-new"]);
    expect(admit.status, admit.stdout).toBe(0);
    expect(admit.stored?.baseline).toEqual([conditionRow(1), wordFinding]);
    expect(run(tree, ["--admit-new"]).stderr).toContain(
      "--admit-new requires --write-baseline",
    );
    expect(run(files, ["--write-baseline"]).stderr).toContain(
      `--write-baseline requires ${enforcementFile}`,
    );
  });

  it("writes the enforcement file in the repository's Prettier form", async () => {
    const result = run(
      {
        ...files,
        [enforcementFile]: enforcement({
          migrated: migrate("TS_FILE_WORD", "chat", "task"),
          exceptions: [
            { ...wordFinding, reason: "Fixture", removal: "Rename the file" },
            { ...taskFinding, reason: "Fixture", removal: "Rename the file" },
          ],
          baseline: [{ ...wordFinding, file: "src/modules/chat/gone.ts" }],
        }),
      },
      ["--write-baseline"],
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stored?.migrated.TS_FILE_WORD).toEqual(["chat", "task"]);
    expect(result.stored?.baseline).toEqual([]);
    const text = result.text ?? "";
    const options =
      (await prettier.resolveConfig(path.join(root, enforcementFile))) ?? {};
    expect(
      await prettier.format(text, { ...options, filepath: enforcementFile }),
    ).toBe(text);
  });

  it("rejects a malformed enforcement file and unknown options", () => {
    const malformed = run(
      { ...files, [enforcementFile]: enforcement({ version: 3 }) },
      ["--json"],
    );
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain(
      "Invalid TypeScript architecture enforcement: envelope",
    );
    const scope = run(
      {
        ...files,
        [enforcementFile]: enforcement({
          migrated: migrate("TS_FILE_WORD", "nowhere"),
        }),
      },
      ["--json"],
    );
    expect(scope.stderr).toContain("migrated TS_FILE_WORD");
    expect(run(files, ["--strict"]).stderr).toContain(
      "Unknown or incomplete option: --strict",
    );
  });
});
