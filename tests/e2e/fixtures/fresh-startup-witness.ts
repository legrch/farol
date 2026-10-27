import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const freshName = /^fresh-[a-f0-9]{64}$/u;
export async function freshChatNamespaces(stateRoot: string) {
  try {
    return (await fs.readdir(path.join(stateRoot, "go-core/chat")))
      .filter((name) => freshName.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
// Select only the new namespace created by this one launch, never latest mtime
// or the old root journal. The actual generation must match its native name.
export async function selectFreshChatJournal(
  stateRoot: string,
  before: readonly string[],
) {
  const created = (await freshChatNamespaces(stateRoot)).filter(
    (name) => !before.includes(name),
  );
  assert.equal(created.length, 1, "CURRENT_FRESH_CHAT_NAMESPACE_AMBIGUOUS");
  const name = created[0];
  assert.ok(name, "CURRENT_FRESH_CHAT_NAMESPACE_MISSING");
  const file = path.join(
    stateRoot,
    "go-core/chat",
    name,
    "chat/chat-lifecycle.json",
  );
  assert.equal(
    await fs.realpath(file),
    file,
    "CURRENT_FRESH_JOURNAL_REDIRECTED",
  );
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  const generation = value.scope?.BackendGeneration;
  assert.equal(typeof generation, "string", "CURRENT_FRESH_GENERATION_MISSING");
  assert.ok(generation.length > 0 && generation.length <= 120);
  assert.equal(
    name,
    `fresh-${createHash("sha256").update(generation).digest("hex")}`,
    "CURRENT_FRESH_GENERATION_CROSSED",
  );
  return {
    file,
    label: `chat/${name}/chat/chat-lifecycle.json`,
    value,
    generation,
  };
}
export function assertFreshReady(
  bootstrap: {
    runtimeState: string;
    configuration: { status: string };
    independentSession?: boolean;
  },
  command: string,
) {
  assert.equal(bootstrap.runtimeState, "ready", "CURRENT_RUNTIME_NOT_READY");
  assert.equal(
    bootstrap.configuration.status,
    "ready",
    "CURRENT_CONFIGURATION_NOT_READY",
  );
  assert.equal(
    bootstrap.independentSession,
    false,
    "FRESH_START_GLOBALLY_LIMITED",
  );
  assert.match(command, /--startup-mode fresh(?:\s|$)/u);
  assert.match(command, /--settings-mutations(?:\s|$)/u);
  assert.doesNotMatch(
    command,
    /--startup-mode recovery|--previous-host-drain-confirmed/u,
  );
}
export function assertPreservedEntries(
  original: Record<string, unknown>,
  current: Record<string, unknown>,
  advancingJournal?: string,
) {
  for (const [name, value] of Object.entries(original)) {
    if (name === advancingJournal) continue;
    assert.deepEqual(current[name], value, `ORIGINAL_CHANGED:${name}`);
  }
}
