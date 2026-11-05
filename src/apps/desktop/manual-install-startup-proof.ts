import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";

type ProofBuild = Readonly<{ buildId: string; version: string }>;

/** Publish only after the primary has completed startup, never on open(1) ACK. */
export function publishManualInstallStartupProof(
  args: readonly string[],
  build: ProofBuild,
  pid: number,
  temporaryRoot = "/private/tmp",
): boolean {
  const prefix = "--farol-install-proof=";
  const requests = args.filter((argument) => argument.startsWith(prefix));
  if (requests.length === 0) return false;
  if (requests.length !== 1) throw new Error("INSTALL_STARTUP_PROOF_INVALID");
  const match =
    /^([A-Za-z0-9]{8}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u.exec(
      requests[0]!.slice(prefix.length),
    );
  if (!match) throw new Error("INSTALL_STARTUP_PROOF_INVALID");
  const directory = path.join(temporaryRoot, `farol-release.${match[1]}`);
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700 ||
    realpathSync(directory) !== directory
  )
    throw new Error("INSTALL_STARTUP_PROOF_UNSAFE");
  const proof = path.join(directory, "startup-proof.json");
  const descriptor = openSync(
    proof,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(
      descriptor,
      JSON.stringify({
        schema: "farol.install-startup-proof/1",
        nonce: match[2],
        buildId: build.buildId,
        version: build.version,
        pid,
      }),
    );
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const parent = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  return true;
}
