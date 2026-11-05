import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  OwnerGitEnvironmentError,
  captureOwnerGitEnvironment,
  ownedProcess,
  parseOwnerPathFrame,
} from "../../apps/desktop/owner-git-environment";
import { OwnerGitChoice } from "../../apps/desktop/owner-git-choice";

const created: string[] = [];
afterEach(() => {
  for (const root of created.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("loads Finder account PATH through login and interactive shell only", async () => {
  const account = os.userInfo();
  const calls: string[] = [];
  const run: typeof ownedProcess = async (executable, args, home, env) => {
    calls.push(executable);
    expect(home).toBe(account.homedir);
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    if (executable === "/usr/bin/id")
      return Buffer.from(
        `${account.username}:*:${account.uid}:${account.gid}:::::${account.homedir}:/bin/zsh\n`,
      );
    expect(executable).toBe("/bin/zsh");
    expect(args.slice(0, 3)).toEqual(["-l", "-i", "-c"]);
    const nonce = /FAROL_ENV_BEGIN_([a-f0-9]{32})/u.exec(args[3] ?? "")?.[1];
    expect(nonce).toBeDefined();
    return Buffer.from(
      `shell chatter\n\0FAROL_ENV_BEGIN_${nonce}\0/opt/homebrew/bin:/usr/bin\0FAROL_ENV_END_${nonce}\0prompt`,
    );
  };
  const result = await captureOwnerGitEnvironment(4, run, "darwin");
  expect(result).toMatchObject({
    path: "/opt/homebrew/bin:/usr/bin",
    source: "desktop-login-shell",
    generation: 4,
  });
  expect(calls).toEqual(["/usr/bin/id", "/bin/zsh"]);
});

it("unsupported account shell and bounded timeout do not select another Git", async () => {
  const account = os.userInfo();
  const fish: typeof ownedProcess = async () =>
    Buffer.from(
      `${account.username}:*:${account.uid}:${account.gid}:::::${account.homedir}:/opt/homebrew/bin/fish\n`,
    );
  await expect(
    captureOwnerGitEnvironment(1, fish, "darwin"),
  ).rejects.toMatchObject({
    code: "GIT_SHIM_UNSUPPORTED",
  });
  await expect(
    captureOwnerGitEnvironment(1, fish, "linux"),
  ).rejects.toMatchObject({
    code: "SHELL_ENV_OUTCOME_UNKNOWN",
  });
  await expect(
    ownedProcess(
      "/bin/sh",
      ["-c", "sleep 2"],
      os.tmpdir(),
      { PATH: "/usr/bin:/bin" },
      Date.now() + 80,
    ),
  ).rejects.toMatchObject({ code: "SHELL_ENV_TIMEOUT" });
});

it("accepts one nonce-bound PATH frame with harmless shell chatter", () => {
  const nonce = "a".repeat(32);
  const raw = Buffer.from(
    `startup chatter\n\0FAROL_ENV_BEGIN_${nonce}\0/opt/homebrew/bin:/usr/bin\0FAROL_ENV_END_${nonce}\0prompt`,
  );
  expect(parseOwnerPathFrame(raw, nonce)).toBe("/opt/homebrew/bin:/usr/bin");
  for (const bad of [
    Buffer.concat([raw, raw]),
    raw.subarray(0, raw.length - 9),
    Buffer.from(
      `\0FAROL_ENV_BEGIN_${nonce}\0/opt/homebrew/bin:\0FAROL_ENV_END_${nonce}\0`,
    ),
    Buffer.from(`\0FAROL_ENV_BEGIN_${nonce}\0../bin\0FAROL_ENV_END_${nonce}\0`),
    Buffer.from(
      `\0FAROL_ENV_BEGIN_${nonce}\0/usr/bin\0/secret\0FAROL_ENV_END_${nonce}\0`,
    ),
    Buffer.concat([
      Buffer.from(`\0FAROL_ENV_BEGIN_${nonce}\0`),
      Buffer.from([0xff]),
      Buffer.from(`\0FAROL_ENV_END_${nonce}\0`),
    ]),
  ])
    expect(() => parseOwnerPathFrame(bad, nonce)).toThrow(
      OwnerGitEnvironmentError,
    );
});

it("persists only explicit owner Git choice and never a captured PATH", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "farol-owner-git-choice-"));
  created.push(root);
  const initial = new OwnerGitChoice(root);
  expect(initial.launchEnvironment()).toBeUndefined();
  initial.selectOverrideFromOwner("/opt/homebrew/bin/git");
  const saved = readFileSync(path.join(root, "owner-git-choice.json"), "utf8");
  expect(saved).toContain('"override":"/opt/homebrew/bin/git"');
  expect(saved).not.toContain("capturedAt");
  const resumed = new OwnerGitChoice(root);
  await resumed.prepareStartup();
  expect(resumed.launchEnvironment()).toMatchObject({
    path: "/opt/homebrew/bin",
    source: "owner-override",
    generation: 1,
  });
  expect(() =>
    initial.selectOverrideFromOwner("/opt/homebrew/bin/other"),
  ).toThrow();
});

