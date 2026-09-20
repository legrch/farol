import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ProductTaskSchema } from "../src/modules/chat/contract/product-task.ts";
import { ProductSettingsSchema } from "../src/pkg/product-settings/contract.ts";
import {
  CHATGPT_TASK_JOURNAL_FILE_NAME,
  ChatGptTaskJournalRecordSchema,
  MAX_CHATGPT_TASK_JOURNAL_BYTES,
} from "../src/apps/desktop/chatgpt-task-journal-record.ts";
import {
  LIVE_TASK_FILE_NAME,
  MAX_LIVE_TASK_BYTES,
  liveTaskRecordSchemas,
} from "../src/apps/desktop/live-task-record.ts";
import {
  MAX_QUIT_RECEIPT_BYTES,
  QUIT_RECEIPT_FILE_NAME,
  QuitReceiptSchema,
} from "../src/apps/desktop/quit-receipt.ts";
import {
  MAX_RUN_MARKER_BYTES,
  RUN_MARKER_FILE_NAME,
  RunMarkerSchema,
  classifyRunMarker,
  currentBootTimeMs,
  processAlive,
} from "../src/apps/desktop/run-marker.ts";

// What a Next generation under one user-data root still owes before another
// generation may take its place: a task that is running or whose outcome is
// unknown, a native Agent that is running or whose result the parent has not
// acknowledged, a ChatGPT turn dispatched but not delivered, a guarded edit
// recorded before it ran and not yet acknowledged, a quit whose owned
// children did not confirm they stopped, and — through the run marker — an
// app that is still running or that stopped without confirming its drain
// at all. Promotion is only a copy into an empty destination, never a
// switch of the running generation, but it is the one activation step this
// product has, so it refuses while any of these is open. Only identities
// and phases are read, never content.
//
// Each present record must have the shape ITS OWNER writes, and is read
// under ITS OWNER's byte bound. A record the owning store would refuse
// (missing `revision`, missing `updatedAt`, an extra field, a file past the
// store's decode limit, …) must be unreadable here too, never folded into
// "nothing is running" — a reduced record is exactly what a partial write,
// a truncated crash, or a forged file looks like. Nothing is mirrored by
// hand any more: the schemas and bounds are imported from the plain modules
// the owners themselves parse and write with —
// `src/apps/desktop/live-task-record.ts` (built from the same shared
// `ProductTaskSchema` the store passes in, see that module for why the task
// schema is a parameter), `src/apps/desktop/chatgpt-task-journal-record.ts`,
// `src/pkg/product-settings/contract.ts`, `src/apps/desktop/quit-receipt.ts`
// and `src/apps/desktop/run-marker.ts`. All of them are class-free and
// enum-free so Node's unflagged type stripping, the runtime this CLI ships
// on, can load them. `tests/integration/promotion-schema-parity.test.mjs`
// drives one corpus through the owning stores and through this reader and
// holds both to the same accept/reject decision.

export const PROMOTION_OBLIGATIONS_SCHEMA =
  "farol.next.promotion-obligations/1";

// `product-settings.json`'s decode bound. `ProductSettingsStore`
// (`src/apps/desktop/product-configuration.ts`) keeps its `MAXIMUM_BYTES`
// private and that file is not this change's to edit, so the bound is
// restated here — the one bound in this file that is not imported from its
// owner. The parity test holds the store and this reader to the same
// refusal on a padded record, which is how a private constant is kept
// honest from outside until the store exports it.
export const PRODUCT_SETTINGS_MAX_BYTES = 256 * 1024;

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CLOSE_ON_EXEC = fsConstants.O_CLOEXEC ?? 0;

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;
}

const ok = (value) => ({ ok: true, value });
const malformed = () => ({ ok: false, reason: "MALFORMED" });
const unknownVersion = () => ({ ok: false, reason: "UNKNOWN_VERSION" });

// A schema-literal mismatch on an otherwise plain-object record is always a
// future or older version, never merely malformed; everything else zod
// refuses (missing field, wrong type, unknown key on a strict object, wrong
// array length, …) is malformed. This is the one rule every shape below
// shares, so it lives once instead of being re-decided per store.
function classify(parsed, raw) {
  if (parsed.success) return ok(parsed.data);
  const top = record(raw);
  if (top && top.schema !== undefined && top.schema !== 1) {
    return unknownVersion();
  }
  return malformed();
}

// The exact record schema `PrivateLiveTaskStore` parses with, built from the
// same factory and the same shared task schema the store passes in.
const liveTasksRecordSchema = liveTaskRecordSchemas(ProductTaskSchema).record;

function liveTasks(value) {
  return classify(liveTasksRecordSchema.safeParse(value), value);
}

function taskJournal(value) {
  return classify(ChatGptTaskJournalRecordSchema.safeParse(value), value);
}

function productSettings(value) {
  return classify(ProductSettingsSchema.safeParse(value), value);
}

function quitReceipt(value) {
  return classify(QuitReceiptSchema.safeParse(value), value);
}

function runMarker(value) {
  return classify(RunMarkerSchema.safeParse(value), value);
}

