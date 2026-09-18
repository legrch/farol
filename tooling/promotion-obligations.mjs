import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// What a Next generation under one user-data root still owes before another
// generation may take its place: a task that is running or whose outcome is
// unknown, a native Agent that is running or whose result the parent has not
// acknowledged, a ChatGPT turn dispatched but not delivered, a guarded edit
// recorded before it ran and not yet acknowledged, and a quit whose owned
// children did not confirm they stopped. Promotion is only a copy into an
// empty destination, never a switch of the running generation, but it is the
// one activation step this product has, so it refuses while any of these is
// open. Only identities and phases are read, never content.
//
// Each present record must have the shape its owner writes: the supported
// schema, the collection it names and a closed phase for every entry. A
// record that parses but does not have that shape is unreadable, never an
// empty obligation; only an absent record owes nothing.

export const PROMOTION_OBLIGATIONS_SCHEMA =
  "farol.next.promotion-obligations/1";

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const TASK_LIFECYCLES = new Set([
  "event_driven",
  "idle",
  "running",
  "cancelled",
  "completed",
  "failed",
  "outcome_unknown",
]);
const AGENT_PHASES = new Set([
  "running",
  "completed",
  "cancelled",
  "failed",
  "outcome_unknown",
]);
const PARENT_DELIVERIES = new Set([
  "not_applicable",
  "pending",
  "acknowledged",
]);
const JOURNAL_PHASES = new Set([
  "prepared",
  "dispatch_intent",
  "result_retained",
  "delivery_acknowledged",
]);

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

// live-tasks.json as live-task-store writes it: schema 1 and at most five
// stored tasks, each with a lifecycle from the product's closed set and, when
// it has one, an Agent with a closed phase and delivery state.
function liveTasks(value) {
  const stored = record(value);
  if (
    !stored ||
    stored.schema !== 1 ||
    !Array.isArray(stored.tasks) ||
    stored.tasks.length > 5
  ) {
    return null;
  }
  const tasks = [];
  for (const entry of stored.tasks) {
    const task = record(entry);
    if (
      !task ||
      typeof task.taskId !== "string" ||
      !TASK_LIFECYCLES.has(task.lifecycle)
    ) {
      return null;
    }
    let agent = null;
    if (task.agent !== undefined && task.agent !== null) {
      const candidate = record(task.agent);
      if (
        !candidate ||
        !AGENT_PHASES.has(candidate.phase) ||
        !PARENT_DELIVERIES.has(candidate.parentDelivery)
      ) {
        return null;
      }
      agent = {
        phase: candidate.phase,
        parentDelivery: candidate.parentDelivery,
      };
    }
    tasks.push({ lifecycle: task.lifecycle, agent });
  }
  return { tasks };
}

// chatgpt-task-journal.json as chatgpt-task-journal writes it: schema 1 and
// one closed phase.
function taskJournal(value) {
  const stored = record(value);
  if (!stored || stored.schema !== 1 || !JOURNAL_PHASES.has(stored.phase)) {
    return null;
  }
  return { phase: stored.phase };
}

// last-quit.json as the desktop's quit receipt writes it.
function quitReceipt(value) {
  const stored = record(value);
  if (
    !stored ||
    stored.schema !== 1 ||
    typeof stored.drained !== "boolean" ||
    !Array.isArray(stored.unconfirmed) ||
    !stored.unconfirmed.every((name) => typeof name === "string")
  ) {
    return null;
  }
  return { drained: stored.drained, unconfirmed: stored.unconfirmed };
}

// product-settings.json as the configuration service writes it: schema 1,
// and under computer the guarded edit recorded before it ran, cleared only by
// the acknowledgment of that exact operation. Only its identity is read.
function productSettings(value) {
  const stored = record(value);
  if (!stored || stored.schema !== 1) return null;
  const computer = record(stored.computer);
  if (!computer) return null;
  if (computer.pendingEdit === undefined || computer.pendingEdit === null) {
    return { pendingEdit: null };
  }
  const pending = record(computer.pendingEdit);
  if (
    !pending ||
    typeof pending.operationId !== "string" ||
    !pending.operationId
  ) {
    return null;
  }
  return { pendingEdit: { operationId: pending.operationId } };
}

// Every read carries the digest of the bytes it saw, so two reads of the same
// state can be compared without keeping the content.
async function readState(file, shape) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent", digest: null };
    return { status: "unreadable", digest: null };
  }
  const digest = createHash("sha256").update(text).digest("hex");
  if (Buffer.byteLength(text) > MAX_STATE_BYTES)
    return { status: "unreadable", digest };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "unreadable", digest };
  }
  const value = shape(parsed);
  return value
    ? { status: "read", value, digest }
    : { status: "unreadable", digest };
}

