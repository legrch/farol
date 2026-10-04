import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  provenanceDigest,
  checkpointSnapshot,
  checkEvidence,
  sha256,
  testCount,
  validateCheckpoint,
} from "../../tooling/checkpoint.mjs";

// Injected Git reads + real disposable files; no Git writes, native launches,
// browser, provider, full CI or claimed real-checkpoint admission.
vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
let root, commands, state;
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "farol-checkpoint-policy-")),
  );
  fs.writeFileSync(path.join(root, "source.ts"), "export const value = 1;\n");
  state = {
    head: "a".repeat(40),
    branch: "fixture-writer",
    flags: "H source.ts\0",
    index: `100644 ${"b".repeat(40)} 0\tsource.ts\0`,
    staged: "source.ts\0",
    unstaged: "",
  };
  commands = [];
  vi.mocked(execFileSync).mockImplementation((command, args) => {
    expect(command).toBe("/usr/bin/git");
    const a = args.slice(2);
    commands.push(a);
    const key = a.join(" ");
    if (key === "rev-parse --show-toplevel") return Buffer.from(root);
    if (key === "rev-parse --verify HEAD") return Buffer.from(state.head);
    if (key === "branch --show-current") return Buffer.from(state.branch);
    if (key === "ls-files -v -z") return Buffer.from(state.flags);
    if (key === "ls-files --stage -z") return Buffer.from(state.index);
    if (key === "diff --no-renames --name-only -z HEAD")
      return Buffer.from(state.staged);
    if (key.startsWith("merge-base --is-ancestor")) return Buffer.alloc(0);
    if (key === "diff --cached --no-renames --name-only -z HEAD")
      return Buffer.from(state.staged);
    if (a[0] === "diff" && a.includes("--check")) return Buffer.alloc(0);
    if (key.startsWith("diff --name-only --"))
      return Buffer.from(state.unstaged);
    throw Error(`UNEXPECTED_GIT_READ:${key}`);
  });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.resetAllMocks();
});
function artifact(name, text) {
  const file = path.join(root, "_output", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { path: file, sha256: sha256(text) };
}
function report() {
  return {
    success: true,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [
      {
        name: "/fixture/policy.test.mjs",
        status: "passed",
        assertionResults: [{ status: "passed" }],
      },
    ],
  };
}
function audit(e) {
  e.provenanceReview = {
    role: "implementing-lead",
    decision: "audited-original-current-task-receipts",
    lead: "Fixture implementing Lead",
    task: "current-fixture-task",
    dependencyEvidence:
      "Fixture-only runtime/dependency evidence; not real admission.",
    receipts: e.checks.map((c) => ({
      checkId: c.id,
      toolReceipt: `fixture-terminal:${c.id}`,
    })),
    evidenceSHA256: provenanceDigest(e),
  };
  return e;
}
function evidence() {
  const log = artifact(
    "terminal.log",
    "fixture command: type/import/test; observed terminal exit 0\n",
  );
  const receipt = artifact("vitest.json", JSON.stringify(report()));
  return audit({
    version: 1,
    intent: "local-unaccepted-checkpoint",
    source: checkpointSnapshot(root),
    mapping: {
      current: checkpointSnapshot(root),
      paths: ["source.ts"],
      rationale: "Exact current staged subset of the unchanged tested source.",
    },
    paths: ["source.ts"],
    selfReview: "Fixture-only complete delta mapping; no real gate claim.",
    checks: ["test", "type", "import"].map((kind) => ({
      id: kind,
      kind,
      argv: ["fixture-command", kind],
      cwd: root,
      rationale: "Injected fixture protects this source boundary.",
      covers: ["source.ts"],
      terminal: true,
      exitCode: 0,
      signal: null,
      log,
      ...(kind === "test"
        ? {
            format: "vitest-json",
            report: receipt,
            inputs: ["/fixture/policy.test.mjs"],
          }
        : {}),
    })),
  });
}
const validate = (e) => validateCheckpoint(e, checkpointSnapshot(root));
describe("checkpoint evidence boundary", () => {
  it("allows only local unaccepted status with full obligations retained", () => {
    const result = validate(evidence());
    expect(result).toMatchObject({
      status: "LOCAL_CHECKPOINT_ONLY",
      accepted: false,
      tests: 1,
    });
    expect(result.requiredBeforeAcceptance.join(" ")).toMatch(
      /ci:fast.*Core.*Hunt.*security/u,
    );
    expect(result.requiredBeforeAcceptance.join(" ")).toContain("attestation");
  });
  it.each(["checks", "paths", "selfReview"])("refuses empty %s", (key) => {
    const e = evidence();
    e[key] = key === "selfReview" ? "" : [];
    expect(() => validate(e)).toThrow();
  });
  it.each(["test", "type", "import"])(
    "requires claimed %s evidence",
    (kind) => {
      const e = evidence();
      e.checks = e.checks.filter((c) => c.kind !== kind);
      expect(() => validate(e)).toThrow("REQUIRED_CHECK_OR_PATH_MISSING");
    },
  );
  it.each([
    { exitCode: 1 },
    { exitCode: null },
    { terminal: false },
    { signal: "SIGTERM" },
  ])("refuses nonterminal/failed/unknown check %j", (change) => {
    const e = evidence();
    Object.assign(e.checks[0], change);
    expect(() => validate(e)).toThrow("CHECK_NOT_TERMINAL_PASS");
  });
  it.each([
    { argv: [] },
    { argv: [""] },
    { rationale: "" },
    { cwd: "" },
    { kind: "full" },
    { covers: [] },
    { covers: ["unowned"] },
  ])("refuses empty or unknown claim %j", (change) => {
    const e = evidence();
    Object.assign(e.checks[0], change);
    expect(() => validate(e)).toThrow();
  });
  it("refuses duplicate checks and incomplete staged coverage", () => {
    const e = evidence();
    e.checks.push(e.checks[0]);
    expect(() => validate(e)).toThrow("CHECK_ID_EMPTY_OR_DUPLICATE");
    state.staged = "source.ts\0other.ts\0";
    const next = evidence();
    next.paths = ["source.ts", "other.ts"];
    next.mapping.paths = next.paths;
    expect(() => validate(next)).toThrow("REQUIRED_CHECK_OR_PATH_MISSING");
  });
  it("refuses deleted, empty, modified and redirected logs", () => {
    for (const mode of ["deleted", "empty", "modified", "symlink"]) {
      const e = evidence();
      const file = e.checks[0].log.path;
      fs.unlinkSync(file);
      if (mode === "empty") fs.writeFileSync(file, "");
      if (mode === "modified") fs.writeFileSync(file, "other terminal");
      if (mode === "symlink")
        fs.symlinkSync(path.join(root, "source.ts"), file);
      expect(() => validate(e)).toThrow();
      if (mode === "symlink") fs.unlinkSync(file);
    }
  });
  it("refuses source drift and unmapped HEAD/index movement", () => {
    for (const change of [
      () => fs.appendFileSync(path.join(root, "source.ts"), "// changed"),
      () => {
        state.head = "c".repeat(40);
      },
      () => {
        state.index += "100644 ddddd 0\tother.ts\0";
      },
      () => fs.chmodSync(path.join(root, "source.ts"), 0o755),
    ]) {
      const e = evidence();
      change();
      expect(() => validate(e)).toThrow();
    }
  });
});
describe("checkpoint source equivalence", () => {
  it("reuses immutable receipts across two staged subsets and changed HEAD/index", () => {
    fs.writeFileSync(
      path.join(root, "second.ts"),
      "export const second = 2;\n",
    );
    state.staged = "source.ts\0second.ts\0";
    const original = evidence();
    original.paths = ["source.ts", "second.ts"];
    original.checks.forEach((c) => {
      c.covers = original.paths;
    });
    const immutable = JSON.stringify({
      source: original.source,
      checks: original.checks,
    });
    for (const file of ["source.ts", "second.ts"]) {
      state.head = file === "source.ts" ? "c".repeat(40) : "d".repeat(40);
      state.staged = `${file}\0`;
      state.index = `100644 ${state.head} 0\tsource.ts\0`;
      const mapped = {
        ...original,
        mapping: {
          current: checkpointSnapshot(root),
          paths: [file],
          rationale: "Same full workspace bytes; next coherent owned subset.",
        },
      };
      audit(mapped);
      expect(validate(mapped)).toMatchObject({
        status: "LOCAL_CHECKPOINT_ONLY",
        accepted: false,
        paths: [file],
      });
      expect(
        JSON.stringify({ source: mapped.source, checks: mapped.checks }),
      ).toBe(immutable);
    }
  });
  it("refuses a subset outside tested scope or an absent current mapping", () => {
    const e = evidence();
    delete e.mapping;
    expect(() => validate(e)).toThrow("CURRENT_MAPPING_REQUIRED");
    const next = evidence();
    next.paths = ["not-tested"];
    expect(() => validate(next)).toThrow("TESTED_SCOPE_REQUIRED");
  });
});

describe("checkpoint terminal refusal", () => {
  it("does not mask failed Git/diff/ancestry reads", () => {
    const e = evidence();
    const file = artifact("receipt.json", JSON.stringify(e)).path;
    const original = vi.mocked(execFileSync).getMockImplementation();
    for (const target of ["merge-base", "diff"]) {
      vi.mocked(execFileSync).mockImplementation((command, args) => {
        if (args[2] === target) throw Error("GIT_REFUSED");
        return original(command, args);
      });
      expect(() => checkEvidence(root, file)).toThrow("GIT_REFUSED");
    }
  });
  it("refuses source movement during validation and malformed tested identity", () => {
    const e = evidence();
    e.source.head = "--all";
    expect(() => validate(e)).toThrow("TESTED_IDENTITY_INVALID");
    const next = evidence();
    const file = artifact("receipt.json", JSON.stringify(next)).path;
    const original = vi.mocked(execFileSync).getMockImplementation();
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (args[2] === "diff" && args.includes("--check"))
        fs.appendFileSync(path.join(root, "source.ts"), "// concurrent edit");
      return original(command, args);
    });
    expect(() => checkEvidence(root, file)).toThrow(
      "SOURCE_MOVED_DURING_CHECK",
    );
  });
});

