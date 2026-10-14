// Test-side package Go/MCP Shell journey. No owner HOME, credentials or provider.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Peer } from "./go-computer-mcp.diagnostics.ts";

export async function runGitShellJourney(input: {
  peer: Pick<Peer, "request" | "call">;
  fixture: {
    home: string;
    writer: string;
    repository: string;
    canary: string;
    expected: Record<string, string>;
  };
  workspaceId: string;
  report: Record<string, unknown>;
  checkpoint: () => Promise<unknown>;
}) {
  const { fixture: f, peer } = input;
  const hooks = path.join(f.home, ".config/git/hooks");
  const policy = path.join(f.repository, "system/hooks");
  await fs.mkdir(policy, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(policy, "commit-msg"),
    `#!/usr/bin/env python3
from pathlib import Path
import sys
if not Path(sys.argv[1]).read_text().startswith('Work/Fixture: '):
    print('fixture-python-commit-msg-rejected',file=sys.stderr)
    raise SystemExit(1)
`,
    { mode: 0o700 },
  );
  await fs.symlink(
    path.relative(hooks, path.join(policy, "commit-msg")),
    path.join(hooks, "commit-msg"),
  );
  await fs.writeFile(
    path.join(hooks, "pre-commit"),
    `#!/usr/bin/env python3
from pathlib import Path
import json, hashlib, sys
assert json.loads('{"allowed":true}')['allowed']
assert hashlib.sha256(b'fixture').hexdigest()
if Path('.fixture-reject').exists():
    print('fixture-python-pre-commit-rejected',file=sys.stderr)
    raise SystemExit(1)
`,
    { mode: 0o700 },
  );
  const operationId = randomUUID();
  const witness: Record<string, unknown> = {
    operationId,
    state: "start-outcome-unknown",
    limits:
      "Synthetic ordinary configuration and hooks; no owner/installed/ChatGPT proof",
  };
  input.report.gitShell = witness;
  await input.checkpoint();
  const script = `set -eu
# HOME, PATH and Git configuration are supplied only by the product host.
test "$(git config --get user.name)" = 'Farol Fixture Author'
test "$(git config --get farolFixture.xdg)" = xdg-config-read
test "$(git config --get farolFixture.included)" = relative-include-read
test "$(git config --get farolFixture.conditional)" = linked-worktree-include-read
test "$(git config --worktree --get farolFixture.worktree)" = only-this-worktree
test "$(git check-attr diff -- fixture.swift)" = 'fixture.swift: diff: swift'
base=$(git rev-parse HEAD)
printf 'foreign staged\\n' > foreign.txt
printf 'owned unstaged\\n' > owned.txt
git add foreign.txt owned.txt
git restore --staged -- owned.txt
test "$(git diff --cached --name-only)" = foreign.txt
test "$(cat owned.txt)" = 'owned unstaged'
git add owned.txt
git commit --only -qm 'Work/Fixture: verify ordinary Git hooks' -- owned.txt
head=$(git rev-parse HEAD)
test "$head" != "$base"
test "$(git diff --cached --name-only)" = foreign.txt
test "$(git show --format= --name-only HEAD)" = owned.txt
printf 'next owned\\n' > owned.txt
git add owned.txt
if result=$(git commit --only -qm invalid -- owned.txt 2>&1); then exit 71; else test "$?" = 1; fi
test "$result" = fixture-python-commit-msg-rejected
test "$(git rev-parse HEAD)" = "$head"
printf 'reject\\n' > .fixture-reject
if result=$(git commit --only -qm 'Work/Fixture: must reject pre-commit' -- owned.txt 2>&1); then exit 72; else test "$?" = 1; fi
test "$result" = fixture-python-pre-commit-rejected
test "$(git rev-parse HEAD)" = "$head"
printf 'git-shell-accepted=%s\\n' "$head"
`;
  const reply = await peer.request("tools/call", {
    name: "computer_shell_start",
    arguments: {
      operationId,
      workspaceId: input.workspaceId,
      relativeCwd: path.relative(f.home, f.writer),
      write: true,
      command: script,
    },
  });
  const start = reply.structuredContent;
  assert.ok(start && typeof start === "object" && !Array.isArray(start));
  const admission = start as Record<string, unknown>;
  // Retain the original closed response before any expectation can throw.
  // A transport response alone cannot establish that an effect was absent.
  witness.admission = {
    isError: reply.isError === true,
    status: typeof admission.status === "string" ? admission.status : "unknown",
    code:
      typeof admission.code === "string" &&
      /^[A-Z][A-Z0-9_]{0,79}$/u.test(admission.code)
        ? admission.code
        : null,
  };
  witness.state =
    admission.status === "refused"
      ? "original-start-refused-never-retry"
      : admission.status === "ok"
        ? "original-start-response"
        : "original-start-unconfirmed-never-retry";
  await input.checkpoint();
  assert.equal(reply.isError === true, false);
  assert.equal(admission.status, "ok");
  const data = admission.data as Record<string, unknown>;
  assert.equal(data.operationId, operationId);
  assert.ok(typeof data.handle === "string");
  witness.handle = data.handle;
  witness.state = "running";
  await input.checkpoint();
  const stopAt = Date.now() + 30000;
  let stdoutOffset = 0,
    stderrOffset = 0,
    stdout = "",
    stderr = "";
  while (Date.now() < stopAt) {
    const result = await peer.call("computer_shell_read", {
      operationId,
      handle: data.handle,
      stdoutOffset,
      stderrOffset,
    });
    assert.equal(result.status, "ok");
    const observed = result.data as Record<string, unknown>;
    assert.equal(observed.operationId, operationId);
    const page = (value: unknown, offset: number, next: unknown) => {
      assert.equal(typeof value, "string");
      assert.equal(typeof next, "string");
      assert.match(next as string, /^(?:0|[1-9][0-9]*)$/u);
      const bytes = Buffer.from(value as string, "base64");
      assert.equal(bytes.toString("base64"), value);
      const end = Number(next);
      assert.ok(Number.isSafeInteger(end) && end <= 4 * 1024 * 1024);
      assert.equal(end - offset, bytes.length);
      return { text: bytes.toString("utf8"), end };
    };
    assert.equal(observed.stdoutOffset, String(stdoutOffset));
    assert.equal(observed.stderrOffset, String(stderrOffset));
    const out = page(observed.stdoutBase64, stdoutOffset, observed.stdoutNext);
    const err = page(observed.stderrBase64, stderrOffset, observed.stderrNext);
    stdout += out.text;
    stderr += err.text;
    stdoutOffset = out.end;
    stderrOffset = err.end;
    assert.ok(stdout.length + stderr.length <= 65536);
    witness.last = observed;
    if (observed.state === "exited" && observed.outputDrained === true) {
      witness.state = "terminal-observed";
      await input.checkpoint();
      assert.equal(observed.exitCode, 0, stderr);
      assert.equal(stderr, "");
      const match = /^git-shell-accepted=([a-f0-9]{40})\n$/u.exec(stdout);
      assert.ok(match);
      witness.commit = match[1];
      const ref = await fs.readFile(
        path.join(f.repository, ".git/refs/heads/fixture-worker"),
        "utf8",
      );
      assert.equal(ref.trim(), match[1]);
      assert.equal(await fs.readFile(f.canary, "utf8"), f.expected.outside);
      witness.state = "passed-package-go-shell-git";
      await input.checkpoint();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  witness.state = "original-operation-unconfirmed-never-retry";
  await input.checkpoint();
  throw Error("ORIGINAL_SHELL_OUTCOME_UNKNOWN");
}
