import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  TUNNEL_CLIENT,
  TUNNEL_CLIENT_NOTICES,
} from "../apps/desktop/tunnel-client-contract.ts";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = () => {
  throw new Error("BUNDLED_TUNNEL_CLIENT_INVALID");
};

// Read/copy only: preparing an upstream input never executes it or writes to
// the selected source. Release preparation supplies the reviewed distribution.
async function pinnedBytes(file, sha256, maximum) {
  const handle = await fs.open(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(maximum)
    )
      fail();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      const result = await handle.read(
        buffer,
        count,
        buffer.length - count,
        count,
      );
      if (result.bytesRead === 0) break;
      count += result.bytesRead;
    }
    const bytes = buffer.subarray(0, count);
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      bytes.length !== Number(before.size) ||
      digest(bytes) !== sha256
    )
      fail();
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function verifyBundledTunnelClient(directory) {
  const file = path.join(directory, TUNNEL_CLIENT.entry);
  const bytes = await pinnedBytes(
    file,
    TUNNEL_CLIENT.sha256,
    TUNNEL_CLIENT.size,
  );
  const mode = (await fs.lstat(file)).mode;
  if (
    bytes.length !== TUNNEL_CLIENT.size ||
    bytes.readUInt32LE(0) !== 0xfeedfacf ||
    bytes.readUInt32LE(4) !== 0x0100000c ||
    (mode & 0o111) === 0 ||
    (mode & 0o022) !== 0
  )
    fail();
  for (const notice of TUNNEL_CLIENT_NOTICES)
    await pinnedBytes(
      path.join(directory, notice.entry),
      notice.sha256,
      256 * 1024,
    );
}

export function tunnelClientInputDirectory(root) {
  return path.join(root, "_output", "tunnel-client");
}

export async function prepareTunnelClientInput(root, source) {
  const physicalRoot = await fs.realpath(root);
  const destination = tunnelClientInputDirectory(physicalRoot);
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true });
  if ((await fs.realpath(parent)) !== parent) fail();
  if (
    await fs.lstat(destination).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  ) {
    if ((await fs.realpath(destination)) !== destination) fail();
    await verifyBundledTunnelClient(destination);
    return destination;
  }
  const binary = await pinnedBytes(
    path.join(source, "tunnel-client"),
    TUNNEL_CLIENT.sha256,
    TUNNEL_CLIENT.size,
  );
  const notices = await Promise.all(
    TUNNEL_CLIENT_NOTICES.map(async (notice) => ({
      ...notice,
      bytes: await pinnedBytes(
        path.join(source, notice.source),
        notice.sha256,
        256 * 1024,
      ),
    })),
  );
  const stage = await fs.mkdtemp(path.join(parent, ".tunnel-client-input-"));
  try {
    await fs.chmod(stage, 0o700);
    await fs.writeFile(path.join(stage, TUNNEL_CLIENT.entry), binary, {
      flag: "wx",
      mode: 0o500,
    });
    for (const notice of notices)
      await fs.writeFile(path.join(stage, notice.entry), notice.bytes, {
        flag: "wx",
        mode: 0o400,
      });
    await verifyBundledTunnelClient(stage);
    await fs.rename(stage, destination);
  } finally {
    // This stage never hosts a process; all its writes have completed above.
    await fs.rm(stage, { recursive: true, force: true });
  }
  return destination;
}

export async function embedTunnelClient(directory, root) {
  const input = tunnelClientInputDirectory(root);
  await verifyBundledTunnelClient(input);
  const binary = await pinnedBytes(
    path.join(input, TUNNEL_CLIENT.entry),
    TUNNEL_CLIENT.sha256,
    TUNNEL_CLIENT.size,
  );
  await fs.writeFile(path.join(directory, TUNNEL_CLIENT.entry), binary, {
    flag: "wx",
    mode: 0o500,
  });
  for (const notice of TUNNEL_CLIENT_NOTICES) {
    const bytes = await pinnedBytes(
      path.join(input, notice.entry),
      notice.sha256,
      256 * 1024,
    );
    await fs.writeFile(path.join(directory, notice.entry), bytes, {
      flag: "wx",
      mode: 0o400,
    });
  }
  await verifyBundledTunnelClient(directory);
  return {
    kind: "dependency",
    path: `vendor/tunnel-client-v${TUNNEL_CLIENT.version}-darwin-arm64`,
    sha256: TUNNEL_CLIENT.sha256,
  };
}

