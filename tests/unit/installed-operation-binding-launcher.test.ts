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

// All owner-directory metadata, process streams and process lifetime are pure
// fixtures. No real app/profile/process or bundled backend is used.
const backend = "/private/accepted/farol-backend";
const goHelper = () => ({
  buildId: "5".repeat(64),
  qualify: vi.fn(async () => backend),
});
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
      goHelper(),
      operation,
      location,
    );
    await started();
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    const [executable, args, options] = fake.spawn.mock.calls[0]!;
    expect(executable).toBe(backend);
    expect(args.join(" ")).not.toContain(home);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe", "pipe", 42]);
    expect(Buffer.concat(request)).toEqual(
      installedSlotBindingBytes(operation, location),
    );
    expect(Buffer.concat(code)).toHaveLength(0);
    finish();
    await operationPromise;
    expect(close).toHaveBeenCalledOnce();
  },
);
it("rejects warnings without changing the exact output contract", async () => {
  const result = publishInstalledOperationBinding(
    goHelper(),
    operation,
    "shared",
  );
  await started();
  finish("fixture native warning\n");
  await expect(result).rejects.toThrow("UPDATE_SLOT_BINDING_UNCONFIRMED");
  expect(fake.spawn).toHaveBeenCalledOnce();
});
it("rejects displacement of the named directory after pinned publication", async () => {
  const result = publishInstalledOperationBinding(
    goHelper(),
    operation,
    "shared",
  );
  await started();
  displaced = true;
  finish();
  await expect(result).rejects.toThrow("UPDATE_SLOT_BINDING_CHANGED");
  expect(close).toHaveBeenCalledOnce();
});
it("runs the qualified bundled Go capability with original fd ownership and no Python input", async () => {
  const qualify = vi.fn(async () => "/private/accepted/farol-backend");
  const buildId = "5".repeat(64);
  const result = publishInstalledOperationBinding(
    { buildId, qualify },
    operation,
    "shared",
  );
  await started();
  const [executable, args, options] = fake.spawn.mock.calls[0]!;
  expect(executable).toBe("/private/accepted/farol-backend");
  expect(args).toEqual([
    "publish-installed-slot-binding",
    "--build-id",
    buildId,
  ]);
  expect(options.stdio).toEqual(["pipe", "pipe", "pipe", "pipe", 42]);
  expect(Buffer.concat(code)).toHaveLength(0);
  expect(Buffer.concat(request)).toEqual(
    installedSlotBindingBytes(operation, "shared"),
  );
  expect(close).not.toHaveBeenCalled();
  finish();
  await result;
  expect(qualify).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledOnce();
  expect(fake.spawn).toHaveBeenCalledOnce();
});

it("does not fall back or spawn when selected Go attestation refuses", async () => {
  const qualify = vi.fn(async () => {
    throw Error("CORE_RESOURCE_CHANGED");
  });
  await expect(
    publishInstalledOperationBinding(
      { buildId: "5".repeat(64), qualify },
      operation,
      "shared",
    ),
  ).rejects.toThrow("CORE_RESOURCE_CHANGED");
  expect(fake.spawn).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it.each(["changed-image", "lost-ack", "refused-exit"])(
  "keeps %s Go publication unconfirmed without retry",
  async (mode) => {
    const qualify = vi.fn(async () => "/private/accepted/farol-backend");
    const result = publishInstalledOperationBinding(
      { buildId: "5".repeat(64), qualify },
      operation,
      "shared",
    );
    await started();
    if (mode === "changed-image")
      qualify.mockRejectedValueOnce(Error("CORE_RESOURCE_CHANGED"));
    if (mode !== "lost-ack") child.stdout.write("SLOT_BINDING_OK\n");
    child.emit("close", mode === "refused-exit" ? 70 : 0, null);
    await expect(result).rejects.toThrow(
      mode === "changed-image"
        ? "CORE_RESOURCE_CHANGED"
        : "UPDATE_SLOT_BINDING_UNCONFIRMED",
    );
    expect(fake.spawn).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  },
);

it("waits for the original selected Go child after timeout and retains an unknown outcome", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let settled = false;
  const result = publishInstalledOperationBinding(
    {
      buildId: "5".repeat(64),
      qualify: async () => "/private/accepted/farol-backend",
    },
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
