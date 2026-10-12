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
  ["0.2.0-owner.beta.10", "0.2.0-owner.beta.12", true],
  ["0.2.0-owner.beta.11", "0.2.0-owner.beta.12", true],
  ["0.2.0-owner.beta.11", "0.2.0-owner.beta.13", true],
  ["0.2.0-owner.beta.11", "0.2.0", true],
  ["0.2.0-owner.beta.11", "0.3.0", true],
  // These pairs are outside this known legacy refusal, not qualified rollback.
  ["0.2.0-owner.beta.10", "0.2.0-owner.beta.11", false],
  ["0.2.0-owner.beta.11", "0.2.0-owner.beta.11", false],
  ["0.2.0-owner.beta.12", "0.2.0-owner.beta.13", false],
  ["0.2.0-owner.beta.19", "0.2.0-owner.beta.20", false],
] as const;

describe("predecessor state compatibility refusal", () => {
  it.each(pairs)("guards %s <- %s", (source, target, refused) => {
    expect(legacyPredecessorRequiresStateRecovery(source, target)).toBe(
      refused,
    );
  });

  it.each([
    "admission",
    "forward",
    "refusal-pairs",
    "identity",
    "preflight",
    "fence",
    "compatible",
  ])("the actual Python helper protects %s", (scenario) => {
    // Actual Python admission/selection/reconcile functions; explicit entry and
    // tree-check doubles only. Integration tests own real digest/inode evidence.
    // These fixtures do not qualify generic persisted-data compatibility or a
    // development beta11 label. Published beta11 / 3d71fecc is the v5-only source.
    // Red regression: the helper from 4e8bfedd must fail forward/preflight cases.
    const script = String.raw`
import importlib.util, json, os, stat, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("helper", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
pairs, scenario = json.loads(sys.argv[2]), sys.argv[3]
events, entries, trees = [], {}, {}

def forbidden(*args, **kwargs):
    events.append(("forbidden",))
    raise AssertionError("UNEXPECTED_IO_OR_EFFECT")
helper.open_home = forbidden
helper.open_dir = forbidden
helper.read_file = forbidden
helper.emit_handoff = forbidden
helper.wait_exit = forbidden
helper.process_start = forbidden
helper.subprocess = SimpleNamespace(run=forbidden, Popen=forbidden)
helper.ctypes = SimpleNamespace(CDLL=forbidden)
helper.exchange_checked = forbidden
helper.rename_checked = forbidden
helper.entry = lambda parent, name: entries.get((parent, name))

def checked_tree(parent, name, digest, version, build_id):
    # Explicit identity/digest comparison double, not a filesystem verifier.
    events.append(("check", name))
    actual = trees.get((parent, name))
    if actual is None or actual[0] != digest:
        helper.fail("digest")
    if actual[1:] != (version, build_id):
        helper.fail("build_identity")
helper.checked_tree = checked_tree
helper.write_record = lambda parent, name, record: events.append(("write", name, record))

def fence():
    events.append(("fence",))

def setup(source="0.2.0-owner.beta.11", target="0.2.0-owner.beta.12", action="recover", phase="rollback_started", **layout):
    events.clear()
    entries.clear()
    trees.clear()
    request = {"action": action, "operationId": "fixture-operation",
        "source": {"version": source, "digest": "source", "buildId": "3d71fecc" if source == "0.2.0-owner.beta.11" else "fixture-source"},
        "target": {"version": target, "digest": "target", "buildId": "fixture-target"}}
    helper.read_phase = lambda *args: phase
    for name, side in layout.items():
        parent, filename = ("apps", helper.APP) if name == "app" else ("operation", name)
        entries[parent, filename] = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700,
            st_uid=os.geteuid(), st_gid=0, st_dev=1, st_ino=len(entries) + 1)
        build = request.get(side)
        if build is not None:
            trees[parent, filename] = (build["digest"], build["version"], build["buildId"])
    return request

def effects():
    return [event for event in events if event[0] != "check"]

def refuses(call, code="predecessor_state_unqualified", allowed=()):
    events.clear()
    try:
        call()
    except helper.Refusal as error:
        assert error.code == code, (scenario, error.code, code)
    else:
        raise AssertionError("UNEXPECTED_ACCEPTANCE: " + scenario)
    assert effects() == list(allowed), events

def reconcile(request, guard=fence):
    return helper.reconcile("apps", "operation", request, guard)

def preflight(request):
    helper.inspect_recovery("apps", "operation", request)
    # A refused preflight must never reach the caller's Quit handoff.
    helper.emit_handoff(request, "waiting_for_exit")

original_pairs = [
    ("rollback_started", {"app": "target", "previous.app": "source"}),
    ("rollback_started", {"app": "source", "previous.app": "target"}),
    ("rollback_started", {"previous.app": "source", "failed.app": "target"}),
    ("rollback_started", {"app": "source", "failed.app": "target"}),
    ("predecessor_saved", {"previous.app": "source", "staged.app": "target"}),
]
unsafe_pairs = [layout for phase, layout in original_pairs[1:4]] + [
    {"app": "source", "previous.app": "source"},
    {"app": "unknown", "previous.app": "source"},
    {"app": "target", "previous.app": "unknown"},
    {"app": "target"}, {"previous.app": "source"},
    *[{"app": "target", "previous.app": "source", name: "unknown"}
        for name in ("staged.app", "failed.app", "rejected-target.json")],
]

if scenario == "admission":
    for source, target, refused in pairs:
        request = setup(source, target, action="rollback")
        if refused:
            refuses(lambda: helper.require_predecessor_state(request))
            refuses(lambda: helper.run(request))  # before open_home
        else:
            helper.require_predecessor_state(request)
elif scenario == "forward":
    for source, target, refused in pairs:
        if not refused:
            continue
        request = setup(source, target, app="target", **{"previous.app": "source"})
        before = (dict(entries), dict(trees))
        helper.inspect_recovery("apps", "operation", request)
        assert effects() == []
        events.clear()
        assert reconcile(request) == "verified"
        assert events == [("check", helper.APP), ("check", "previous.app"),
            ("fence",), ("check", helper.APP), ("check", "previous.app"),
            ("write", "journal.json", helper.record_for(request, "verified"))], events
        assert before == (entries, trees)  # one journal write, no app moves
elif scenario == "refusal-pairs":
    for source, target, refused in pairs:
        if not refused:
            continue
        for phase, layout in original_pairs:
            request = setup(source, target, action="rollback", phase=phase, **layout)
            refuses(lambda: reconcile(request))  # all five; no action bypass
        for layout in unsafe_pairs:
            request = setup(source, target, **layout)
            refuses(lambda: reconcile(request))
        request = setup(source, target, phase="predecessor_saved", **original_pairs[4][1])
        refuses(lambda: reconcile(request))
elif scenario == "identity":
    for side, location in (("target", ("apps", helper.APP)), ("source", ("operation", "previous.app"))):
        for index, code in ((0, "digest"), (1, "build_identity"), (2, "build_identity")):
            request = setup(app="target", **{"previous.app": "source"})
            changed = list(trees[location])
            changed[index] = "wrong"
            trees[location] = tuple(changed)
            build = request[side]
            refuses(lambda: helper.checked_tree(*location, build["digest"], build["version"], build["buildId"]), code)
            assert helper.matches_tree(*location, build) is False
            refuses(lambda: reconcile(request))
            refuses(lambda: preflight(request))
elif scenario == "preflight":
    for layout in unsafe_pairs:
        request = setup(**layout)
        refuses(lambda: preflight(request))  # before any Quit handoff/effect
    request = setup(action="rollback", app="target", **{"previous.app": "source"})
    refuses(lambda: preflight(request))
elif scenario == "fence":
    for change in ("app", "previous.app", "staged.app", "failed.app", "rejected-target.json", "target-digest", "source-digest", "fence-refusal"):
        request = setup(app="target", **{"previous.app": "source"})
        helper.inspect_recovery("apps", "operation", request)
        def changed_fence():
            fence()
            if change == "fence-refusal":
                helper.fail("owner_lease_lost")
            elif change.endswith("-digest"):
                location = ("apps", helper.APP) if change == "target-digest" else ("operation", "previous.app")
                trees[location] = ("changed", *trees[location][1:])
            else:
                location = ("apps", helper.APP) if change == "app" else ("operation", change)
                entries[location] = "contradiction"
                trees.pop(location, None)
        refuses(lambda: reconcile(request, changed_fence),
            "owner_lease_lost" if change == "fence-refusal" else "predecessor_state_unqualified",
            allowed=(("fence",),))  # no journal write or app move
elif scenario == "compatible":
    # Control-flow regression only, not app+state compatibility qualification.
    def exchange(left, left_name, right, right_name, *identities):
        events.append(("exchange",))
        a, b = (left, left_name), (right, right_name)
        entries[a], entries[b] = entries[b], entries[a]
        trees[a], trees[b] = trees[b], trees[a]
    def rename(left, left_name, right, right_name, *identity):
        events.append(("rename",))
        entries[right, right_name] = entries.pop((left, left_name))
        trees[right, right_name] = trees.pop((left, left_name))
    helper.exchange_checked, helper.rename_checked = exchange, rename
    for layout, moves in ((original_pairs[0][1], ["exchange", "rename"]),
            (original_pairs[1][1], ["rename"]), (original_pairs[3][1], [])):
        request = setup("0.2.0-owner.beta.8", "0.2.0-owner.beta.9", **layout)
        helper.inspect_recovery("apps", "operation", request)
        assert effects() == []
        assert reconcile(request) == "rolled_back"
        assert [event[0] for event in effects() if event[0] in ("exchange", "rename")] == moves
        assert [event for event in effects() if event[0] == "write"] == [("write", "journal.json", helper.record_for(request, "rolled_back"))]
else:
    raise AssertionError("UNKNOWN_SCENARIO")
print(scenario + " passed with explicit entry/tree-check doubles")
`;
    const result = spawnSync(
      "python3",
      [
        "-B",
        "-c",
        script,
        path.resolve("resources/native/update_helper.py"),
        JSON.stringify(pairs),
        scenario,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      `${scenario} passed with explicit entry/tree-check doubles`,
    );
  });
});