// A private regular file only: no symlink (O_NOFOLLOW refuses to open one),
// no directory or other non-regular node, no extra hard link, owned by this
// process's own user, closed to every other user's read or write, and no
// larger than its owner is willing to decode. Any state that is not exactly
// that is unsafe, whatever bytes it might hold.
async function openPrivateStateFile(file, maxBytes) {
  let handle;
  try {
    handle = await fs.open(
      file,
      fsConstants.O_RDONLY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "absent" };
    if (error?.code === "ELOOP") return { status: "unsafe", reason: "SYMLINK" };
    return { status: "unsafe", reason: "UNSAFE" };
  }
  const info = await handle.stat();
  const effectiveUser = process.geteuid?.();
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    (effectiveUser !== undefined && info.uid !== effectiveUser) ||
    (info.mode & 0o077) !== 0
  ) {
    await handle.close();
    return { status: "unsafe", reason: "UNSAFE" };
  }
  if (info.size > maxBytes) {
    await handle.close();
    return { status: "unsafe", reason: "OVERSIZED" };
  }
  return { status: "open", handle };
}

// Every read carries the digest of the bytes it saw, so two reads of the same
// state can be compared without keeping the content.
async function readState(file, shape, maxBytes) {
  const opened = await openPrivateStateFile(file, maxBytes);
  if (opened.status === "absent") return { status: "absent", digest: null };
  if (opened.status === "unsafe") {
    return { status: "unreadable", digest: null, reason: opened.reason };
  }
  let text;
  try {
    text = await opened.handle.readFile("utf8");
  } finally {
    await opened.handle.close();
  }
  const digest = createHash("sha256").update(text).digest("hex");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "unreadable", digest, reason: "CORRUPT" };
  }
  const outcome = shape(parsed);
  return outcome.ok
    ? { status: "read", value: outcome.value, digest }
    : { status: "unreadable", digest, reason: outcome.reason };
}

// name, path under farol-next-state, owner's shape, owner's decode bound.
const STATE_FILES = Object.freeze([
  [
    "live-tasks",
    ["live-tasks", LIVE_TASK_FILE_NAME],
    liveTasks,
    MAX_LIVE_TASK_BYTES,
  ],
  [
    "chatgpt-task-journal",
    ["chatgpt-task-journal", CHATGPT_TASK_JOURNAL_FILE_NAME],
    taskJournal,
    MAX_CHATGPT_TASK_JOURNAL_BYTES,
  ],
  [
    "product-settings",
    ["product-settings.json"],
    productSettings,
    PRODUCT_SETTINGS_MAX_BYTES,
  ],
  ["last-quit", [QUIT_RECEIPT_FILE_NAME], quitReceipt, MAX_QUIT_RECEIPT_BYTES],
  ["running", [RUN_MARKER_FILE_NAME], runMarker, MAX_RUN_MARKER_BYTES],
]);

async function readStateFiles(state) {
  const read = {};
  for (const [name, segments, shape, maxBytes] of STATE_FILES) {
    read[name] = await readState(
      path.join(state, ...segments),
      shape,
      maxBytes,
    );
  }
  return read;
}

// The state files are read one after another, so a generation that admits a
// turn between two of those reads could be classified from a mix of its
// before and after. The files are therefore read twice and the decision is
// taken only on a state whose bytes did not change between the two reads;
// `options.beforeConfirmation` is the seam between them, used by tests to
// change the state meanwhile.
//
// `options.bootTime` (this machine's boot time as `currentBootTimeMs`
// reports it, or null when it cannot be read) and `options.isAlive` are the
// run marker's probes; a caller that leaves them out gets the real machine.
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
  if (tasks.status === "unreadable")
    unreadable.push(`live-tasks:${tasks.reason}`);
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
  if (journal.status === "unreadable")
    unreadable.push(`chatgpt-task-journal:${journal.reason}`);
  else if (journal.status === "read") {
    const phase = journal.value.phase;
    if (phase === "dispatch_intent" || phase === "result_retained") {
      obligations.push(`CHATGPT_DELIVERY_PENDING:${phase}`);
    } else if (phase === "prepared") {
      obligations.push("CHATGPT_DISPATCH_PREPARED");
    }
  }

  const settings = confirmed["product-settings"];
  if (settings.status === "unreadable")
    unreadable.push(`product-settings:${settings.reason}`);
  else if (settings.status === "read" && settings.value.computer.pendingEdit) {
    obligations.push(
      `EDIT_DELIVERY_PENDING:${settings.value.computer.pendingEdit.operationId}`,
    );
  }

  const quit = confirmed["last-quit"];
  if (quit.status === "unreadable") unreadable.push(`last-quit:${quit.reason}`);
  else if (quit.status === "read" && !quit.value.drained) {
    obligations.push(
      `QUIT_UNCONFIRMED:${quit.value.unconfirmed.join(",") || "unknown"}`,
    );
  }

  // The run marker is written at app start and removed only after a
  // confirmed drain (see `run-marker.ts`). Present, it means the app is
  // still running (a live pid written on this boot) or it stopped without
  // confirming its drain (a dead pid, or a pid from another boot). A marker
  // whose boot cannot be established on either side is not classified at
  // all: it is reported unreadable rather than guessed at.
  const marker = confirmed["running"];
  if (marker.status === "unreadable") {
    unreadable.push(`running:${marker.reason}`);
  } else if (marker.status === "read") {
    const verdict = classifyRunMarker(marker.value, {
      bootTime:
        options.bootTime === undefined ? currentBootTimeMs() : options.bootTime,
      isAlive: options.isAlive ?? processAlive,
    });
    if (verdict === "running") {
      obligations.push(`APP_RUNNING:${marker.value.pid}`);
    } else if (verdict === "crashed") {
      obligations.push("QUIT_UNCONFIRMED:crash");
    } else {
      unreadable.push("running:BOOT_UNKNOWN");
    }
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
