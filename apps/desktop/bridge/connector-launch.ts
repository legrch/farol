import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseJSON } from "./frame.ts";
import { validate, type ComputerConnectorOpened } from "./wire.ts";

export const connectorLaunchBasename = "computer-go-launch.json";
const maximumBytes = 16384;
export type ConnectorLaunch = Readonly<{
  schema: "farol-go-connector/1";
  opened: ComputerConnectorOpened;
  lifecycleRoot: string;
  challengeSha256: string;
}>;
function invalid(): never {
  throw new Error("COMPUTER_MCP_GO_LAUNCH_UNAVAILABLE");
}
function canonical(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 1 &&
    value.length <= 4096 &&
    !value.includes("\0") &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

// This envelope selects transport resources only. It carries no policy snapshot,
// executable, approval or fallback. The selected Go owner rechecks every operation.
export function parseConnectorLaunch(bytes: Uint8Array): ConnectorLaunch {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) invalid();
  let value: unknown;
  try {
    value = parseJSON(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "challengeSha256,lifecycleRoot,opened,schema" ||
    record.schema !== "farol-go-connector/1" ||
    !canonical(record.lifecycleRoot) ||
    typeof record.challengeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.challengeSha256) ||
    !validate("ComputerConnectorOpened", record.opened)
  )
    invalid();
  const opened = record.opened as ComputerConnectorOpened;
  const socket = opened.endpoint.socketPath;
  if (
    !canonical(socket) ||
    path.basename(socket) !== "computer.sock" ||
    path.dirname(path.dirname(socket)) !== "/private/tmp" ||
    !/^farol-mcp-[A-Za-z0-9-]+$/u.test(path.basename(path.dirname(socket)))
  )
    invalid();
  return Object.freeze({
    schema: "farol-go-connector/1",
    lifecycleRoot: record.lifecycleRoot,
    challengeSha256: record.challengeSha256,
    opened: Object.freeze({
      ...opened,
      execution: Object.freeze({ ...opened.execution }),
      endpoint: Object.freeze({
        ...opened.endpoint,
        binding: Object.freeze({ ...opened.endpoint.binding }),
      }),
    }),
  });
}
function directory(root: string): fs.BigIntStats {
  if (typeof process.getuid !== "function") invalid();
  const stat = fs.lstatSync(root, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(process.getuid()) ||
    (stat.mode & 0o7777n) !== 0o700n ||
    fs.realpathSync(root) !== root
  )
    invalid();
  return stat;
}
function same(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function fileStat(stat: fs.BigIntStats): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.uid !== BigInt(process.getuid!()) ||
    (stat.mode & 0o7777n) !== 0o600n ||
    stat.size <= 0n ||
    stat.size > BigInt(maximumBytes)
  )
    invalid();
}
function unchangedFile(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return (
    same(a, b) &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

export function loadConnectorLaunch(
  file: string,
): Readonly<{ launch: ConnectorLaunch; sha256: string }> {
  if (!canonical(file) || path.basename(file) !== connectorLaunchBasename)
    invalid();
  const root = path.dirname(file),
    beforeRoot = directory(root);
  const before = fs.lstatSync(file, { bigint: true });
  fileStat(before);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const held = fs.fstatSync(fd, { bigint: true });
    fileStat(held);
    if (!unchangedFile(before, held)) invalid();
    const bytes = Buffer.alloc(maximumBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (!n) break;
      count += n;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    fileStat(after);
    if (
      BigInt(count) !== before.size ||
      !unchangedFile(before, after) ||
      !unchangedFile(before, fs.lstatSync(file, { bigint: true })) ||
      !same(beforeRoot, directory(root))
    )
      invalid();
    const data = bytes.subarray(0, count),
      launch = parseConnectorLaunch(data);
    if (path.dirname(launch.opened.endpoint.socketPath) !== root) invalid();
    return Object.freeze({
      launch,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  } finally {
    fs.closeSync(fd);
  }
}
