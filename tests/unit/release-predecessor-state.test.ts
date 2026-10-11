import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyPredecessorRequiresStateRecovery } from "../../src/modules/release/domain/predecessor-state";

const pairs = [
  ["0.1.11-owner.beta.1", "0.2.0-owner.beta.2", true],
  ["0.1.0", "0.1.1", false],
  ["0.2.0-owner.beta.3", "0.2.0-owner.beta.4", true],
  ["0.2.0-owner.beta.3", "0.2.0-owner.beta.5", true],
  ["0.2.0-owner.beta.3", "0.2.0-owner.beta.3", true],
  ["0.2.0-owner.beta.5", "0.2.0-owner.beta.6", false],
  ["0.2.0-owner.beta.8", "0.2.0-owner.beta.9", false],
  ["0.2.0-owner.beta.9", "0.2.0-owner.beta.9", false],
  ["0.2.0-owner.beta.9", "0.2.0-owner.beta.10", true],
  ["0.2.0-owner.beta.8", "0.2.0-owner.beta.10", true],
  ["0.2.0-owner.beta.4", "0.2.0-owner.beta.11", true],
  ["0.2.0-owner.beta.9", "0.2.0", true],
  ["0.2.0-owner.beta.9", "0.3.0", true],
  // These pairs are outside this known legacy refusal, not qualified rollback.
  ["0.2.0-owner.beta.10", "0.2.0-owner.beta.11", false],
  ["0.2.0-owner.beta.19", "0.2.0-owner.beta.20", false],
] as const;

describe("predecessor state compatibility refusal", () => {
  it.each(pairs)("guards %s <- %s", (source, target, refused) => {
    expect(legacyPredecessorRequiresStateRecovery(source, target)).toBe(
      refused,
    );
  });

  it("the actual Python helper refuses old readers before rollback or recovery mutation", () => {
    // Import only: no helper launch, app/profile IO or native rename. The real
    // admission/reconcile functions run against explicit process/file doubles.
    const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("helper", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
for source, target, refused in json.loads(sys.argv[2]):
    request = {"source": {"version": source}, "target": {"version": target}}
    actual = False
    try:
        helper.require_predecessor_state(request)
    except helper.Refusal as error:
        assert error.code == "predecessor_state_unqualified"
        actual = True
    assert actual == refused, (source, target, actual)

request = {"action": "rollback", "source": {"version": "0.2.0-owner.beta.3", "digest": "source", "buildId": "old"}, "target": {"version": "0.2.0-owner.beta.5", "digest": "target", "buildId": "new"}}
effects = []
def forbidden(*args):
    effects.append(args)
    raise AssertionError("UNEXPECTED_MUTATION")
helper.open_home = forbidden
helper.exchange_checked = forbidden
helper.rename_checked = forbidden
helper.write_record = forbidden
helper.checked_tree = lambda *args: None
helper.matches_tree = lambda *args: True
helper.identity = lambda value: value

def refuses(call):
    try:
        call()
    except helper.Refusal as error:
        assert error.code == "predecessor_state_unqualified"
    else:
        raise AssertionError("UNEXPECTED_ACCEPTANCE")
    assert effects == []

for source, target, refused in json.loads(sys.argv[2]):
    if not refused:
        continue
    request["source"]["version"] = source
    request["target"]["version"] = target
    refuses(lambda: helper.run(request))
    for phase, entries in [
        ("rollback_started", {helper.APP: "app", "previous.app": "previous"}),
        ("rollback_started", {"previous.app": "previous", "failed.app": "failed"}),
        ("predecessor_saved", {"previous.app": "previous", "staged.app": "staged"}),
    ]:
        helper.read_phase = lambda *args: phase
        helper.entry = lambda parent, name: entries.get(name)
        refuses(lambda: helper.reconcile("apps", "operation", request, forbidden))
print("guard + rollback + three recovery paths refused before effects")
`;
    const result = spawnSync(
      "python3",
      [
        "-B",
        "-c",
        script,
        path.resolve("resources/native/update_helper.py"),
        JSON.stringify(pairs),
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "guard + rollback + three recovery paths refused before effects",
    );
  });
});