it("does not run the account shell at startup and saves only the clicked PATH selection", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "farol-owner-git-click-"));
  created.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const git = path.join(bin, "git");
  writeFileSync(git, "#!/bin/sh\nexit 0\n");
  chmodSync(git, 0o755);
  writeFileSync(
    path.join(root, "owner-git-choice.json"),
    JSON.stringify({ schema: 1, enabled: true, override: null }),
    { mode: 0o600 },
  );
  let captures = 0;
  const capture: typeof captureOwnerGitEnvironment = async (generation) => {
    captures++;
    return {
      path: `${bin}:/usr/bin`,
      source: "desktop-login-shell",
      capturedAt: new Date().toISOString(),
      generation,
    };
  };
  const owner = new OwnerGitChoice(root, capture);
  await owner.prepareStartup();
  expect(captures).toBe(0);
  expect(owner.launchEnvironment()).toBeUndefined();
  expect(owner.status().failure).toBe("GIT_CHOICE_UNAVAILABLE");
  await owner.refreshFromOwner();
  expect(captures).toBe(1);
  expect(owner.status().gitAlias).toBe(git);
  expect(owner.status().pendingRestart).toBe(true);
  expect(
    JSON.parse(readFileSync(path.join(root, "owner-git-choice.json"), "utf8")),
  ).toEqual({
    schema: 1,
    enabled: true,
    override: git,
  });
  const reopened = new OwnerGitChoice(root, async () => {
    throw new Error("unexpected shell execution");
  });
  await reopened.prepareStartup();
  expect(reopened.launchEnvironment()?.path).toBe(bin);
});

it("skips a dangling alias and an owner-nonexecutable file before selecting Git", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "farol-owner-git-path-"));
  created.push(root);
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  const selected = path.join(second, "git");
  writeFileSync(selected, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const owner = new OwnerGitChoice(root, async (generation) => ({
    path: `${first}:${second}`,
    source: "desktop-login-shell",
    capturedAt: new Date().toISOString(),
    generation,
  }));
  symlinkSync("missing", path.join(first, "git"));
  await owner.refreshFromOwner();
  expect(owner.status().gitAlias).toBe(selected);
  rmSync(path.join(first, "git"));
  writeFileSync(path.join(first, "git"), "#!/bin/sh\nexit 0\n", {
    mode: 0o645,
  });
  const next = new OwnerGitChoice(root, async (generation) => ({
    path: `${first}:${second}`,
    source: "desktop-login-shell",
    capturedAt: new Date().toISOString(),
    generation,
  }));
  await next.refreshFromOwner();
  expect(next.status().gitAlias).toBe(selected);
});

it("does not reissue an uncertain account-shell capture", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "farol-owner-git-unknown-"));
  created.push(root);
  let captures = 0;
  const owner = new OwnerGitChoice(root, async () => {
    captures++;
    throw new OwnerGitEnvironmentError("SHELL_ENV_OUTCOME_UNKNOWN");
  });
  await expect(owner.refreshFromOwner()).rejects.toMatchObject({
    code: "SHELL_ENV_OUTCOME_UNKNOWN",
  });
  await expect(owner.refreshFromOwner()).rejects.toThrow(
    "SHELL_ENV_OUTCOME_UNKNOWN",
  );
  expect(captures).toBe(1);
  expect(owner.status().failure).toBe("SHELL_ENV_OUTCOME_UNKNOWN");
});
