import fs, { type BigIntStats } from "node:fs";
import { posix } from "node:path";

// Trusted Electron host input only. HOME is an independently selected launch
// input, never derived from the profile, cwd, renderer data or process.env.
export interface TrustedProfileSelection {
  readonly profileId: string;
  readonly root: string;
  readonly home: string;
}

// Local launch projection, not a wire protocol. Lead maps profileId/root to Go
// ProfileBinding.ProfileID/Root and parses device/inode directly as uint64 decimal
// into Device/Inode. HOME remains separate; never pass it as profile or approval.
export interface ProfileLaunchBinding extends TrustedProfileSelection {
  readonly device: string;
  readonly inode: string;
}

type ProfileCode =
  | "PROFILE_SELECTION_INVALID"
  | "PROFILE_METADATA_INVALID"
  | "PROFILE_PATH_REFUSED"
  | "PROFILE_ROOT_UNAVAILABLE"
  | "PROFILE_BOUNDARY_UNKNOWN"
  | "PROFILE_CHANGED"
  | "PROFILE_LAUNCH_CONSUMED"
  | "PROFILE_CLOSED"
  | "PROFILE_CLEANUP_UNKNOWN"
  | "PROFILE_NATIVE_UNSUPPORTED";
export type ProfileFailure = Readonly<{
  state: "refused" | "unavailable" | "unknown";
  code: ProfileCode;
  retry: "never";
}>;
export type ProfileBeforeSpawn =
  | Readonly<{ state: "qualified"; binding: ProfileLaunchBinding }>
  | ProfileFailure;
export type ProfileClose = Readonly<{ state: "closed" }> | ProfileFailure;
export interface QualifiedProfileLaunch {
  // One attempt, consumed before checking. Lead must spawn immediately and keep
  // this owner until Go consumers close; proof cannot atomically bind path spawn.
  beforeSpawn(): ProfileBeforeSpawn;
  close(): ProfileClose;
}
export type ProfileQualification =
  | Readonly<{ state: "qualified"; profile: QualifiedProfileLaunch }>
  | ProfileFailure;

class ProfileFault extends Error {
  constructor(readonly failure: ProfileFailure) {
    super(failure.code);
  }
}
function failure(
  state: ProfileFailure["state"],
  code: ProfileCode,
): ProfileFailure {
  return Object.freeze({ state, code, retry: "never" });
}
function refuse(code: ProfileCode): never {
  throw new ProfileFault(failure("refused", code));
}
function classify(error: unknown): ProfileFailure {
  if (error instanceof ProfileFault) return error.failure;
  // Read a data descriptor only: do not invoke an unknown error's code getter or
  // expose native paths/messages. Unknown failures stay unknown, without retry.
  try {
    const code: unknown =
      error !== null && typeof error === "object"
        ? Object.getOwnPropertyDescriptor(error, "code")?.value
        : undefined;
    if (
      code === "ENOENT" ||
      code === "ENODEV" ||
      code === "EBADF" ||
      code === "EMFILE" ||
      code === "ENFILE" ||
      code === "EINTR"
    )
      return failure("unavailable", "PROFILE_ROOT_UNAVAILABLE");
    if (
      code === "EACCES" ||
      code === "EPERM" ||
      code === "ELOOP" ||
      code === "ENOTDIR"
    )
      return failure("refused", "PROFILE_PATH_REFUSED");
  } catch {
    // No fallback reads, error stringification or recovery.
  }
  return failure("unknown", "PROFILE_BOUNDARY_UNKNOWN");
}
function record(
  value: unknown,
  keys: readonly string[],
  code: ProfileCode,
): Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      refuse(code);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) refuse(code);
    const own = Reflect.ownKeys(value);
    if (
      own.length !== keys.length ||
      own.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      refuse(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const parsed: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        refuse(code);
      parsed[key] = descriptor.value as unknown;
    }
    return parsed;
  } catch {
    return refuse(code);
  }
}
function canonicalPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length <= 1 ||
    value.length > 4096 ||
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    Buffer.byteLength(value) > 4096 ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.endsWith("/") ||
    /[\x00-\x1f\x7f]/u.test(value)
  )
    return refuse("PROFILE_SELECTION_INVALID");
  if (
    value
      .slice(1)
      .split("/")
      .some((part) => !part || Buffer.byteLength(part) > 255)
  )
    return refuse("PROFILE_SELECTION_INVALID");
  return value;
}
function parseSelection(value: unknown): TrustedProfileSelection {
  const selected = record(
    value,
    ["profileId", "root", "home"],
    "PROFILE_SELECTION_INVALID",
  );
  if (
    typeof selected.profileId !== "string" ||
    selected.profileId.length < 1 ||
    selected.profileId.length > 120 ||
    !/^[A-Za-z0-9]/u.test(selected.profileId) ||
    /[^A-Za-z0-9._:/-]/u.test(selected.profileId)
  )
    return refuse("PROFILE_SELECTION_INVALID");
  return Object.freeze({
    profileId: selected.profileId,
    root: canonicalPath(selected.root),
    home: canonicalPath(selected.home),
  });
}

