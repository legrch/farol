// Hermetic physical-file fixtures; no app, helper, provider or native acceptance.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  readQuitObservation,
  beginQuitObservation,
  assertFreshQuit,
} from "../e2e/lib/native-quit-observation.mjs";

const roots = [];
const clean = { pid: 77, code: 0, signal: null };
const receipt = (at, extra = {}) =>
  JSON.stringify({ schema: 1, at, drained: true, unconfirmed: [], ...extra }) +
  "\n";
async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "farol-quit-proof-unit-")),
  );
  await fs.chmod(root, 0o700);
  roots.push(root);
  return { root, file: path.join(root, "last-quit.json") };
}
async function replace(file, bytes) {
  const temporary = file + ".replacement";
  await fs.writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, file);
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
it("requires a new physical receipt for the first quit", async () => {
  const { root, file } = await fixture();
  const before = await readQuitObservation(root);
  const request = beginQuitObservation(before, 77);
  await replace(file, receipt(new Date().toISOString()));
  const after = await readQuitObservation(root);
  expect(assertFreshQuit(request, after, clean).drained).toBe(true);
  expect(JSON.stringify(after)).not.toContain('"unconfirmed"');
});
it("rejects an unchanged future-dated old receipt despite clean exit and a newer timestamp", async () => {
  const { root, file } = await fixture();
  await replace(file, receipt(new Date(Date.now() + 60000).toISOString()));
  const before = await readQuitObservation(root);
  const request = beginQuitObservation(before, 77);
  const after = await readQuitObservation(root);
  expect(() => assertFreshQuit(request, after, clean)).toThrow(
    "QUIT_NOT_REPLACED",
  );
});
it("requires atomic replacement, not an in-place rewrite with a recent date", async () => {
  const { root, file } = await fixture();
  await replace(file, receipt(new Date(0).toISOString()));
  const before = await readQuitObservation(root);
  const request = beginQuitObservation(before, 77);
  await fs.writeFile(file, receipt(new Date().toISOString()));
  const after = await readQuitObservation(root);
  expect(() => assertFreshQuit(request, after, clean)).toThrow(
    "QUIT_NOT_REPLACED",
  );
});
it.each(["undrained", "children", "nonzero", "signal", "foreign-pid"])(
  "does not upgrade a newly replaced but %s receipt",
  async (kind) => {
    const { root, file } = await fixture();
    const before = await readQuitObservation(root);
    const request = beginQuitObservation(before, 77);
    await replace(
      file,
      receipt(
        new Date().toISOString(),
        kind === "undrained"
          ? { drained: false }
          : kind === "children"
            ? { unconfirmed: ["runtime"] }
            : {},
      ),
    );
    const after = await readQuitObservation(root);
    const exit =
      kind === "nonzero"
        ? { pid: 77, code: 1, signal: null }
        : kind === "signal"
          ? { pid: 77, code: null, signal: "SIGTERM" }
          : kind === "foreign-pid"
            ? { pid: 78, code: 0, signal: null }
            : clean;
    expect(() => assertFreshQuit(request, after, exit)).toThrow();
  },
);
it("accepts a new atomic receipt after a prior lifetime without trusting the prior date", async () => {
  const { root, file } = await fixture();
  await replace(file, receipt(new Date(Date.now() + 60000).toISOString()));
  const before = await readQuitObservation(root);
  const request = beginQuitObservation(before, 77);
  await replace(file, receipt(new Date().toISOString()));
  const after = await readQuitObservation(root);
  expect(after.identity.ino).not.toBe(before.identity.ino);
  expect(assertFreshQuit(request, after, clean).unconfirmed).toEqual([]);
});
it("does not accept caller-forged or serialized observations and does not replay a failed mark", async () => {
  const { root, file } = await fixture();
  const before = await readQuitObservation(root);
  expect(() =>
    beginQuitObservation(JSON.parse(JSON.stringify(before)), 77),
  ).toThrow("QUIT_REQUEST_REQUIRED");
  const request = beginQuitObservation(before, 77);
  await replace(file, receipt(new Date().toISOString()));
  const after = await readQuitObservation(root);
  expect(() =>
    assertFreshQuit(request, JSON.parse(JSON.stringify(after)), clean),
  ).toThrow("QUIT_OBSERVATION_REQUIRED");
  expect(() => assertFreshQuit(request, after, clean)).toThrow(
    "QUIT_REQUEST_REQUIRED",
  );
});
it.each([new Date(0).toISOString(), "2099-01-01T00:00:00.000Z"])(
  "uses physical replacement rather than wall date %s",
  async (at) => {
    const { root, file } = await fixture();
    const before = await readQuitObservation(root);
    const request = beginQuitObservation(before, 77);
    await replace(file, receipt(at));
    const after = await readQuitObservation(root);
    expect(assertFreshQuit(request, after, clean).at).toBe(at);
  },
);
it("cannot reuse an earlier completed read after issuing the current request", async () => {
  const { root, file } = await fixture();
  const before = await readQuitObservation(root);
  await replace(file, receipt(new Date().toISOString()));
  const oldAfter = await readQuitObservation(root);
  const request = beginQuitObservation(before, 77);
  expect(() => assertFreshQuit(request, oldAfter, clean)).toThrow(
    "QUIT_OBSERVATION_REQUIRED",
  );
});
it.each(["alias", "mode", "hardlink", "oversize"])(
  "refuses an unsafe %s receipt without reading through it",
  async (kind) => {
    const { root, file } = await fixture();
    const target = path.join(root, "target");
    await fs.writeFile(target, "{}", { mode: 0o600 });
    if (kind === "alias") await fs.symlink(target, file);
    else if (kind === "hardlink") await fs.link(target, file);
    else {
      await fs.writeFile(file, kind === "oversize" ? "x".repeat(9000) : "{}", {
        mode: kind === "mode" ? 0o644 : 0o600,
      });
    }
    await expect(readQuitObservation(root)).rejects.toThrow();
  },
);