// Build-time input preparation only. The installed application does not fetch
// archives, invoke unzip, use Homebrew, or learn a new expected executable hash.
const maximumArchiveBytes = 64 * 1024 * 1024;
export async function provisionTunnelClientInput(root, fetchImpl = fetch) {
  const physicalRoot = await fs.realpath(root);
  const destination = tunnelClientInputDirectory(physicalRoot);
  const exists = await fs.lstat(destination).then(
    () => true,
    (e) => {
      if (e.code === "ENOENT") return false;
      throw e;
    },
  );
  if (exists) {
    if ((await fs.realpath(destination)) !== destination) fail();
    await verifyBundledTunnelClient(destination);
    return destination;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let reader;
  try {
    const response = await fetchImpl(TUNNEL_CLIENT.archiveURL, {
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (
      response.status !== 200 ||
      !response.body ||
      (response.headers.get("content-encoding") &&
        response.headers.get("content-encoding") !== "identity")
    )
      fail();
    const size = response.headers.get("content-length");
    if (
      size !== null &&
      (!/^[1-9][0-9]*$/u.test(size) || Number(size) > maximumArchiveBytes)
    )
      fail();
    reader = response.body.getReader({ mode: "byob" });
    const chunks = [];
    let count = 0;
    while (true) {
      const { done, value } = await reader.read(
        new Uint8Array(Math.min(65536, maximumArchiveBytes + 1 - count)),
      );
      if (done) break;
      count += value.byteLength;
      if (count > maximumArchiveBytes) fail();
      chunks.push(Buffer.from(value));
    }
    if (size !== null && Number(size) !== count) fail();
    const bytes = Buffer.concat(chunks);
    if (digest(bytes) !== TUNNEL_CLIENT.archiveSHA256) fail();
    return await prepareTunnelClientArchive(physicalRoot, bytes);
  } catch {
    // A single failed/unknown read does not trigger a retry or alternate URL.
    throw new Error("TUNNEL_CLIENT_DOWNLOAD_UNAVAILABLE");
  } finally {
    controller.abort();
    clearTimeout(timer);
    await reader?.cancel().catch(() => {});
  }
}
async function prepareTunnelClientArchive(root, bytes) {
  const output = path.join(root, "_output");
  await fs.mkdir(output, { recursive: true });
  if ((await fs.realpath(output)) !== output) fail();
  const parent = path.join(output, "tmp");
  await fs.mkdir(parent, { recursive: true });
  if ((await fs.realpath(parent)) !== parent) fail();
  const stage = await fs.mkdtemp(path.join(parent, "tunnel-client-input-"));
  try {
    await fs.chmod(stage, 0o700);
    const archive = path.join(stage, "upstream.zip");
    await fs.writeFile(archive, bytes, { flag: "wx", mode: 0o400 });
    for (const [name, maximum] of [
      [TUNNEL_CLIENT.entry, TUNNEL_CLIENT.size],
      ...TUNNEL_CLIENT_NOTICES.map((n) => [n.source, 256 * 1024]),
    ]) {
      // Only named entries reach stdout. The archive cannot choose output paths
      // or execute code; independent executable/notice pins are checked next.
      const extracted = execFileSync("/usr/bin/unzip", ["-p", archive, name], {
        timeout: 10000,
        maxBuffer: maximum + 1,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (extracted.length < 1 || extracted.length > maximum) fail();
      await fs.writeFile(path.join(stage, name), extracted, {
        flag: "wx",
        mode: 0o400,
      });
    }
    return await prepareTunnelClientInput(root, stage);
  } finally {
    // This private data stage has no running client or unknown-effect consumer.
    await fs.rm(stage, { recursive: true, force: true });
  }
}
