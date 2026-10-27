import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  assertFreshReady,
  assertPreservedEntries,
  freshChatNamespaces,
  selectFreshChatJournal,
} from "../e2e/fixtures/fresh-startup-witness.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture(generation = "current-backend") {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-fresh-witness-")),
  );
  roots.push(root);
  const name = `fresh-${createHash("sha256").update(generation).digest("hex")}`;
  const dir = path.join(root, "go-core/chat", name, "chat");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "chat-lifecycle.json");
  await fs.writeFile(
    file,
    JSON.stringify({ scope: { BackendGeneration: generation } }),
  );
  return { root, name, file };
}
it("selects the one actual new namespace and binds its stored generation", async () => {
  const f = await fixture();
  const selected = await selectFreshChatJournal(f.root, []);
  expect(selected.file).toBe(f.file);
  expect(selected.generation).toBe("current-backend");
  await expect(selectFreshChatJournal(f.root, [f.name])).rejects.toThrow(
    "CURRENT_FRESH_CHAT_NAMESPACE_AMBIGUOUS",
  );
});
it("rejects ambiguous or crossed generations rather than choosing by mtime", async () => {
  const f = await fixture();
  await fs.writeFile(
    f.file,
    JSON.stringify({ scope: { BackendGeneration: "other" } }),
  );
  await expect(selectFreshChatJournal(f.root, [])).rejects.toThrow(
    "CURRENT_FRESH_GENERATION_CROSSED",
  );
  await fs.mkdir(path.join(f.root, "go-core/chat", `fresh-${"b".repeat(64)}`));
  await expect(selectFreshChatJournal(f.root, [])).rejects.toThrow(
    "CURRENT_FRESH_CHAT_NAMESPACE_AMBIGUOUS",
  );
});
it("does not mistake the legacy root journal for a current fresh namespace", async () => {
  const f = await fixture();
  await fs.writeFile(
    path.join(f.root, "go-core/chat/chat-lifecycle.json"),
    JSON.stringify({ scope: { BackendGeneration: "old" } }),
  );
  expect(await freshChatNamespaces(f.root)).toEqual([f.name]);
});
it.each([
  "--startup-mode recovery --settings-mutations",
  "--startup-mode fresh",
  "--startup-mode fresh --settings-mutations --previous-host-drain-confirmed",
])("refuses wrong or incomplete launch selection %s", (command) => {
  expect(() =>
    assertFreshReady(
      {
        runtimeState: "ready",
        configuration: { status: "ready" },
        independentSession: false,
      },
      command,
    ),
  ).toThrow();
});
it("does not accept globally limited startup or ready labels alone", () => {
  const command = "serve --startup-mode fresh --settings-mutations";
  expect(() =>
    assertFreshReady(
      {
        runtimeState: "ready",
        configuration: { status: "ready" },
        independentSession: true,
      },
      command,
    ),
  ).toThrow("FRESH_START_GLOBALLY_LIMITED");
  expect(() =>
    assertFreshReady(
      {
        runtimeState: "ready",
        configuration: { status: "ready" },
        independentSession: false,
      },
      command,
    ),
  ).not.toThrow();
});
it("permits only an explicitly selected current journal to advance", () => {
  const before = {
    "chat/old/unknown": { outcome: "unknown" },
    "chat/current": { retired: false },
  };
  const after = {
    ...before,
    "chat/current": { retired: true },
    "chat/next": { retired: false },
  };
  expect(() =>
    assertPreservedEntries(before, after, "chat/current"),
  ).not.toThrow();
  expect(() =>
    assertPreservedEntries(
      before,
      { ...after, "chat/old/unknown": { outcome: "completed" } },
      "chat/current",
    ),
  ).toThrow("ORIGINAL_CHANGED:chat/old/unknown");
});
