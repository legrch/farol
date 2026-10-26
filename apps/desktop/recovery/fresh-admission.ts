import fs from "node:fs/promises";
import path from "node:path";
import { parseJSON } from "../bridge/frame";
import { randomUUID } from "node:crypto";
import { closedRecoveryHostMechanics as files } from "../../../src/apps/desktop/closed-empty-chat-recovery";
import {
  classifyRunMarker,
  currentBootTimeMs,
  processAlive,
  readProcessStart,
  RunMarkerSchema,
} from "../../../src/apps/desktop/run-marker";

// Preservation precedes a new host marker, under the original startup lease.
// It grants no native admission: the new child must acquire current owners itself.
// No old operation is decoded, resumed, acknowledged or declared successful.
export async function preserveFreshStartHistory(
  stateRoot: string,
  assertCurrent: () => Promise<void>,
): Promise<void> {
  await assertCurrent();
  await files.privateRoot(stateRoot);
  const target = path.join(stateRoot, "running.json");
  let prior: Awaited<ReturnType<typeof files.snapshot>>;
  try {
    prior = await files.snapshot(target, 4096);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const marker = RunMarkerSchema.parse(
    parseJSON(new TextDecoder("utf-8", { fatal: true }).decode(prior.bytes)),
  );
  if (
    classifyRunMarker(marker, {
      bootTime: currentBootTimeMs(),
      isAlive: processAlive,
      processStart: readProcessStart,
    }) !== "crashed"
  )
    throw Error("FRESH_START_CURRENT_OWNER_UNCONFIRMED");
  const quitFile = path.join(stateRoot, "last-quit.json");
  let quit: typeof prior | undefined;
  try {
    quit = await files.snapshot(quitFile, 16384);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const history = path.join(stateRoot, "run-history");
  try {
    await fs.mkdir(history, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await files.privateRoot(history);
  const archive = path.join(history, randomUUID());
  await assertCurrent();
  await files.unchanged(target, prior);
  if (quit) await files.unchanged(quitFile, quit);
  await fs.mkdir(archive, { mode: 0o700 });
  for (const [name, snapshot] of [
    ["running.json", prior],
    ["last-quit.json", quit],
  ] as const) {
    if (!snapshot) continue;
    const fd = await fs.open(path.join(archive, name), "wx", 0o600);
    try {
      await fd.writeFile(snapshot.bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    const copy = await files.snapshot(path.join(archive, name), 16384);
    if (!copy.bytes.equals(snapshot.bytes))
      throw Error("FRESH_START_HISTORY_UNCONFIRMED");
  }
  for (const dir of [archive, history, stateRoot]) {
    const fd = await fs.open(dir, "r");
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  }
  await files.unchanged(target, prior);
  if (quit) await files.unchanged(quitFile, quit);
  await assertCurrent();
}
