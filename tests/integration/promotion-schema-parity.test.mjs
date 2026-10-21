import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrivateChatGptTaskJournal } from "../../src/apps/desktop/chatgpt-task-journal.ts";
import { MAX_CHATGPT_TASK_JOURNAL_BYTES } from "../../src/apps/desktop/chatgpt-task-journal-record.ts";
import { MAX_LIVE_TASK_BYTES } from "../../src/apps/desktop/live-task-record.ts";
import { PrivateLiveTaskStore } from "../../src/apps/desktop/live-task-store.ts";
import { ProductSettingsStore } from "../../src/apps/desktop/product-configuration.ts";
import {
  PRODUCT_SETTINGS_MAX_BYTES,
  activationObligations,
} from "../../tooling/promotion-obligations.mjs";

// One corpus per state file, driven through the OWNING store's parser and
// through the promotion reader. The two must agree on every record: what
// the store refuses, promotion reports unreadable; what the store accepts,
// promotion classifies. In particular a file past the store's decode bound
// is refused by both even when the bytes inside are a valid record — a
// promotion that read it would be trusting a file its owner never would.
const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function userData() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "farol-parity-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "farol-state"), {
    recursive: true,
    mode: 0o700,
  });
  return root;
}

function task(overrides = {}) {
  return {
    taskId: "task-a",
    sessionId: "task-a",
    turnId: "turn-a",
    label: "Task",
    provider: "chatgpt",
    requestedModel: null,
    observedModel: null,
    requestedMode: null,
    observedMode: null,
    hasComputer: false,
    pinned: false,
    lifecycle: "idle",
    conversationUrl: null,
    ...overrides,
  };
}

const timestamp = "2026-09-18T16:00:00.000Z";

const validTasks = {
  schema: 1,
  revision: 1,
  tasks: [task(), task({ taskId: "task-b", lifecycle: "completed" })],
  updatedAt: timestamp,
};

const validJournal = {
  schema: 1,
  operationId: "00000000-0000-4000-8000-000000000abc",
  kind: "readonly",
  phase: "delivery_acknowledged",
  createdAt: timestamp,
  updatedAt: timestamp,
  result: {
    state: "completed",
    code: null,
    deltaCount: 3,
    observedCharacters: 147,
    attachmentCount: 0,
    totalBytes: 0,
    stagingCleanup: null,
  },
};

const readiness = () => ({
  visited: false,
  skipped: false,
  configured: false,
  reachable: "unknown",
  verified: null,
  needsAction: null,
  unavailable: null,
  outcomeUnknown: false,
});

const validSettings = {
  schema: 1,
  revision: 7,
  general: {
    openAtLaunch: "browser",
    sidebarDefault: "full",
    activityDetail: "summary",
  },
  computer: {
    computerId: "00000000-0000-4000-8000-000000000c01",
    generation: 3,
    name: "Test",
    commands: "none",
    workspaces: [],
    pendingEdit: null,
  },
  setup: {
    chatgpt: readiness(),
    computer: readiness(),
    connect: readiness(),
    hosts: readiness(),
    verify: readiness(),
  },
};

const without = (value, key) => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

// Pads a serialized record with whitespace to exactly `bytes` bytes: JSON
// with leading whitespace is still the same JSON to every parser here.
function padded(value, bytes) {
  const text = JSON.stringify(value);
  return `${" ".repeat(bytes - Buffer.byteLength(text))}${text}`;
}

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, text, { mode: 0o600 });
}

async function storeOutcome(load) {
  try {
    await load();
    return "accept";
  } catch (error) {
    return error instanceof Error ? error.message : "unknown";
  }
}

function promotionOutcome(report, name) {
  const entry = report.unreadable.find((item) => item.startsWith(`${name}:`));
  return entry ? entry.slice(name.length + 1) : "accept";
}

async function verifyCorpus({ name, file, corpus, load, refusal }) {
  for (const [label, text, expected] of corpus) {
    const root = await userData();
    await write(path.join(root, "farol-state", ...file), text);
    const store = await storeOutcome(() => load(root));
    const report = await activationObligations(root);
    const promotion = promotionOutcome(report, name);
    if (expected === "accept") {
      expect(store, `${name}: ${label} (store)`).toBe("accept");
      expect(promotion, `${name}: ${label} (promotion)`).toBe("accept");
    } else {
      expect(store, `${name}: ${label} (store)`).toBe(refusal);
      expect(promotion, `${name}: ${label} (promotion)`).toBe(expected);
      expect(report.drained, `${name}: ${label} never reads as drained`).toBe(
        false,
      );
    }
  }
}

