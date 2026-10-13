import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: fake.spawn,
}));
import {
  publishInstalledOperationBinding,
  installedSlotBindingBytes,
} from "../../src/modules/release/infra/native/installed-update-helper";

// Exact checked-in helper bytes; all owner-directory metadata, process streams
// and process lifetime are pure fixtures. No real app/profile/process is used.
const helper = path.resolve("resources/native/update_helper.py");
const home = "/Users/binding-fixture";
const root = path.join(
  home,
  "Library/Application Support/Farol Next Preview/installed-updates",
);
const operation = {
  operationId: "a".repeat(32),
  source: { version: "0.2.4", digest: "1".repeat(64), buildId: "2".repeat(64) },
  target: { version: "0.2.5", digest: "3".repeat(64), buildId: "4".repeat(64) },
};
const directory = path.join(root, operation.operationId);
let child: EventEmitter & {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  stdio: (Writable | null)[];
  kill: ReturnType<typeof vi.fn>;
};
let request: Buffer[];
let code: Buffer[];
let close: ReturnType<typeof vi.fn>;
let entered: Promise<void>;
let enter: () => void;
let displaced: boolean;

beforeEach(() => {
  fake.spawn.mockReset();
  request = [];
  code = [];
  close = vi.fn(async () => undefined);
  displaced = false;
  entered = new Promise((resolve) => {
    enter = resolve;
  });
  const owner = os.userInfo();
  vi.spyOn(os, "userInfo").mockReturnValue({ ...owner, homedir: home });
  const metadata = (inode: bigint) => ({
    dev: 1n,
    ino: inode,
    mode: 0o40700n,
    uid: BigInt(owner.uid),
    isDirectory: () => true,
  });
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation((file, options) => {
    if (file === root)
      return Promise.resolve(metadata(1n)) as ReturnType<typeof fs.lstat>;
    if (file === directory)
      return Promise.resolve(metadata(displaced ? 99n : 2n)) as ReturnType<
        typeof fs.lstat
      >;
    return lstat(file, options);
  });
  const realpath = fs.realpath.bind(fs);
  vi.spyOn(fs, "realpath").mockImplementation((file, options) =>
    file === root || file === directory
      ? (Promise.resolve(String(file)) as ReturnType<typeof fs.realpath>)
      : realpath(file, options),
  );
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation((file, flags, mode) =>
    file === directory
      ? Promise.resolve({
          fd: 42,
          stat: async () => metadata(2n),
          close,
        } as unknown as Awaited<ReturnType<typeof fs.open>>)
      : open(file, flags, mode),
  );
  const sink = (chunks: Buffer[]) =>
    new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
  const stdin = sink(code);
  const input = sink(request);
  child = Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdio: [stdin, null, null, input, null],
    kill: vi.fn(() => true),
  });
  fake.spawn.mockImplementation(() => {
    enter();
    return child;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function started() {
  await entered;
  await new Promise((resolve) => setImmediate(resolve));
}
function finish(stderr = "") {
  if (stderr) child.stderr.write(stderr);
  child.stdout.write("SLOT_BINDING_OK\n");
  child.emit("close", 0, null);
}

it.each(["shared", "legacy"] as const)(
  "inherits only the pinned operation descriptor and canonical %s bytes",
  async (location) => {
    const operationPromise = publishInstalledOperationBinding(
      helper,
      operation,
      location,
    );
    await started();
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    const [executable, args, options] = fake.spawn.mock.calls[0]!;
    expect(executable).toBe("/usr/bin/python3");
    expect(args.slice(0, 4)).toEqual(["-I", "-S", "-B", "-c"]);
    expect(args[4]).toContain(
      'namespace["publish_slot_binding"](4,bytes(data))',
    );
    expect(args[4]).not.toContain(home);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe", "pipe", 42]);
    expect(Buffer.concat(request)).toEqual(
      installedSlotBindingBytes(operation, location),
    );
    expect(Buffer.concat(code)).toEqual(await fs.readFile(helper));
    finish();
    await operationPromise;
    expect(close).toHaveBeenCalledOnce();
  },
);
it("rejects warnings without changing the exact output contract", async () => {
  const result = publishInstalledOperationBinding(helper, operation, "shared");
  await started();
  finish("fixture native warning\n");
  await expect(result).rejects.toThrow("UPDATE_SLOT_BINDING_UNCONFIRMED");
  expect(fake.spawn).toHaveBeenCalledOnce();
});
it("rejects displacement of the named directory after pinned publication", async () => {
  const result = publishInstalledOperationBinding(helper, operation, "shared");
  await started();
  displaced = true;
  finish();
  await expect(result).rejects.toThrow("UPDATE_SLOT_BINDING_CHANGED");
  expect(close).toHaveBeenCalledOnce();
});
it("waits for the same child's close after a timeout and never retries", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let settled = false;
  const result = publishInstalledOperationBinding(
    helper,
    operation,
    "shared",
  ).catch((error) => {
    settled = true;
    return error;
  });
  await started();
  await vi.advanceTimersByTimeAsync(5000);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(settled).toBe(false);
  expect(close).not.toHaveBeenCalled();
  child.emit("close", null, "SIGKILL");
  expect(await result).toMatchObject({
    message: "UPDATE_SLOT_BINDING_UNCONFIRMED",
  });
  expect(fake.spawn).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
