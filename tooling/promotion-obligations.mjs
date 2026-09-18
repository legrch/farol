import fs from "node:fs/promises";
import path from "node:path";

// What a Next generation under one user-data root still owes before another
// generation may take its place: a task that is running or whose outcome is
// unknown, a native Agent that is running or whose result the parent has not
// acknowledged, a ChatGPT turn dispatched but not delivered, and a quit whose
// owned children did not confirm they stopped. Promotion is only a copy into
// an empty destination, never a switch of the running generation, but it is
// the one activation step this product has, so it refuses while any of these
// is open. Only identities and phases are read, never content.

export const PROMOTION_OBLIGATIONS_SCHEMA =
  "farol.next.promotion-obligations/1";

const MAX_STATE_BYTES = 4 * 1024 * 1024;

async function readState(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent" };
    return { status: "unreadable" };
  }
  if (Buffer.byteLength(text) > MAX_STATE_BYTES)
    return { status: "unreadable" };
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? { status: "read", value }
      : { status: "unreadable" };
  } catch {
    return { status: "unreadable" };
  }
}

export async function activationObligations(userData) {
  if (!path.isAbsolute(userData)) {
    throw new Error("PROMOTION_USER_DATA_NOT_ABSOLUTE");
  }
  const state = path.join(userData, "farol-next-state");
  const obligations = [];
  const unreadable = [];

  const tasks = await readState(
    path.join(state, "live-tasks", "live-tasks.json"),
  );
  if (tasks.status === "unreadable") unreadable.push("live-tasks");
  else if (tasks.status === "read") {
    const list = Array.isArray(tasks.value.tasks) ? tasks.value.tasks : [];
    const running = list.filter((task) => task?.lifecycle === "running").length;
    const unknown = list.filter(
      (task) => task?.lifecycle === "outcome_unknown",
    ).length;
    const agentRunning = list.filter(
      (task) => task?.agent?.phase === "running",
    ).length;
    const agentUndelivered = list.filter(
      (task) =>
        task?.agent?.phase === "completed" &&
        task.agent.parentDelivery !== "acknowledged",
    ).length;
    if (running > 0) obligations.push(`TASK_RUNNING:${running}`);
    if (unknown > 0) obligations.push(`TASK_OUTCOME_UNKNOWN:${unknown}`);
    if (agentRunning > 0) obligations.push(`AGENT_RUNNING:${agentRunning}`);
    if (agentUndelivered > 0) {
      obligations.push(`AGENT_RESULT_UNDELIVERED:${agentUndelivered}`);
    }
  }

  const journal = await readState(
    path.join(state, "chatgpt-task-journal", "chatgpt-task-journal.json"),
  );
  if (journal.status === "unreadable") unreadable.push("chatgpt-task-journal");
  else if (journal.status === "read") {
    const phase = journal.value.phase;
    if (phase === "dispatch_intent" || phase === "result_retained") {
      obligations.push(`CHATGPT_DELIVERY_PENDING:${phase}`);
    } else if (phase === "prepared") {
      obligations.push("CHATGPT_DISPATCH_PREPARED");
    }
  }

  const quit = await readState(path.join(state, "last-quit.json"));
  if (quit.status === "unreadable") unreadable.push("last-quit");
  else if (quit.status === "read" && quit.value.drained !== true) {
    const names = Array.isArray(quit.value.unconfirmed)
      ? quit.value.unconfirmed.filter((name) => typeof name === "string")
      : [];
    obligations.push(`QUIT_UNCONFIRMED:${names.join(",") || "unknown"}`);
  }

  return {
    schema: PROMOTION_OBLIGATIONS_SCHEMA,
    userData,
    obligations,
    unreadable,
    // Only a state that could be read in full and owes nothing is drained.
    drained: obligations.length === 0 && unreadable.length === 0,
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
  if (report.obligations.length > 0) {
    throw new Error(`PROMOTION_DRAIN_REQUIRED:${report.obligations.join(",")}`);
  }
}