describe("mandatory precommit provenance audit", () => {
  it("refuses absent audit despite otherwise passing evidence", () => {
    const e = evidence();
    delete e.provenanceReview;
    expect(() => validate(e)).toThrow("PRECOMMIT_PROVENANCE_REVIEW_REQUIRED");
  });
  it.each([
    { role: "later-range-reviewer" },
    { decision: "pending" },
    { lead: "" },
    { task: "" },
    { dependencyEvidence: "" },
  ])("requires actual implementing-Lead precommit declaration %j", (change) => {
    const e = evidence();
    Object.assign(e.provenanceReview, change);
    expect(() => validate(e)).toThrow("PRECOMMIT_PROVENANCE_REVIEW_REQUIRED");
  });
  it.each(["missing", "extra", "duplicate", "empty-reference"])(
    "refuses %s original terminal receipt mapping",
    (mode) => {
      const e = evidence();
      const refs = e.provenanceReview.receipts;
      if (mode === "missing") refs.pop();
      if (mode === "extra")
        refs.push({ checkId: "other", toolReceipt: "fixture-other" });
      if (mode === "duplicate") refs[1] = refs[0];
      if (mode === "empty-reference") refs[0].toolReceipt = "";
      expect(() => validate(e)).toThrow(
        "PRECOMMIT_PROVENANCE_REVIEW_INCONSISTENT",
      );
    },
  );
  it.each(["argv", "cwd", "log", "tested-index"])(
    "refuses changed %s after provenance audit",
    (kind) => {
      const e = evidence();
      if (kind === "argv") e.checks[0].argv.push("different-selection");
      if (kind === "cwd") e.checks[0].cwd = "/other-workspace";
      if (kind === "log")
        e.checks[0].log = artifact(
          "different.log",
          "different nonempty terminal log",
        );
      if (kind === "tested-index") e.source.index = "c".repeat(64);
      expect(() => validate(e)).toThrow(
        "PRECOMMIT_PROVENANCE_REVIEW_INCONSISTENT",
      );
    },
  );
  it("requires renewed audit for a new checkpoint mapping, without rewriting original receipts", () => {
    const e = evidence();
    const retained = JSON.stringify({ source: e.source, checks: e.checks });
    state.head = "c".repeat(40);
    e.mapping = {
      current: checkpointSnapshot(root),
      paths: ["source.ts"],
      rationale: "Next forward checkpoint; identical full source.",
    };
    expect(() => validate(e)).toThrow(
      "PRECOMMIT_PROVENANCE_REVIEW_INCONSISTENT",
    );
    audit(e);
    expect(validate(e).status).toBe("LOCAL_CHECKPOINT_ONLY");
    expect(JSON.stringify({ source: e.source, checks: e.checks })).toBe(
      retained,
    );
  });
});

