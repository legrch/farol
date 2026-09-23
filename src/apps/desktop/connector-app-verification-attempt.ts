import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const CLOSE_ON_EXEC =
  (fsConstants as typeof fsConstants & { O_CLOEXEC?: number }).O_CLOEXEC ?? 0;

function attemptPath(root: string, challengeSha256: string): string {
  if (!path.isAbsolute(root) || root.includes("\0")) {
    throw new Error("CONNECTOR_APP_VERIFICATION_ROOT_INVALID");
  }
  if (!/^[a-f0-9]{64}$/u.test(challengeSha256)) {
    throw new Error("CONNECTOR_APP_VERIFICATION_CHALLENGE_INVALID");
  }
  return path.join(root, `app-verification-${challengeSha256}.json`);
}

async function assertPrivateRoot(root: string): Promise<void> {
  const info = await lstat(root);
  const uid = process.geteuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (uid !== undefined && info.uid !== uid) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error("CONNECTOR_APP_VERIFICATION_ROOT_UNSAFE");
  }
}

export async function connectorAppVerificationAttemptExists(
  root: string,
  challengeSha256: string,
): Promise<boolean> {
  const target = attemptPath(root, challengeSha256);
  await assertPrivateRoot(root);
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Claim immediately before the first possible send. The name contains only a
 * challenge digest and O_EXCL prevents a second send after an unknown result. */
export async function claimConnectorAppVerificationAttempt(
  root: string,
  challengeSha256: string,
): Promise<void> {
  const target = attemptPath(root, challengeSha256);
  await assertPrivateRoot(root);
  let handle;
  try {
    handle = await open(
      target,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NO_FOLLOW |
        CLOSE_ON_EXEC,
      0o600,
    );
    await handle.writeFile(
      `${JSON.stringify({ schema: 1, challengeSha256, attemptedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await handle.sync();
    await handle.close();
    handle = undefined;
    const directory = await open(
      root,
      fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW | CLOSE_ON_EXEC,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("CONNECTOR_APP_VERIFICATION_ALREADY_ATTEMPTED");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

// Both durable steps finish before the route is allowed to click Send. The
// claim comes first: a failed or partial claim cannot leave settings claiming
// that an unsubmitted ChatGPT message has an unknown outcome.
export async function prepareConnectorAppVerificationAttempt(
  root: string,
  challengeSha256: string,
  recordPending: () => Promise<boolean>,
): Promise<void> {
  await claimConnectorAppVerificationAttempt(root, challengeSha256);
  if (!(await recordPending())) {
    throw new Error("CONNECTOR_APP_VERIFICATION_STATE_UNAVAILABLE");
  }
}
