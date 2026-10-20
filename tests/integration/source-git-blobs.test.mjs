import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseBlobBatch,
  parseBlobSizes,
  readGitBlobs,
} from "../../tooling/source-git-blobs.mjs";
import { sourceSnapshot } from "../../tooling/source-identity.mjs";

const first = "a".repeat(40);
const second = "b".repeat(40);
const frame = (id, body) =>
  Buffer.concat([
    Buffer.from(`${id} blob ${body.length}\n`),
    body,
    Buffer.from("\n"),
  ]);

describe("source Git batch framing", () => {
  it("reads binary, empty, duplicate and SHA-256 object requests exactly", () => {
    const longId = "c".repeat(64);
    const body = Buffer.from(`\0\n${second} blob 0\n\xff`, "latin1");
    const sizes = new Map([
      [first, body.length],
      [longId, 0],
    ]);
    const bytes = Buffer.concat([
      frame(first, body),
      frame(longId, Buffer.alloc(0)),
    ]);
    const parsed = parseBlobBatch(bytes, [first, longId], sizes);
    expect(parsed.get(first)).toEqual(body);
    expect(parsed.get(longId)).toEqual(Buffer.alloc(0));
    expect(
      parseBlobSizes(Buffer.from(`${first} blob 0\n`), [first]).get(first),
    ).toBe(0);
    let calls = 0;
    const blobs = readGitBlobs([first, first], (args, input) => {
      calls++;
      expect(input.toString()).toBe(`${first}\n`);
      return args[1] === "--batch-check"
        ? Buffer.from(`${first} blob ${body.length}\n`)
        : frame(first, body);
    });
    expect(calls).toBe(2);
    expect(blobs.size).toBe(1);
    expect(blobs.get(first)).toEqual(body);
  });

  it.each([
    `${first} missing\n`,
    `${first} tree 1\n`,
    `${second} blob 1\n`,
    `${first} blob -1\n`,
    `${first} blob 01\n`,
    `${first} blob 9007199254740992\n`,
    `${first} blob 1`,
    `${first} blob 1\nextra`,
  ])(
    "refuses invalid metadata without treating it as an empty blob: %s",
    (value) => {
      expect(() => parseBlobSizes(Buffer.from(value), [first])).toThrow(
        "SOURCE_GIT_BATCH_INVALID",
      );
    },
  );

  it("refuses truncated, wrong-size, reordered, trailing and non-UTF8 frames", () => {
    const valid = frame(first, Buffer.from("X"));
    const sizes = new Map([[first, 1]]);
    const highBitHeader = Buffer.from(valid);
    highBitHeader[0] |= 0x80;
    for (const malformed of [
      valid.subarray(0, valid.length - 1),
      Buffer.from(`${first} blob 2\nX\n`),
      frame(second, Buffer.from("X")),
      Buffer.concat([valid, Buffer.from("\n")]),
      Buffer.from(`${first} blob 1\nX!`),
      highBitHeader,
    ]) {
      expect(() => parseBlobBatch(malformed, [first], sizes)).toThrow(
        "SOURCE_GIT_BATCH_INVALID",
      );
    }
  });

  it("does not fall back or retry after a failed batch", () => {
    const calls = [];
    expect(() =>
      readGitBlobs([first], (args) => {
        calls.push(args[1]);
        if (args[1] === "--batch-check")
          return Buffer.from(`${first} blob 1\n`);
        throw new Error("batch unavailable");
      }),
    ).toThrow("batch unavailable");
    expect(calls).toEqual(["--batch-check", "--batch"]);
    expect(() =>
      readGitBlobs(["HEAD\n--all"], () => {
        throw new Error("must not spawn");
      }),
    ).toThrow("SOURCE_GIT_BATCH_INVALID");
  });

  it("bounds batch output and selects the original large-blob path before execution", () => {
    const large = Buffer.alloc(17 * 1024 * 1024, 255);
    const calls = [];
    const blobs = readGitBlobs([first, second], (args) => {
      calls.push(args);
      if (args[1] === "--batch-check")
        return Buffer.from(`${first} blob 1\n${second} blob ${large.length}\n`);
      if (args[1] === "--batch") return frame(first, Buffer.from("X"));
      expect(args).toEqual(["cat-file", "blob", second]);
      return large;
    });
    expect(calls).toHaveLength(3);
    expect(blobs.get(second).equals(large)).toBe(true);
  });

  it("splits individually small blobs before their combined output exceeds the batch cap", () => {
    const body = Buffer.alloc(9 * 1024 * 1024, 42);
    const requests = [];
    const blobs = readGitBlobs([first, second], (args, input) => {
      if (args[1] === "--batch-check")
        return Buffer.from(
          `${first} blob ${body.length}\n${second} blob ${body.length}\n`,
        );
      expect(args).toEqual(["cat-file", "--batch"]);
      const id = input.toString().trim();
      requests.push(id);
      return frame(id, body);
    });
    expect(requests).toEqual([first, second]);
    expect(blobs.get(first).equals(body)).toBe(true);
    expect(blobs.get(second).equals(body)).toBe(true);
  });
});

it("matches real Git binary blobs while preserving independent path buffers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "farol-source-batch-"));
  const git = (...args) =>
    execFileSync("/usr/bin/git", ["-C", root, ...args], {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: "/var/empty",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
  try {
    const body = Buffer.alloc(17 * 1024 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = i % 256;
    fs.writeFileSync(path.join(root, "first.bin"), body);
    fs.writeFileSync(path.join(root, "second.bin"), body);
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    const snapshot = sourceSnapshot(root);
    expect(snapshot.dirty).toBe(false);
    const a = snapshot.entries.get("first.bin").bytes;
    const b = snapshot.entries.get("second.bin").bytes;
    expect(a.equals(body)).toBe(true);
    expect(b.equals(body)).toBe(true);
    a[0] ^= 255;
    expect(b.equals(body)).toBe(true);
    body[body.length - 1] ^= 255;
    fs.writeFileSync(path.join(root, "first.bin"), body);
    expect(sourceSnapshot(root).reasons).toContainEqual(
      expect.objectContaining({ kind: "content", path: "first.bin" }),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15000);