interface Metadata {
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
}
const uint64Max = (1n << 64n) - 1n;
const uint32Max = (1n << 32n) - 1n;
function counter(value: unknown, minimum: bigint, maximum: bigint): bigint {
  // Node must supply bigint stats. Even safe numeric counters are refused here;
  // no device/inode ever passes through Number, parseInt or lossy coercion.
  if (typeof value !== "bigint" || value < minimum || value > maximum)
    return refuse("PROFILE_METADATA_INVALID");
  return value;
}
function metadata(value: unknown): Metadata {
  const stat = record(
    value,
    ["device", "inode", "uid", "mode"],
    "PROFILE_METADATA_INVALID",
  );
  return Object.freeze({
    device: counter(stat.device, 1n, uint64Max),
    inode: counter(stat.inode, 1n, uint64Max),
    uid: counter(stat.uid, 0n, uint32Max),
    // Darwin stat.Mode is uint16; unknown high mode bits fail closed.
    mode: counter(stat.mode, 0n, 0o177777n),
  });
}
function same(a: Metadata, b: Metadata): boolean {
  return (
    a.device === b.device &&
    a.inode === b.inode &&
    a.uid === b.uid &&
    a.mode === b.mode
  );
}
function sameIdentity(a: Metadata, b: Metadata): boolean {
  return a.device === b.device && a.inode === b.inode;
}
type DirectoryPolicy = "ancestor" | "home" | "private";
function validateDirectory(
  stat: Metadata,
  uid: bigint,
  policy: DirectoryPolicy,
): void {
  if ((stat.mode & 0o170000n) !== 0o40000n) refuse("PROFILE_PATH_REFUSED");
  if (policy === "private") {
    if (stat.uid !== uid || (stat.mode & 0o7777n) !== 0o700n)
      refuse("PROFILE_PATH_REFUSED");
  } else if (
    (stat.mode & 0o7022n) !== 0n ||
    (policy === "home" ? stat.uid !== uid : stat.uid !== 0n && stat.uid !== uid)
  ) {
    refuse("PROFILE_PATH_REFUSED");
  }
}

