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
for phase in ("completed",):
    results.append({"phase": phase, "args": helper.relaunch_arguments(request, phase)})
refusals = []
for phase in ("launch_requested", "verified", "unknown", "cancel_completed", "rollback_completed"):
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

// Exercise the production run branch with its filesystem/process ports replaced
// by in-memory fixtures. The predecessor deliberately ignores all startup hints.
// If it is launched, it would enter startup immediately while the lease is held.
const lifecycleProgram = `
import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location("helper", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
rows = []
for phase in ("cancelled", "rolled_back", "verified", "cancel_completed", "rollback_completed"):
    events = []
    state = {"lease": False, "eagerStarts": 0}
    helper.open_home = lambda home: 101
    helper.open_dir = lambda parent, name: parent + 1
    helper.open_owner_state = lambda home: 201
    helper.update_lock = lambda update: 301
    helper.initial_marker = lambda state, request: "original-start"
    helper.assert_parent_path = lambda *args: None
    helper.inspect_recovery = lambda *args: None
    helper.os.getpid = lambda: 22334
    helper.process_start = lambda pid: "exact-start"
    helper.emit_handoff = lambda request, phase: events.append(phase)
    helper.wait_exit = lambda *args, **kwargs: events.append("original-ended")
    helper.confirmed_quit = lambda *args: events.append("quit-confirmed")
    def acquire(*args):
        state["lease"] = True
        events.append("lease-acquired")
        return 401
    helper.owner_lease = acquire
    def verify(*args):
        assert state["lease"]
    helper.verify_owner_lease = verify
    helper.reconcile = lambda *args: phase
    helper.write_record = lambda op, name, record: events.append(record["phase"])
    def opened(args, **kwargs):
        assert state["lease"]
        events.append("open")
        hint = json.loads(args[4].split("=", 1)[1])
        if hint["buildId"] == "1" * 64:
            state["eagerStarts"] += 1
        return types.SimpleNamespace(returncode=0)
    helper.subprocess.run = opened
    def close(fd):
        if fd == 401:
            state["lease"] = False
            events.append("lease-closed")
    helper.os.close = close
    request = {"home": "/synthetic/home", "operationId": "a" * 32,
               "action": "recover", "relaunch": True,
               "pid": 11223, "processStart": "exact-start", "waitSeconds": 1,
               "source": {"buildId": "1" * 64}, "target": {"buildId": "2" * 64}}
    result = helper.run(request)
    rows.append({"original": phase, "result": result, "events": events, **state})
print(json.dumps(rows))
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
    expect(result.observed).toEqual([22334]);
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
        buildId: "2".repeat(64),
      });
    }
    expect(result.refusals).toEqual([
      "launch_phase",
      "launch_phase",
      "launch_phase",
      "launch_phase",
      "launch_phase",
      "launch_helper_identity",
    ]);
  });

  it("keeps a restored predecessor closed even when it ignores startup coordination", () => {
    const rows = JSON.parse(
      execFileSync(
        "/usr/bin/python3",
        [
          "-I",
          "-B",
          "-c",
          lifecycleProgram,
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
    for (const row of rows) {
      expect(row.lease).toBe(false);
      expect(row.eagerStarts).toBe(0);
      expect(row.events.at(-1)).toBe("lease-closed");
      if (row.original === "verified") {
        expect(row.result).toBe("completed");
        expect(row.events.slice(-4)).toEqual([
          "launch_requested",
          "open",
          "completed",
          "lease-closed",
        ]);
      } else {
        expect(row.result).toBe(row.original);
        expect(row.events).not.toContain("open");
        expect(row.events).not.toContain("cancel_launch_requested");
        expect(row.events).not.toContain("rollback_launch_requested");
      }
    }
  });
});
