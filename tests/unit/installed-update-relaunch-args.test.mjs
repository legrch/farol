// Execute only the argument encoder from the existing helper with all process
// observation replaced by fixtures. No lease, app, swap or launch is performed.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const program = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("helper", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
calls = []
helper.os.getpid = lambda: 22334
def start(pid):
    calls.append(pid)
    return "Tue Oct  6 22:00:00 2026"
helper.process_start = start
request = {"home": "/synthetic/home", "operationId": "a" * 32,
           "action": "recover", "source": {"buildId": "1" * 64},
           "target": {"buildId": "2" * 64}}
results = []
for phase in ("completed", "cancel_completed", "rollback_completed"):
    results.append({"phase": phase, "args": helper.relaunch_arguments(request, phase)})
refusals = []
for phase in ("launch_requested", "verified", "unknown"):
    try:
        helper.relaunch_arguments(request, phase)
    except helper.Refusal as error:
        refusals.append(error.code)
helper.process_start = lambda pid: None
try:
    helper.relaunch_arguments(request, "completed")
except helper.Refusal as error:
    refusals.append(error.code)
print(json.dumps({"results": results, "observed": calls, "refusals": refusals}))
`;

describe("installed helper relaunch correlation (pure encoding)", () => {
  it("encodes the original helper and exact selected build without exposing paths as startup authority", () => {
    const result = JSON.parse(
      execFileSync(
        "/usr/bin/python3",
        [
          "-I",
          "-B",
          "-c",
          program,
          path.resolve("resources/native/update_helper.py"),
        ],
        {
          encoding: "utf8",
          timeout: 3000,
          maxBuffer: 8192,
          env: { PATH: "/usr/bin:/bin", LANG: "C" },
        },
      ),
    );
    expect(result.observed).toEqual([22334, 22334, 22334]);
    for (const { phase, args } of result.results) {
      expect(args.slice(0, 4)).toEqual([
        "/usr/bin/open",
        "-a",
        "/synthetic/home/Applications/Farol.app",
        "--args",
      ]);
      expect(args).toHaveLength(5);
      const prefix = "--farol-installed-update-relaunch=";
      expect(args[4].startsWith(prefix)).toBe(true);
      expect(JSON.parse(args[4].slice(prefix.length))).toEqual({
        operationId: "a".repeat(32),
        action: "recover",
        phase,
        helper: { pid: 22334, processStart: "Tue Oct  6 22:00:00 2026" },
        buildId: (phase === "completed" ? "2" : "1").repeat(64),
      });
    }
    expect(result.refusals).toEqual([
      "launch_phase",
      "launch_phase",
      "launch_phase",
      "launch_helper_identity",
    ]);
  });
});
