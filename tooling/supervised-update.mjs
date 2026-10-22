import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runSupervisedUpdate } from "./supervised-update-controller.mjs";

const USAGE =
  "supervised-update --input <absolute-json> --sha256 <exact-input-digest> --apply";
const MAX_INPUT_BYTES = 32 * 1024;

function deliverFinal(output, value) {
  try {
    const pending = output(value);
    if (pending && typeof pending.then === "function") {
      Promise.resolve(pending).catch(() => {});
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// This entry is bundled from reviewed source and run in an external Node
// process. It must remain independent of the the product instance being replaced.
export async function runSupervisedUpdateCLI(
  args,
  output = (value) => {
    process.stdout.write(JSON.stringify(value) + "\n");
  },
) {
  if (args.length === 1 && args[0] === "--help") {
    return deliverFinal(output, {
      usage: USAGE,
      effect:
        "one explicitly selected closed installed transition; no target launch",
    })
      ? 0
      : 3;
  }
  if (
    args.length !== 5 ||
    args[0] !== "--input" ||
    args[2] !== "--sha256" ||
    args[4] !== "--apply" ||
    typeof args[1] !== "string" ||
    args[1].includes("\0") ||
    args[1].length > 4096 ||
    !path.isAbsolute(args[1]) ||
    path.resolve(args[1]) !== args[1] ||
    !/^[a-f0-9]{64}$/u.test(args[3] ?? "")
  )
    throw new Error("UPDATE_SUPERVISOR_ARGUMENTS_INVALID");
  const file = args[1];
  if ((await fs.realpath(file)) !== file)
    throw new Error("UPDATE_SUPERVISOR_INPUT_UNSAFE");
  const fd = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let input;
  try {
    const before = await fd.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.geteuid()) ||
      (before.mode & 0o077n) !== 0n ||
      before.size < 1n ||
      before.size > BigInt(MAX_INPUT_BYTES)
    ) {
      throw new Error("UPDATE_SUPERVISOR_INPUT_UNSAFE");
    }
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const part = await fd.read(bytes, size, bytes.length - size, size);
      if (part.bytesRead === 0) break;
      size += part.bytesRead;
    }
    const same = (info) =>
      [
        "dev",
        "ino",
        "mode",
        "uid",
        "gid",
        "nlink",
        "size",
        "mtimeNs",
        "ctimeNs",
      ].every((key) => before[key] === info[key]);
    if (
      size !== Number(before.size) ||
      !same(await fd.stat({ bigint: true })) ||
      !same(await fs.lstat(file, { bigint: true })) ||
      createHash("sha256").update(bytes.subarray(0, size)).digest("hex") !==
        args[3]
    ) {
      throw new Error("UPDATE_SUPERVISOR_INPUT_CHANGED");
    }
    input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, size),
      ),
    );
  } finally {
    await fd.close();
  }
  const result = await runSupervisedUpdate(input, output);
  // Delivery is separate from the already observed lifecycle terminal. Never
  // re-enter the controller or rewrite completion when this final report is lost.
  const reported = deliverFinal(output, result);
  if (
    !reported ||
    result.status === "unknown" ||
    result.reportingFailure != null ||
    result.controllerClose === "unconfirmed" ||
    result.leaseRelease === "unconfirmed"
  )
    return 3;
  return result.status === "verified_closed" ? 0 : 2;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    process.exitCode = await runSupervisedUpdateCLI(process.argv.slice(2));
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,200}$/u.test(error?.message ?? "")
      ? error.message
      : "UPDATE_SUPERVISOR_INPUT_OR_RUNTIME_REFUSED";
    process.stderr.write(code + "\n");
    process.exitCode = 3;
  }
}
