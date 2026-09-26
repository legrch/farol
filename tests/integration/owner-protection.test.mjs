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
  it("preserves a failing child exit code", () => {
    expect(run(fixture(), "raise SystemExit(17)").status).toBe(17);
  });
});