describe("checkpoint test reports", () => {
  it.each(["failed", "pending", "todo", "skipped"])(
    "rejects %s assertions",
    (status) => {
      const r = report();
      r.testResults[0].assertionResults[0].status = status;
      expect(() =>
        testCount("vitest-json", JSON.stringify(r), [
          "/fixture/policy.test.mjs",
        ]),
      ).toThrow("TEST_FAILED_EMPTY_OR_SKIPPED");
    },
  );
  it("refuses missing/extra discovery, empty tests, unknown format and inconsistent counts", () => {
    expect(() =>
      testCount("vitest-json", JSON.stringify(report()), []),
    ).toThrow();
    expect(() =>
      testCount("vitest-json", JSON.stringify(report()), ["other"]),
    ).toThrow("TEST_DISCOVERY_MISMATCH");
    const r = report();
    r.testResults[0].assertionResults = [];
    expect(() =>
      testCount("vitest-json", JSON.stringify(r), ["/fixture/policy.test.mjs"]),
    ).toThrow();
    r.testResults[0].assertionResults = [{ status: "passed" }];
    r.numTotalTests = 2;
    expect(() =>
      testCount("vitest-json", JSON.stringify(r), ["/fixture/policy.test.mjs"]),
    ).toThrow("TEST_COUNTS_MISMATCH");
    expect(() => testCount("unknown", "{}", ["test"])).toThrow(
      "TEST_FORMAT_UNKNOWN",
    );
  });
  it("requires actual nonempty Go package/test PASS without skipped/failed packages", () => {
    const rows = [
      { Action: "pass", Package: "fixture", Test: "TestOne" },
      { Action: "pass", Package: "fixture" },
    ];
    const encode = (rs) => rs.map((r) => JSON.stringify(r)).join("\n");
    expect(testCount("go-json", encode(rows), ["fixture"])).toBe(1);
    for (const bad of [
      [rows[1]],
      [rows[0]],
      [...rows, { Action: "skip", Package: "fixture" }],
      [...rows, rows[0]],
    ])
      expect(() => testCount("go-json", encode(bad), ["fixture"])).toThrow();
  });
});
describe("checkpoint source and gate", () => {
  it("binds ignored source without trusting info/exclude/global/nested ignore rules", () => {
    const before = checkpointSnapshot(root);
    fs.writeFileSync(path.join(root, "secretly-ignored.ts"), "source");
    expect(checkpointSnapshot(root).source).not.toBe(before.source);
    expect(commands.some((c) => c.includes("--exclude-standard"))).toBe(false);
  });
  it("does not treat ordinary dependency/output presence as source acceptance", () => {
    const before = checkpointSnapshot(root);
    for (const dir of ["node_modules", "_output"]) {
      fs.mkdirSync(path.join(root, dir));
      fs.writeFileSync(path.join(root, dir, "output"), "generated");
    }
    expect(checkpointSnapshot(root)).toEqual(before);
  });
  it.each(["node_modules", "source.ts"])("refuses symlink %s", (name) => {
    const target = path.join(root, name);
    if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.symlinkSync("/private/tmp", target);
    expect(() => checkpointSnapshot(root)).toThrow("SOURCE_SYMLINK");
  });
  it.each(["h source.ts\0", "S source.ts\0", "M source.ts\0"])(
    "refuses index ambiguity %s",
    (flags) => {
      state.flags = flags;
      expect(() => checkpointSnapshot(root)).toThrow("INDEX_FLAG_OR_CONFLICT");
    },
  );
  it("rejects conflicts, tracked excluded inputs, empty stage and primary branch", () => {
    const e = evidence();
    state.staged = "";
    e.mapping.current = checkpointSnapshot(root);
    e.mapping.paths = [];
    expect(() => validate(e)).toThrow("EXACT_NONEMPTY_STAGED_SCOPE_REQUIRED");
    state.index = "100644 aaaaa 1\tsource.ts\0";
    expect(() => checkpointSnapshot(root)).toThrow("INDEX_MODE");
    state.index = "100644 aaaaa 0\tnode_modules/source.ts\0";
    expect(() => checkpointSnapshot(root)).toThrow("EXCLUDED_TRACKED");
    state.branch = "main";
    expect(() => checkpointSnapshot(root)).toThrow("NAMED_WRITER_REQUIRED");
  });
  it("retains both rename sides, rejects staged/worktree mismatch and runs both diff checks", () => {
    state.staged = "old.ts\0source.ts\0";
    expect(checkpointSnapshot(root).staged).toEqual(["old.ts", "source.ts"]);
    state.staged = "source.ts\0";
    const e = evidence();
    const file = artifact("evidence.json", JSON.stringify(e)).path;
    expect(checkEvidence(root, file).accepted).toBe(false);
    expect(commands).toContainEqual(["diff", "--check"]);
    expect(commands).toContainEqual(["diff", "--cached", "--check"]);
    state.unstaged = "source.ts\n";
    expect(() => checkEvidence(root, file)).toThrow("STAGED_WORKTREE_MISMATCH");
  });
});
