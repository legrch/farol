import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ProductTaskSchema } from "../src/modules/chat/contract/product-task.ts";
import { ProductSettingsSchema } from "../src/pkg/product-settings/contract.ts";

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
// S35-03/1: each present record must have the shape ITS OWNER writes, not a
// hand-rolled approximation of it. A record the owning store would refuse
// (missing `revision`, missing `updatedAt`, an extra field, …) must be
// unreadable here too, never folded into "nothing is running" — a reduced
// record is exactly what a partial write, a truncated crash, or a forged
// file looks like. `live-tasks.json` and `product-settings.json` are
// validated against the same schemas their owners
// (`live-task-store.ts`, `../../pkg/product-settings/contract.ts`) parse
// with; `product-settings/contract.ts` is a plain schema module with no
// class, so it is imported directly. `live-task-store.ts` and
// `chatgpt-task-journal.ts` cannot be imported the same way: their classes
// use TypeScript parameter properties, which Node's unflagged type-stripping
// (the runtime this CLI ships on) refuses to run. Their record schemas are
// therefore mirrored here field-for-field from the same zod primitives,
// composed from the one shared, classless, already-exported
// `ProductTaskSchema` rather than re-describing a task by hand. Anything
// that drifts from the real store is a bug in this file, not a design
// choice, and `tests/integration/promotion-obligations.test.mjs`'s decisive
// negative control (a live-task record missing `revision`/`updatedAt`) locks
// the failure mode a hand-rolled check let through.

export const PROMOTION_OBLIGATIONS_SCHEMA =
  "farol.next.promotion-obligations/1";

const MAX_STATE_BYTES = 4 * 1024 * 1024;
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

const timestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
});

// Mirrors `StoredLiveTaskSchema` and the private `recordSchema` in
// `src/apps/desktop/live-task-store.ts` exactly (see the module comment
// above for why this is a mirror, not an import): schema 1, a revision, at
// most five tasks each shaped like the one shared `ProductTaskSchema`
// extended with the two fields the store adds, and the timestamp the store
// stamps on every save. A record missing `revision` or `updatedAt` is
// exactly the store's own `recordSchema.safeParse` failing, not an
// approximation of it.
const storedLiveTaskSchema = ProductTaskSchema.extend({
  provider: z.literal("chatgpt"),
  conversationUrl: z.url().max(2_048).nullable(),
}).refine((task) => task.lifecycle !== "event_driven");

const liveTasksRecordSchema = z.strictObject({
  schema: z.literal(1),
  revision: z.number().int().nonnegative(),
  tasks: z.array(storedLiveTaskSchema).max(5),
  updatedAt: timestampSchema,
});

function liveTasks(value) {
  return classify(liveTasksRecordSchema.safeParse(value), value);
}

// Mirrors the private `recordSchema` and `resultSchema` in
// `src/apps/desktop/chatgpt-task-journal.ts` exactly, for the same reason:
// that file's class uses TypeScript parameter properties, so it cannot be
// imported into this plain-`.mjs` CLI without a runtime type transform this
// product does not enable.
const journalOperationIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );

const journalResultSchema = z.strictObject({
  state: z.enum([
    "completed",
    "not_authenticated",
    "failed_before_submit",
    "outcome_unknown",
  ]),
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/u)
    .max(120)
    .nullable(),
  deltaCount: z.number().int().nonnegative(),
  observedCharacters: z.number().int().nonnegative(),
  attachmentCount: z.number().int().min(0).max(4),
  totalBytes: z
    .number()
    .int()
    .nonnegative()
    .max(20 * 1_024 * 1_024),
  stagingCleanup: z.enum(["removed", "pending_startup_cleanup"]).nullable(),
});

const journalRecordSchema = z.strictObject({
  schema: z.literal(1),
  operationId: journalOperationIdSchema,
  kind: z.enum(["readonly", "attachment"]),
  phase: z.enum([
    "prepared",
    "dispatch_intent",
    "result_retained",
    "delivery_acknowledged",
  ]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  result: journalResultSchema.nullable(),
});

function taskJournal(value) {
  return classify(journalRecordSchema.safeParse(value), value);
}

// product-settings.json is validated against the exact schema
// `ProductSettingsStore.load()` parses with: `ProductSettingsSchema` from
// `../../pkg/product-settings/contract.ts`. That module is plain schema and
// type exports with no class, so — unlike the two stores above — it is
// imported directly rather than mirrored, closing the gap for this file
// completely instead of by approximation.
function productSettings(value) {
  return classify(ProductSettingsSchema.safeParse(value), value);
}

// last-quit.json has no owning class either (the desktop writes it inline
// in `main.ts`), so its shape is small enough to state directly.
const quitReceiptSchema = z.strictObject({
  schema: z.literal(1),
  drained: z.boolean(),
  unconfirmed: z.array(z.string()),
});

function quitReceipt(value) {
  return classify(quitReceiptSchema.safeParse(value), value);
}

// A private regular file only: no symlink (O_NOFOLLOW refuses to open one),
// no directory or other non-regular node, no extra hard link, owned by this
// process's own user, and closed to every other user's read or write. Any
// state that is not exactly that is unsafe, whatever bytes it might hold.
async function openPrivateStateFile(file) {
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
  if (info.size > MAX_STATE_BYTES) {
    await handle.close();
    return { status: "unsafe", reason: "OVERSIZED" };
  }
  return { status: "open", handle };
}

// Every read carries the digest of the bytes it saw, so two reads of the same
// state can be compared without keeping the content.
async function readState(file, shape) {
  const opened = await openPrivateStateFile(file);
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