describe("promotion reads each state file exactly as its owner does", () => {
  it("live-tasks.json: the store and the promotion reader accept and refuse the same records, including a padded file past the store's bound", async () => {
    await verifyCorpus({
      name: "live-tasks",
      file: ["live-tasks", "live-tasks.json"],
      refusal: "LIVE_TASK_STATE_CORRUPT",
      load: (root) =>
        new PrivateLiveTaskStore({
          root: path.join(root, "farol-state", "live-tasks"),
        }).load(),
      corpus: [
        ["valid", JSON.stringify(validTasks), "accept"],
        [
          "pretty-printed as the store writes",
          JSON.stringify(validTasks, null, 2) + "\n",
          "accept",
        ],
        [
          "missing revision",
          JSON.stringify(without(validTasks, "revision")),
          "MALFORMED",
        ],
        [
          "missing updatedAt",
          JSON.stringify(without(validTasks, "updatedAt")),
          "MALFORMED",
        ],
        [
          "event_driven task",
          JSON.stringify({
            ...validTasks,
            tasks: [task({ lifecycle: "event_driven" })],
          }),
          "MALFORMED",
        ],
        [
          "extra key",
          JSON.stringify({ ...validTasks, extra: true }),
          "MALFORMED",
        ],
        [
          "non-canonical timestamp",
          JSON.stringify({ ...validTasks, updatedAt: "2026-09-18T16:00:00Z" }),
          "MALFORMED",
        ],
        [
          "future schema",
          JSON.stringify({ ...validTasks, schema: 2 }),
          "UNKNOWN_VERSION",
        ],
        [
          "padded to exactly the bound",
          padded(validTasks, MAX_LIVE_TASK_BYTES),
          "accept",
        ],
        [
          "padded one byte past the bound",
          padded(validTasks, MAX_LIVE_TASK_BYTES + 1),
          "OVERSIZED",
        ],
        ["padded to 130 KiB", padded(validTasks, 130 * 1_024), "OVERSIZED"],
      ],
    });
  });

  it("chatgpt-task-journal.json: the journal and the promotion reader accept and refuse the same records", async () => {
    await verifyCorpus({
      name: "chatgpt-task-journal",
      file: ["chatgpt-task-journal", "chatgpt-task-journal.json"],
      refusal: "CHATGPT_TASK_JOURNAL_CORRUPT",
      load: (root) =>
        new PrivateChatGptTaskJournal({
          root: path.join(root, "farol-state", "chatgpt-task-journal"),
        }).load(),
      corpus: [
        ["valid", JSON.stringify(validJournal), "accept"],
        [
          "valid without a result",
          JSON.stringify({ ...validJournal, phase: "prepared", result: null }),
          "accept",
        ],
        [
          "missing phase",
          JSON.stringify(without(validJournal, "phase")),
          "MALFORMED",
        ],
        [
          "missing result key",
          JSON.stringify(without(validJournal, "result")),
          "MALFORMED",
        ],
        [
          "extra key",
          JSON.stringify({ ...validJournal, extra: true }),
          "MALFORMED",
        ],
        [
          "extra key inside the result",
          JSON.stringify({
            ...validJournal,
            result: { ...validJournal.result, extra: 1 },
          }),
          "MALFORMED",
        ],
        [
          "non-canonical timestamp",
          JSON.stringify({
            ...validJournal,
            createdAt: "2026-09-18T16:00:00Z",
          }),
          "MALFORMED",
        ],
        [
          "operation id that is not a v4 uuid",
          JSON.stringify({ ...validJournal, operationId: "op-1" }),
          "MALFORMED",
        ],
        [
          "future schema",
          JSON.stringify({ ...validJournal, schema: 2 }),
          "UNKNOWN_VERSION",
        ],
        [
          "padded to exactly the bound",
          padded(validJournal, MAX_CHATGPT_TASK_JOURNAL_BYTES),
          "accept",
        ],
        [
          "padded one byte past the bound",
          padded(validJournal, MAX_CHATGPT_TASK_JOURNAL_BYTES + 1),
          "OVERSIZED",
        ],
      ],
    });
  });

  it("config.json: the settings store and the promotion reader accept and refuse the same records, holding the restated bound to the store's", async () => {
    await verifyCorpus({
      name: "product-settings",
      file: ["config.json"],
      refusal: "SETTINGS_CORRUPT",
      load: (root) =>
        new ProductSettingsStore({
          root: path.join(root, "farol-state"),
        }).load(),
      corpus: [
        ["valid", JSON.stringify(validSettings), "accept"],
        [
          "missing general",
          JSON.stringify(without(validSettings, "general")),
          "MALFORMED",
        ],
        [
          "extra key",
          JSON.stringify({ ...validSettings, extra: true }),
          "MALFORMED",
        ],
        [
          "pending edit without its identity",
          JSON.stringify({
            ...validSettings,
            computer: {
              ...validSettings.computer,
              pendingEdit: { relativePath: "README.md" },
            },
          }),
          "MALFORMED",
        ],
        [
          "future schema",
          JSON.stringify({ ...validSettings, schema: 2 }),
          "UNKNOWN_VERSION",
        ],
        [
          "padded to exactly the bound",
          padded(validSettings, PRODUCT_SETTINGS_MAX_BYTES),
          "accept",
        ],
        [
          "padded one byte past the bound",
          padded(validSettings, PRODUCT_SETTINGS_MAX_BYTES + 1),
          "OVERSIZED",
        ],
      ],
    });
  });
});