// Private adapter boundary. Unit tests replace node:fs/process UID with CPU
// doubles; production always selects actual Node metadata operations below.
interface ProfileBoundary {
  uid(): unknown;
  lstat(path: string): unknown;
  fstat(fd: number): unknown;
  realpath(path: string): unknown;
  open(path: string): unknown;
  close(fd: number): void;
}
function nodeMetadata(stat: BigIntStats): unknown {
  return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode };
}
const nodeBoundary: ProfileBoundary = {
  uid: () => {
    const uid: unknown = process.geteuid?.();
    if (
      typeof uid !== "number" ||
      !Number.isSafeInteger(uid) ||
      uid < 0 ||
      uid > 0xffffffff
    )
      return refuse("PROFILE_METADATA_INVALID");
    return BigInt(uid);
  },
  lstat: (path) => nodeMetadata(fs.lstatSync(path, { bigint: true })),
  fstat: (fd) => nodeMetadata(fs.fstatSync(fd, { bigint: true })),
  realpath: (path) => fs.realpathSync.native(path),
  open: (path) => {
    const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;
    if (
      process.platform !== "darwin" ||
      ![O_RDONLY, O_DIRECTORY, O_NOFOLLOW].every(
        (flag) => typeof flag === "number" && Number.isSafeInteger(flag),
      ) ||
      O_DIRECTORY === 0 ||
      O_NOFOLLOW === 0
    )
      return refuse("PROFILE_NATIVE_UNSUPPORTED");
    return fs.openSync(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  },
  close: (fd) => fs.closeSync(fd),
};
interface PinnedDirectory {
  readonly path: string;
  readonly stat: Metadata;
  readonly policy: DirectoryPolicy;
  fd: number | null;
}
function components(path: string): string[] {
  const paths = ["/"];
  let current = "/";
  for (const part of path.slice(1).split("/")) {
    current = posix.join(current, part);
    paths.push(current);
  }
  return paths;
}

// Metadata/launch proof ONLY. No state-file read, Computer approval, journal
// incarnation, participant, authority or clean-retirement evidence is produced.
// No create/chmod/discovery/recovery/fallback/retry. All opened fds are retained;
// Lead owns startup argument composition and normal Electron/Go activation.
export function qualifyProfileLaunch(value: unknown): ProfileQualification {
  const boundary = nodeBoundary;
  const pinned: PinnedDirectory[] = [];
  let terminal: ProfileFailure | undefined;
  let closed: ProfileClose | undefined;
  let consumed = false;
  const close = (): ProfileClose => {
    if (closed) return closed;
    let uncertain = false;
    for (const directory of [...pinned].reverse()) {
      const fd = directory.fd;
      directory.fd = null; // Consume before close; never retry a possibly reused fd.
      if (fd !== null) {
        try {
          boundary.close(fd);
        } catch {
          uncertain = true;
        }
      }
    }
    if (uncertain) {
      terminal = failure("unknown", "PROFILE_CLEANUP_UNKNOWN");
      closed = terminal;
    } else {
      closed = Object.freeze({ state: "closed" });
    }
    return closed;
  };
  try {
    const selected = parseSelection(value);
    const uid = counter(boundary.uid(), 0n, uint32Max);
    const pin = (path: string, policy: DirectoryPolicy): PinnedDirectory => {
      const existing = pinned.find((entry) => entry.path === path);
      if (existing) {
        validateDirectory(existing.stat, uid, policy);
        return existing;
      }
      const initial = metadata(boundary.lstat(path));
      validateDirectory(initial, uid, policy);
      if (boundary.realpath(path) !== path) refuse("PROFILE_PATH_REFUSED");
      const fd: unknown = boundary.open(path);
      if (typeof fd !== "number" || !Number.isSafeInteger(fd) || fd < 0)
        refuse("PROFILE_METADATA_INVALID");
      const directory: PinnedDirectory = { path, stat: initial, policy, fd };
      pinned.push(directory); // Register ownership before any post-open check.
      if (!same(initial, metadata(boundary.fstat(fd))))
        refuse("PROFILE_CHANGED");
      return directory;
    };
    let root: PinnedDirectory | undefined;
    for (const path of components(selected.root))
      root = pin(path, path === selected.root ? "private" : "ancestor");
    if (!root) return refuse("PROFILE_SELECTION_INVALID");
    const computer = pin(posix.join(selected.root, "computer"), "private");
    const chat = pin(posix.join(selected.root, "chat"), "private");
    if (
      computer.stat.device !== root.stat.device ||
      chat.stat.device !== root.stat.device ||
      sameIdentity(computer.stat, chat.stat) ||
      sameIdentity(root.stat, computer.stat) ||
      sameIdentity(root.stat, chat.stat)
    )
      refuse("PROFILE_PATH_REFUSED");
    for (const path of components(selected.home))
      pin(path, path === selected.home ? "home" : "ancestor");
    const check = (): void => {
      if (counter(boundary.uid(), 0n, uint32Max) !== uid)
        refuse("PROFILE_CHANGED");
      for (const directory of pinned) {
        if (directory.fd === null) refuse("PROFILE_CLOSED");
        const current = metadata(boundary.fstat(directory.fd));
        const named = metadata(boundary.lstat(directory.path));
        if (
          !same(directory.stat, current) ||
          !same(directory.stat, named) ||
          boundary.realpath(directory.path) !== directory.path
        )
          refuse("PROFILE_CHANGED");
        validateDirectory(current, uid, directory.policy);
      }
    };
    check();
    const binding: ProfileLaunchBinding = Object.freeze({
      ...selected,
      device: root.stat.device.toString(10),
      inode: root.stat.inode.toString(10),
    });
    const profile: QualifiedProfileLaunch = Object.freeze({
      beforeSpawn: (): ProfileBeforeSpawn => {
        if (terminal) return terminal;
        if (closed) return failure("refused", "PROFILE_CLOSED");
        if (consumed) return failure("refused", "PROFILE_LAUNCH_CONSUMED");
        consumed = true;
        try {
          check();
          return Object.freeze({ state: "qualified", binding });
        } catch (error) {
          terminal = classify(error);
          return terminal;
        }
      },
      close,
    });
    return Object.freeze({ state: "qualified", profile });
  } catch (error) {
    const rejected = classify(error);
    const cleanup = close();
    return cleanup.state === "unknown" ? cleanup : rejected;
  }
}
