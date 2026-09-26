import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const homes = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "farol-owner-guard-"));
  homes.push(home);
  return home;
}
function run(home, code) {
  return spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "scripts/assert-owner-untouched.py",
      "--",
      "/usr/bin/python3",
      "-I",
      "-c",
      code,
    ],
    {
      cwd: root,
      env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
      encoding: "utf8",
    },
  );
}
function runOwnerLaunch(home, script, args, code, extraEnvironment = {}) {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const fakeNode = path.join(bin, "node");
  fs.writeFileSync(
    fakeNode,
    '#!/bin/sh\nexec /usr/bin/python3 -I -c "$FAKE_NODE_CODE"\n',
    { mode: 0o700 },
  );
  return spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "scripts/assert-owner-untouched.py",
      "--",
      fakeNode,
      script,
      ...args,
    ],
    {
      cwd: root,
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        FAKE_NODE_CODE: code,
        ...extraEnvironment,
      },
      encoding: "utf8",
    },
  );
}
afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});
describe("standalone owner protection", () => {
  it("detects writes to a synthetic protected path without any V0 imports", () => {
    const home = fixture();
    const result = run(
      home,
      "from pathlib import Path; p=Path.home()/'.farol/state/settings.json'; p.parent.mkdir(parents=True); p.write_text('changed')",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".farol/state/settings.json");
    expect(result.stderr).toContain(
      "modified the owner's live Farol installation",
    );
  });
  it("permits declared runtime churn and its atomic staging siblings", () => {
    const result = run(
      fixture(),
      "from pathlib import Path; p=Path.home()/'.farol/runtime/hub/farol-full'; p.mkdir(parents=True); [(p/n).write_text('churn') for n in ['codex-route-activity.json','.codex-route-activity.json.tmp','hub-actions.jsonl.reservation']]",
    );
    expect(result.status).toBe(0);
  });
  it("catches an undeclared profile but allows the separately owned V0 development profiles", () => {
    const home = fixture();
    expect(
      run(
        home,
        "from pathlib import Path; p=Path.home()/'.config/tunnel-client'; p.mkdir(parents=True); (p/'farol-dev-full.yaml').write_text('fixture')",
      ).status,
    ).toBe(0);
    const result = run(
      home,
      "from pathlib import Path; (Path.home()/'.config/tunnel-client/unowned.yaml').write_text('fixture')",
    );
    expect(result.status).toBe(1);
  });
  it("catches browser-profile replacement without reading browser content", () => {
    const home = fixture();
    const profile = path.join(home, ".farol/runtime/browser/browser-profile");
    fs.mkdirSync(profile, { recursive: true });
    const result = run(
      home,
      "from pathlib import Path; p=Path.home()/'.farol/runtime/browser/browser-profile'; p.rename(p.with_name('old')); p.mkdir()",
    );
    expect(result.status).toBe(1);
  });
  it("catches new-product startup markers without scanning profile content", () => {
    const home = fixture();
    const result = run(
      home,
      "from pathlib import Path; p=Path.home()/'Library/Application Support/Farol Dev/farol-next-state/running.json'; p.parent.mkdir(parents=True); p.write_text('synthetic marker')",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Farol Dev/farol-next-state/running.json");
  });
  it("catches replacement of a new-product profile directory by identity", () => {
    const home = fixture();
    const profile = path.join(
      home,
      "Library/Application Support/Farol Next Preview",
    );
    fs.mkdirSync(profile, { recursive: true });
    const result = run(
      home,
      "from pathlib import Path; p=Path.home()/'Library/Application Support/Farol Next Preview'; p.rename(p.with_name('old')); p.mkdir()",
    );
    expect(result.status).toBe(1);
  });
  it.each([
    ["Dev", "tooling/dev.mjs", [], "Farol Dev", "Farol Next Preview", {}],
    [
      "Dev acceptance",
      "tooling/dev.mjs",
      ["--acceptance-profile"],
      "Farol Dev Acceptance/Farol Dev",
      "Farol Dev",
      {},
    ],
    [
      "packaged preview",
      "tooling/run-preview.mjs",
      [],
      "Farol Next Preview",
      "Farol Dev",
      { FAROL_NEXT_OWNER_LAUNCH: "1" },
    ],
  ])(
    "allows %s startup markers but still catches another profile",
    (_label, script, args, allowed, denied, environment) => {
      const home = fixture();
      const writeMarker = (profile) =>
        `from pathlib import Path; p=Path.home()/'Library/Application Support/${profile}/farol-next-state/running.json'; p.parent.mkdir(parents=True, exist_ok=True); p.write_text('synthetic marker')`;
      const allowedResult = runOwnerLaunch(
        home,
        script,
        args,
        writeMarker(allowed),
        environment,
      );
      expect(allowedResult.status, allowedResult.stderr).toBe(0);
      const deniedResult = runOwnerLaunch(
        home,
        script,
        args,
        writeMarker(denied),
        environment,
      );
      expect(deniedResult.status).toBe(1);
      expect(deniedResult.stderr).toContain(
        `${denied}/farol-next-state/running.json`,
      );
    },
  );
  it("still catches replacement of the selected owner-launch profile", () => {
    const home = fixture();
    const profile = path.join(home, "Library/Application Support/Farol Dev");
    fs.mkdirSync(profile, { recursive: true });
    const result = runOwnerLaunch(
      home,
      "tooling/dev.mjs",
      [],
      "from pathlib import Path; p=Path.home()/'Library/Application Support/Farol Dev'; p.rename(p.with_name('old')); p.mkdir()",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Farol Dev");
  });
  it("keeps the full guard for check-only Dev commands that never launch", () => {
    const home = fixture();
    const result = runOwnerLaunch(
      home,
      "tooling/dev.mjs",
      ["--check"],
      "from pathlib import Path; p=Path.home()/'Library/Application Support/Farol Dev/farol-next-state/running.json'; p.parent.mkdir(parents=True); p.write_text('synthetic marker')",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Farol Dev/farol-next-state/running.json");
  });
  it("preserves a failing child exit code", () => {
    expect(run(fixture(), "raise SystemExit(17)").status).toBe(17);
  });
});
