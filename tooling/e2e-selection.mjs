// Targeted repro for the ordinary end-to-end lane.
//
// `--only=<selector>[,<selector>…]` runs a subset of the lane's segments so a
// single journey can be re-driven against the real application without the
// whole lane.  A selector is either a segment name below or a case-id prefix
// one of the segments owns.
//
// Selection is a convenience for reproduction, never a way to shorten a
// qualifying run.  A selected run is reported as SELECTED: it is never PASS,
// so `evidence-eligibility` — which rejects every non-PASS outcome — can never
// bind it, and it can never stand in for a lane's required cases.  That status
// is what keeps a partial run honest, which is why the declared cases below
// are prefixes rather than an exhaustive index: adding a case to the runner
// does not require touching this table.
import assert from "node:assert/strict";

export const SELECTABLE_SEGMENTS = Object.freeze([
  Object.freeze({ name: "ordinary-startup", cases: ["ordinary-launch"] }),
  Object.freeze({
    name: "live-tasks",
    cases: [
      "accessible-contrast",
      "five-live",
      "hit-targets",
      "idle-live",
      "layout-breakpoints",
      "live-task",
      "ordinary-live",
      "ordinary-new",
      "reduced-motion",
      "running-live",
      "shared-chatgpt",
      "sixth-live",
    ],
  }),
  Object.freeze({
    name: "chatgpt-recovery",
    cases: ["chatgpt-dispatch", "chatgpt-recovered"],
  }),
  Object.freeze({
    name: "demo-main",
    cases: [
      "activity-detail",
      "activity-redaction",
      "chatgpt-attachment",
      "chatgpt-context",
      "chatgpt-conversation",
      "chatgpt-explicit",
      "chatgpt-next",
      "chatgpt-popup",
      "chatgpt-readonly",
      "chatgpt-same",
      "chatgpt-session",
      "chatgpt-task",
      "client-delivery",
      "compact-layout",
      "compact-sidebar",
      "computer-exact",
      "explicit-demo",
      "first-run",
      "geist-resource",
      "inactive-window",
      "incremental-before",
      "isolated-state",
      "keyboard-focus",
      "mismatched-build",
      "native-agent",
      "native-codex",
      "native-workspace",
      "packaged-launcher",
      "quick-switcher",
      "rail-hit",
      "running-build",
      "second-launch",
      "settings-controls",
      "settings-links",
      "settings-native",
      "settings-setup",
      "setup-hides",
      "setup-position",
      "sidebar-native",
      "stable-layout",
      "support-export",
      "task-capability",
      "task-menu",
      "task-network",
      "traffic-light",
      "two-tabs",
      "visible-window",
      "watch-rail",
      "window-close",
      "window-reopen",
      "workspace-app",
      "workspace-command",
      "workspace-exclusion",
      "workspace-guarded",
      "workspace-native",
      "workspace-read",
      "workspace-write",
    ],
  }),
  Object.freeze({ name: "legacy-start-order", cases: ["isolated-start"] }),
  Object.freeze({ name: "provider-failure", cases: ["provider-failure"] }),
  Object.freeze({ name: "stream-failure", cases: ["task-stream"] }),
  Object.freeze({
    name: "process-death",
    cases: [
      "fault-scenarios",
      "isolated-start",
      "next-only",
      "quit-terminates",
      "utility-process",
    ],
  }),
  Object.freeze({ name: "fence-unheld", cases: ["connector-refuses"] }),
  Object.freeze({ name: "fence-reconciled", cases: ["connector-start"] }),
  Object.freeze({ name: "ux34-settings-widths", cases: ["ux34-settings"] }),
  Object.freeze({ name: "ux34-sidebar-toggle", cases: ["ux34-sidebar"] }),
  Object.freeze({
    name: "ux34-sign-in-return",
    cases: ["ux34-covered", "ux34-sign"],
  }),
  Object.freeze({ name: "n04b-model", cases: ["n04b-model"] }),
  Object.freeze({ name: "n09-connector", cases: ["n09-connector"] }),
  Object.freeze({
    name: "n09-connector-attachment",
    cases: ["n09-attach"],
  }),
  Object.freeze({ name: "n11-agent-scope", cases: ["n11-agent"] }),
  Object.freeze({ name: "n12-agent-draft", cases: ["n12-agent"] }),
  Object.freeze({ name: "n10-computer-panel", cases: ["n10-computer"] }),
]);

export const SELECTION_OPTION_PREFIX = "--only=";

// A selector matches a segment by its exact name, or by sharing a prefix with
// a case family the segment owns, so both `--only=ux34-sign-in-return` and
// `--only=ux34-sign-in-return-pointer` reach the same segment.  An unmatched
// selector fails the run before anything launches: a typo must not quietly
// produce an empty, green-looking attempt.
export function resolveSelection(requested, segments = SELECTABLE_SEGMENTS) {
  const unique = [...new Set(requested)];
  assert.ok(unique.length > 0, "E2E_EMPTY_SELECTION");
  const selected = new Set();
  const unmatched = [];
  for (const selector of unique) {
    const hits = segments.filter(
      (segment) =>
        segment.name === selector ||
        segment.cases.some(
          (owned) => owned.startsWith(selector) || selector.startsWith(owned),
        ),
    );
    if (hits.length === 0) unmatched.push(selector);
    for (const hit of hits) selected.add(hit.name);
  }
  assert.deepEqual(
    unmatched,
    [],
    `E2E_UNKNOWN_SELECTION:${unmatched.join(",")}`,
  );
  return Object.freeze({
    requested: Object.freeze(unique),
    segments: Object.freeze([...selected].sort()),
  });
}

export function createSelection(argv, segments = SELECTABLE_SEGMENTS) {
  const raw = argv.find((value) => value.startsWith(SELECTION_OPTION_PREFIX));
  if (raw === undefined) return null;
  return resolveSelection(
    raw
      .slice(SELECTION_OPTION_PREFIX.length)
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
    segments,
  );
}

// Every gate in the runner names a segment declared above, so a typo in a gate
// is a startup failure rather than a silently skipped journey.
export function isSegmentSelected(
  selection,
  name,
  segments = SELECTABLE_SEGMENTS,
) {
  assert.ok(
    segments.some((segment) => segment.name === name),
    `E2E_UNDECLARED_SEGMENT:${name}`,
  );
  return selection === null || selection.segments.includes(name);
}
