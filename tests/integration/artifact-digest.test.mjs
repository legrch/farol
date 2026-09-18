import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TREE_DIGEST_VERSION,
  treeDigest,
} from "../../tooling/artifact-digest.mjs";

const nextRoot = path.resolve(import.meta.dirname, "../..");

// The promotion helper verifies the promoted copy with its own Python
// implementation of the same tree digest; both must agree byte for byte.
function pythonTreeDigest(directory) {
  const program = `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("farol_promotion_apply", sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
descriptor = os.open(sys.argv[2], os.O_RDONLY | os.O_DIRECTORY)
try:
    print(helper.digest_tree(descriptor))
except helper.Refusal as error:
    raise SystemExit(error.status)
finally:
    os.close(descriptor)
`;
  const result = spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      program,
      path.join(nextRoot, "tooling/promotion-apply.py"),
      directory,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`python digest failed: ${result.status} ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function tree(prefix, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  for (const [relative, bytes, mode = 0o644] of files) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    await fs.chmod(target, mode);
  }
  return root;
}

function verifyPackageManifest(artifact) {
  return fs
    .mkdtemp(path.join(os.tmpdir(), "farol-next-digest-manifest-"))
    .then(async (directory) => {
      try {
        const file = path.join(directory, "artifact.json");
        await fs.writeFile(file, JSON.stringify(artifact));
        return spawnSync(
          process.execPath,
          ["tooling/verify-package.mjs", "--artifact", file],
          { cwd: nextRoot, encoding: "utf8" },
        );
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
}

describe("packaged tree identity", () => {
  it("requires the artifact root itself to be an ordinary directory", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-digest-root-"),
    );
    try {
      const realRoot = path.join(parent, "real");
      const linkRoot = path.join(parent, "linked");
      await fs.mkdir(realRoot);
      await fs.writeFile(path.join(realRoot, "entry"), "payload");
      await fs.symlink("real", linkRoot);

      await expect(treeDigest(linkRoot)).rejects.toThrow(
        "ARTIFACT_ROOT_TYPE_INVALID",
      );
      await expect(treeDigest(path.join(realRoot, "entry"))).rejects.toThrow(
        "ARTIFACT_ROOT_TYPE_INVALID",
      );
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("binds entry type as well as path, mode, and payload", async () => {
    const fileRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-digest-file-"),
    );
    const linkRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-digest-link-"),
    );
    try {
      const file = path.join(fileRoot, "entry");
      await fs.writeFile(file, "target");
      await fs.chmod(file, 0o755);
      await fs.writeFile(path.join(linkRoot, "target"), "target");
      await fs.symlink("target", path.join(linkRoot, "entry"));

      expect(await treeDigest(fileRoot)).not.toBe(await treeDigest(linkRoot));
    } finally {
      await fs.rm(fileRoot, { recursive: true, force: true });
      await fs.rm(linkRoot, { recursive: true, force: true });
    }
  });

  it("rejects absolute and escaping symlinks in a packaged tree", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "farol-next-digest-escape-"),
    );
    try {
      await fs.mkdir(path.join(root, "nested"));
      await fs.symlink("../../../outside", path.join(root, "nested/escape"));
      await expect(treeDigest(root)).rejects.toThrow(
        "ARTIFACT_SYMLINK_ESCAPES_ROOT",
      );
      await fs.rm(path.join(root, "nested/escape"));
      await fs.symlink("/tmp/outside", path.join(root, "nested/absolute"));
      await expect(treeDigest(root)).rejects.toThrow(
        "ARTIFACT_SYMLINK_ESCAPES_ROOT",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  describe("EV-01 unambiguous versioned encoding", () => {
    // Research 04 witness: under the v1 framing a single file whose bytes
    // spell a second entry serialized exactly like the two-entry tree.
    const injected = Buffer.from(
      "\u0000b.bin\u0000file\u0000420\u0000payload",
      "utf8",
    );

    it("separates a file that embeds entry framing from a real second entry", async () => {
      const one = await tree("farol-next-digest-one-", [["a.bin", injected]]);
      const two = await tree("farol-next-digest-two-", [
        ["a.bin", Buffer.alloc(0)],
        ["b.bin", Buffer.from("payload", "utf8")],
      ]);
      try {
        expect(await treeDigest(one)).not.toBe(await treeDigest(two));
      } finally {
        await fs.rm(one, { recursive: true, force: true });
        await fs.rm(two, { recursive: true, force: true });
      }
    });

    it("declares its version and stays deterministic for identical trees", async () => {
      expect(TREE_DIGEST_VERSION).toBe("farol.next.tree-digest/v2");
      const files = [
        ["Contents/Info.plist", Buffer.from("<plist/>\n", "utf8")],
        ["Contents/MacOS/run", Buffer.from("#!/bin/sh\n", "utf8"), 0o755],
      ];
      const first = await tree("farol-next-digest-same-a-", files);
      const second = await tree("farol-next-digest-same-b-", files);
      try {
        expect(await treeDigest(first)).toBe(await treeDigest(second));
      } finally {
        await fs.rm(first, { recursive: true, force: true });
        await fs.rm(second, { recursive: true, force: true });
      }
    });

    it("still binds path, mode, payload and nesting", async () => {
      const base = [["dir/file", Buffer.from("x", "utf8")]];
      const variants = [
        [["dir/file", Buffer.from("x", "utf8"), 0o600]],
        [["dir/other", Buffer.from("x", "utf8")]],
        [["dir/file", Buffer.from("y", "utf8")]],
        [["dirfile", Buffer.from("x", "utf8")]],
        [["dir/sub/file", Buffer.from("x", "utf8")]],
      ];
      const root = await tree("farol-next-digest-base-", base);
      const others = [];
      try {
        const expected = await treeDigest(root);
        for (const [index, files] of variants.entries()) {
          const other = await tree(
            `farol-next-digest-variant-${index}-`,
            files,
          );
          others.push(other);
          expect(await treeDigest(other)).not.toBe(expected);
        }
      } finally {
        for (const directory of [root, ...others]) {
          await fs.rm(directory, { recursive: true, force: true });
        }
      }
    });

    it("agrees with the promotion helper's Python implementation", async () => {
      const one = await tree("farol-next-digest-py-one-", [
        ["a.bin", injected],
      ]);
      const two = await tree("farol-next-digest-py-two-", [
        ["a.bin", Buffer.alloc(0)],
        ["b.bin", Buffer.from("payload", "utf8")],
      ]);
      const nested = await tree("farol-next-digest-py-nested-", [
        ["Contents/Resources/app/main.cjs", Buffer.from("main\n", "utf8")],
        ["Contents/MacOS/run", Buffer.from("#!/bin/sh\n", "utf8"), 0o755],
      ]);
      await fs.symlink(
        "app/main.cjs",
        path.join(nested, "Contents/Resources/link"),
      );
      try {
        for (const directory of [one, two, nested]) {
          expect(pythonTreeDigest(directory)).toBe(await treeDigest(directory));
        }
        expect(pythonTreeDigest(one)).not.toBe(pythonTreeDigest(two));
      } finally {
        for (const directory of [one, two, nested]) {
          await fs.rm(directory, { recursive: true, force: true });
        }
      }
    });

    it("recognizes a legacy v1 package manifest explicitly", async () => {
      const legacy = await verifyPackageManifest({ schema: 4 });
      expect(legacy.status).not.toBe(0);
      expect(legacy.stderr).toContain("PACKAGE_TREE_DIGEST_LEGACY");

      const unknown = await verifyPackageManifest({
        schema: 5,
        treeDigestVersion: "farol.next.tree-digest/v9",
      });
      expect(unknown.status).not.toBe(0);
      expect(unknown.stderr).toContain("PACKAGE_TREE_DIGEST_VERSION_INVALID");
    });
  });
});
