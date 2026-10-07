import { describe, expect, it } from "vitest";
import fs, { constants } from "node:fs";
import vm from "node:vm";
import { parse } from "@babel/parser";
import {
  parseKnownCompletionOptions,
  qualifyKnownCompletionFailure,
  readKnownOriginalTerminalLog,
} from "../../tooling/complete-known-empty-chat.mjs";

describe("one selected known completion launcher", () => {
  const args = [
    "--apply",
    "--development",
    "--expected-source",
    "a".repeat(40),
    "--completion-operation",
    "72374b4b-d10a-4c1d-89fb-32f1a8292b6d",
  ];
  it("requires an exact current source and a distinct completion identity", () => {
    expect(parseKnownCompletionOptions(args)["--development"]).toBe(true);
  });
  it.each([
    [],
    args.slice(1),
    args.filter((v) => v !== "--development"),
    [...args, "--apply"],
    [...args, "--profile", "/private/tmp/other"],
    [...args, "--executable", "/bin/true"],
    [...args, "--retry"],
    [...args.slice(0, -1), "7e8cad64-a73f-4a49-a43f-8800faf8e4bb"],
    [...args.slice(0, -1), "invalid"],
    [...args.slice(0, 3), "dirty", ...args.slice(4)],
  ])("refuses omitted, duplicate or substituted authority: %j", (bad) => {
    expect(() => parseKnownCompletionOptions(bad)).toThrow();
  });
  it("does not infer known child/ACK facts from a matching error string alone", () => {
    expect(() =>
      qualifyKnownCompletionFailure(
        Buffer.from("{}"),
        Buffer.from("EMPTY_CHAT_RECOVERY_INTENT_CHANGED\n"),
        Buffer.from("{}"),
      ),
    ).toThrow();
  });
});

// Controlled filesystem descriptors only; no original evidence/profile read.
function logFixture() {
  const content = Buffer.from("EMPTY_CHAT_RECOVERY_INTENT_CHANGED\n");
  const common = {
    uid: BigInt(process.geteuid()),
    dev: 1n,
    ino: 2n,
    mode: 0o40700n,
    nlink: 2n,
    size: 32n,
    mtimeNs: 3n,
    ctimeNs: 4n,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
  const parent = { ...common };
  const log = {
    ...common,
    ino: 5n,
    mode: 0o100644n,
    nlink: 1n,
    size: BigInt(content.length),
    isDirectory: () => false,
    isFile: () => true,
  };
  const events = [];
  let afterParent = parent,
    afterLog = log;
  const directory = {
    stat: async () => ({ ...(events.includes("read") ? afterParent : parent) }),
    close: async () => events.push("close-directory"),
  };
  const file = {
    stat: async () => ({ ...(events.includes("read") ? afterLog : log) }),
    read: async (buffer) => {
      events.push("read");
      content.copy(buffer);
      return { bytesRead: content.length };
    },
    close: async () => events.push("close-log"),
  };
  const io = {
    open: async (name) => {
      events.push(name.endsWith(".log") ? "open-log" : "open-directory");
      return name.endsWith(".log") ? file : directory;
    },
    lstat: async (name) => ({
      ...(name.endsWith(".log")
        ? afterLog
        : events.includes("read")
          ? afterParent
          : parent),
    }),
    realpath: async (name) => name,
  };
  return {
    content,
    parent,
    log,
    io,
    events,
    changeParent: (value) => {
      afterParent = { ...parent, ...value };
    },
    changeLog: (value) => {
      afterLog = { ...log, ...value };
    },
  };
}

describe("fixed original terminal evidence mode", () => {
  it.each([0o100644n, 0o100600n])(
    "reads the exact retained log in the private original parent (%s)",
    async (mode) => {
      const f = logFixture();
      f.log.mode = mode;
      expect(await readKnownOriginalTerminalLog(f.io)).toEqual(f.content);
      expect(f.events).toEqual([
        "open-directory",
        "open-log",
        "read",
        "close-log",
        "close-directory",
      ]);
    },
  );
  it.each([0o40755n, 0o40770n, 0o41700n])(
    "refuses a nonprivate/special parent mode %s before the log",
    async (mode) => {
      const f = logFixture();
      f.parent.mode = mode;
      await expect(readKnownOriginalTerminalLog(f.io)).rejects.toThrow();
      expect(f.events).toEqual(["open-directory", "close-directory"]);
    },
  );
  it.each([
    [
      "other owner",
      (f) => {
        f.parent.uid += 1n;
      },
    ],
    [
      "parent symlink",
      (f) => {
        f.parent.isSymbolicLink = () => true;
      },
    ],
    [
      "noncanonical parent",
      (f) => {
        f.io.realpath = async () => "/substituted";
      },
    ],
    [
      "writable log",
      (f) => {
        f.log.mode = 0o100664n;
      },
    ],
    [
      "hardlinked log",
      (f) => {
        f.log.nlink = 2n;
      },
    ],
    [
      "oversized log",
      (f) => {
        f.log.size = 4097n;
      },
    ],
    [
      "late parent inode",
      (f) => {
        f.changeParent({ ino: 7n });
      },
    ],
    [
      "late parent mode",
      (f) => {
        f.changeParent({ mode: 0o40755n });
      },
    ],
    [
      "late log identity",
      (f) => {
        f.changeLog({ ino: 7n });
      },
    ],
    [
      "late log bytes",
      (f) => {
        f.changeLog({ mtimeNs: 7n });
      },
    ],
  ])("refuses %s and closes retained descriptors", async (_name, change) => {
    const f = logFixture();
    change(f);
    await expect(readKnownOriginalTerminalLog(f.io)).rejects.toThrow();
    expect(f.events.at(-1)).toBe("close-directory");
  });
});

// Exercise the actual private reader without exposing a new launcher API.
// The controlled descriptors supply no native/file/process acceptance.
const launcherSource = fs.readFileSync(
  "tooling/complete-known-empty-chat.mjs",
  "utf8",
);
const privateReader = parse(launcherSource, {
  sourceType: "module",
}).program.body.find(
  (node) => node.type === "FunctionDeclaration" && node.id.name === "bytes",
);
const evaluateReader = (io) =>
  vm.runInNewContext(
    `(${launcherSource.slice(privateReader.start, privateReader.end)})`,
    {
      fs: io,
      constants,
      process,
      Buffer,
      BigInt,
      originalTerminalLog:
        "/private/tmp/farol-ordinary-empty-recovery-7e8cad64-a73f-4a49-a43f-8800faf8e4bb/terminal-4dbeef45.log",
      fail: () => {
        throw new Error("EMPTY_CHAT_KNOWN_COMPLETION_REFUSED");
      },
    },
  );
it.each([0o100644n, 0o100664n])(
  "keeps other private evidence closed at mode %s",
  async (mode) => {
    const f = logFixture();
    f.log.mode = mode;
    await expect(
      evaluateReader(f.io)("/controlled/other.log", 4096),
    ).rejects.toThrow();
    expect(f.events).toEqual(["open-log", "close-log"]);
  },
);
it("still accepts ordinary 0600 evidence", async () => {
  const f = logFixture();
  f.log.mode = 0o100600n;
  expect(await evaluateReader(f.io)("/controlled/other.log", 4096)).toEqual(
    f.content,
  );
});
it("cannot apply the retained-terminal exception to another pathname", async () => {
  const f = logFixture();
  await expect(
    evaluateReader(f.io)("/controlled/other.log", 4096, false, f.io, true),
  ).rejects.toThrow();
  expect(f.events).toEqual([]);
});
