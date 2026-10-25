import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parseCoreArtifactDeclaration } from "./attested-core.ts";
import { BridgeError } from "./client.ts";
import {
  qualificationMetrics,
  type QualificationObserver,
  type QualificationResult,
} from "./qualification-metrics.ts";

// One startup budget bounds resource and Shell qualification together. It is
// liveness only: integrity comes from the digests and the final stat recheck,
// never from the clock. Startup on a busy Mac measured 2 s for work that takes
// 0.3 s idle, so the budget leaves room for a slow launch.
export const CORE_QUALIFICATION_BUDGET_MS = 10_000;

const refuse = (): never => {
  throw new BridgeError("refused", "core_resources_unqualified");
};
// A spent budget is a different fact from changed or wrong bytes, and the
// startup report must be able to say which one stopped the launch.
class DeadlineExpired extends Error {}
const expire = (): never => {
  throw new DeadlineExpired();
};
function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return refuse();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return refuse();
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return refuse();
    result[key] = descriptor.value as unknown;
  }
  return result;
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

// Expected bytes are compiled into the trusted host after its other resources
// and backend are produced. A disk manifest or fresh measurement is not a source
// of expectations. This does not attest the host itself or package-only metadata.
export async function verifyCoreResources(
  root: string,
  compiled: unknown,
  expectedCore: unknown,
  deadline: number,
  observer?: QualificationObserver,
): Promise<void> {
  const metrics = qualificationMetrics("core-resources", deadline, observer);
  let result: QualificationResult = "refused";
  try {
    const declared = record(compiled, ["schema", "core", "files"]);
    const core = parseCoreArtifactDeclaration(declared.core);
    if (
      declared.schema !== "farol-core-resources/1" ||
      JSON.stringify(core) !==
        JSON.stringify(parseCoreArtifactDeclaration(expectedCore))
    )
      refuse();
    const list = declared.files;
    if (
      !Array.isArray(list) ||
      list.length < 2 ||
      list.length > 128 ||
      Object.getPrototypeOf(list) !== Array.prototype ||
      Reflect.ownKeys(list).length !== list.length + 1
    )
      refuse();
    const files: { path: string; size: number; sha256: string }[] = [];
    let previous = "";
    let total = 0;
    for (let i = 0; i < (list as unknown[]).length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(list, String(i));
      if (!descriptor?.enumerable || !("value" in descriptor)) refuse();
      const file = record(descriptor!.value, ["path", "size", "sha256"]);
      if (
        typeof file.path !== "string" ||
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.exec(file.path)?.[0] !==
          file.path ||
        ["main.cjs", "build-manifest.json"].includes(file.path) ||
        file.path <= previous ||
        typeof file.size !== "number" ||
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        file.size > 128 * 1024 * 1024 ||
        typeof file.sha256 !== "string" ||
        /^[a-f0-9]{64}$/u.exec(file.sha256)?.[0] !== file.sha256
      )
        refuse();
      const item = file as { path: string; size: number; sha256: string };
      files.push({ ...item });
      previous = item.path;
      total += item.size;
    }
    const backend = files.find((file) => file.path === core.binary.path);
    if (
      total > 256 * 1024 * 1024 ||
      !files.some((file) => file.path === "core-artifact.json") ||
      backend?.size !== core.binary.size ||
      backend?.sha256 !== core.binary.sha256
    )
      refuse();
    if (Number.isFinite(deadline) && deadline <= performance.now()) expire();
    if (
      !Number.isFinite(deadline) ||
      deadline > performance.now() + 30_000 ||
      !path.isAbsolute(root) ||
      root === "/" ||
      path.resolve(root) !== root ||
      (await fs.realpath(root)) !== root
    )
      refuse();
    const checkTime = (): void => {
      if (performance.now() >= deadline) expire();
    };
    const uid = process.getuid?.();
    if (uid === undefined) refuse();
    const owned = (stat: BigIntStats): boolean =>
      stat.uid === 0n || stat.uid === BigInt(uid!);
    const beforeRoot = await metrics.time("stat", () =>
      fs.lstat(root, { bigint: true }),
    );
    if (
      !beforeRoot.isDirectory() ||
      !owned(beforeRoot) ||
      (beforeRoot.mode & 0o022n) !== 0n
    )
      refuse();
    const observations: [string, BigIntStats][] = [];
    const buffer = Buffer.alloc(1024 * 1024);
    for (const file of files) {
      metrics.file();
      checkTime();
      const target = path.join(root, file.path);
      const handle = await metrics.time("open", () =>
        fs.open(
          target,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        ),
      );
      try {
        const before = await metrics.time("stat", () =>
          handle.stat({ bigint: true }),
        );
        if (
          !before.isFile() ||
          !owned(before) ||
          before.nlink !== 1n ||
          before.size !== BigInt(file.size) ||
          (before.mode & 0o022n) !== 0n
        )
          refuse();
        const digest = createHash("sha256");
        let offset = 0;
        while (offset <= file.size) {
          checkTime();
          const { bytesRead } = await metrics.time("read", () =>
            handle.read(
              buffer,
              0,
              Math.min(buffer.length, file.size + 1 - offset),
              offset,
            ),
          );
          if (!bytesRead) break;
          metrics.bytes(bytesRead);
          offset += bytesRead;
          if (offset > file.size) refuse();
          metrics.sync("hash", () =>
            digest.update(buffer.subarray(0, bytesRead)),
          );
        }
        if (
          offset !== file.size ||
          metrics.sync("hash", () => digest.digest("hex")) !== file.sha256 ||
          !same(
            before,
            await metrics.time("stat", () => handle.stat({ bigint: true })),
          )
        )
          refuse();
        observations.push([target, before]);
      } finally {
        await metrics.time("open", () => handle.close());
      }
    }
    for (const [target, before] of observations) {
      checkTime();
      metrics.entry();
      if (
        !same(
          before,
          await metrics.time("recheck", () =>
            fs.lstat(target, { bigint: true }),
          ),
        )
      )
        refuse();
    }
    if (
      !same(beforeRoot, await fs.lstat(root, { bigint: true })) ||
      (await fs.realpath(root)) !== root
    )
      refuse();
    checkTime();
    result = "passed";
  } catch (error) {
    if (error instanceof DeadlineExpired) {
      result = "deadline-expired";
      throw new BridgeError("refused", "core_resources_deadline_expired");
    }
    refuse();
  } finally {
    metrics.finish(result);
  }
}