const STATE_FILES = Object.freeze([
  ["live-tasks", ["live-tasks", "live-tasks.json"], liveTasks],
  [
    "chatgpt-task-journal",
    ["chatgpt-task-journal", "chatgpt-task-journal.json"],
    taskJournal,
  ],
  ["product-settings", ["product-settings.json"], productSettings],
  ["last-quit", ["last-quit.json"], quitReceipt],
]);

async function readStateFiles(state) {
  const read = {};
  for (const [name, segments, shape] of STATE_FILES) {
    read[name] = await readState(path.join(state, ...segments), shape);
  }
  return read;
}

// The four state files are read one after another, so a generation that
// admits a turn between two of those reads could be classified from a mix of
// its before and after. The files are therefore read twice and the decision
// is taken only on a state whose bytes did not change between the two reads;
// `options.beforeConfirmation` is the seam between them, used by tests to
// change the state meanwhile.
export async function activationObligations(userData, options = {}) {
  if (!path.isAbsolute(userData)) {
    throw new Error("PROMOTION_USER_DATA_NOT_ABSOLUTE");
  }
  const state = path.join(userData, "farol-next-state");
  const obligations = [];
  const unreadable = [];

  const first = await readStateFiles(state);
  await options.beforeConfirmation?.();
  const confirmed = await readStateFiles(state);
  const changed = STATE_FILES.map(([name]) => name).filter(
    (name) => first[name].digest !== confirmed[name].digest,
  );

  const tasks = confirmed["live-tasks"];
  if (tasks.status === "unreadable") unreadable.push("live-tasks");
  else if (tasks.status === "read") {
    const list = tasks.value.tasks;
    const running = list.filter((task) => task.lifecycle === "running").length;
    const unknown = list.filter(
      (task) => task.lifecycle === "outcome_unknown",
    ).length;
    const agentRunning = list.filter(
      (task) => task.agent?.phase === "running",
    ).length;
    const agentUndelivered = list.filter(
      (task) =>
        task.agent?.phase === "completed" &&
        task.agent.parentDelivery !== "acknowledged",
    ).length;
    if (running > 0) obligations.push(`TASK_RUNNING:${running}`);
    if (unknown > 0) obligations.push(`TASK_OUTCOME_UNKNOWN:${unknown}`);
    if (agentRunning > 0) obligations.push(`AGENT_RUNNING:${agentRunning}`);
    if (agentUndelivered > 0) {
      obligations.push(`AGENT_RESULT_UNDELIVERED:${agentUndelivered}`);
    }
  }

  const journal = confirmed["chatgpt-task-journal"];
  if (journal.status === "unreadable") unreadable.push("chatgpt-task-journal");
  else if (journal.status === "read") {
    const phase = journal.value.phase;
    if (phase === "dispatch_intent" || phase === "result_retained") {
      obligations.push(`CHATGPT_DELIVERY_PENDING:${phase}`);
    } else if (phase === "prepared") {
      obligations.push("CHATGPT_DISPATCH_PREPARED");
    }
  }

  const settings = confirmed["product-settings"];
  if (settings.status === "unreadable") unreadable.push("product-settings");
  else if (settings.status === "read" && settings.value.pendingEdit) {
    obligations.push(
      `EDIT_DELIVERY_PENDING:${settings.value.pendingEdit.operationId}`,
    );
  }

  const quit = confirmed["last-quit"];
  if (quit.status === "unreadable") unreadable.push("last-quit");
  else if (quit.status === "read" && !quit.value.drained) {
    obligations.push(
      `QUIT_UNCONFIRMED:${quit.value.unconfirmed.join(",") || "unknown"}`,
    );
  }

  return {
    schema: PROMOTION_OBLIGATIONS_SCHEMA,
    userData,
    obligations,
    unreadable,
    changed,
    // Only a state that could be read in full, held still while it was read,
    // and owes nothing is drained.
    drained:
      obligations.length === 0 &&
      unreadable.length === 0 &&
      changed.length === 0,
  };
}

// Where the product keeps its state for an owner home: Electron's default
// user-data directory for the app name the desktop sets.
export function promotionUserData(home) {
  if (!path.isAbsolute(home)) throw new Error("PROMOTION_HOME_NOT_ABSOLUTE");
  return path.join(
    home,
    "Library",
    "Application Support",
    "Farol Next Preview",
  );
}

export function assertActivationDrained(report) {
  if (report.unreadable.length > 0) {
    throw new Error(
      `PROMOTION_STATE_UNREADABLE:${report.unreadable.join(",")}`,
    );
  }
  if ((report.changed ?? []).length > 0) {
    throw new Error(`PROMOTION_STATE_CHANGED:${report.changed.join(",")}`);
  }
  if (report.obligations.length > 0) {
    throw new Error(`PROMOTION_DRAIN_REQUIRED:${report.obligations.join(",")}`);
  }
}
