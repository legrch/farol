import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BUILD_ENTRIES } from "./build-contract.mjs";
import {
  GO_CORE_ENTRIES,
  assertGoCoreDeclaration,
} from "./go-core-artifact.mjs";

// The running main.cjs is the trusted loader. Its own resulting digest cannot
// be embedded into itself. The final build manifest still covers that image;
// this independent projection covers every other built dependency it loads.
export const CORE_RESOURCE_ENTRIES = Object.freeze(
  [...BUILD_ENTRIES, ...GO_CORE_ENTRIES]
    .filter((name) => name !== "main.cjs")
    .sort(),
);

export async function declareCoreResources(directory, core, identity) {
  assertGoCoreDeclaration(core, identity);
  const files = [];
  for (const name of CORE_RESOURCE_ENTRIES) {
    const handle = await fs.open(
      path.join(directory, name),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size < 1n ||
        before.size > 128n * 1024n * 1024n
      )
        throw new Error("CORE_RESOURCE_INPUT_INVALID");
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (
        offset !== Number(before.size) ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.mode !== after.mode ||
        before.nlink !== after.nlink ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new Error("CORE_RESOURCE_INPUT_CHANGED");
      files.push(
        Object.freeze({
          path: name,
          size: offset,
          sha256: createHash("sha256")
            .update(bytes.subarray(0, offset))
            .digest("hex"),
        }),
      );
    } finally {
      await handle.close();
    }
  }
  const backend = files.find((file) => file.path === core.binary.path);
  if (
    backend?.size !== core.binary.size ||
    backend?.sha256 !== core.binary.sha256
  )
    throw new Error("CORE_RESOURCE_BACKEND_CHANGED");
  return Object.freeze({
    schema: "farol-core-resources/1",
    core,
    files: Object.freeze(files),
  });
}
