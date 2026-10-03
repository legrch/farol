import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  qualifyProfileLaunch,
  type ProfileFailure,
  type QualifiedProfileLaunch,
} from "../../apps/desktop/bridge/profile.ts";

// CPU-only node metadata doubles. No real fs/child/provider/auth operation is
// invoked. Descriptor numbers and native flags are synthetic, not kernel proof.
const fixture = vi.hoisted(() => {
  interface Node {
    dev: unknown;
    ino: unknown;
    uid: unknown;
    mode: unknown;
    physical: string;
  }
  const nodes = new Map<string, Node>();
  const descriptors = new Map<number, Node>();
  const faults = new Map<string, unknown>();
  const opened: number[] = [];
  const closed: number[] = [];
  const calls: string[] = [];
  let next = 0;
  let onOpen: ((path: string) => void) | undefined;
  const hit = (key: string): void => {
    calls.push(key);
    if (faults.has(key)) throw faults.get(key);
  };
  const node = (path: string): Node => {
    const selected = nodes.get(path);
    if (!selected)
      throw Object.assign(new Error("private native path"), { code: "ENOENT" });
    return selected;
  };
  const stat = (value: Node | undefined, options: unknown): object => {
    if (!value || (options as { bigint?: unknown }).bigint !== true)
      throw new Error("CPU boundary requires bigint metadata");
    return { dev: value.dev, ino: value.ino, uid: value.uid, mode: value.mode };
  };
  const realpath = (path: string): string => {
    hit("realpath:" + path);
    return node(path).physical;
  };
  const fs = {
    constants: { O_RDONLY: 0, O_DIRECTORY: 0x100000, O_NOFOLLOW: 0x100 },
    lstatSync: (path: string, options: unknown): object => {
      hit("lstat:" + path);
      return stat(node(path), options);
    },
    fstatSync: (fd: number, options: unknown): object => {
      hit("fstat:" + fd);
      return stat(descriptors.get(fd), options);
    },
    realpathSync: Object.assign(realpath, { native: realpath }),
    openSync: (path: string, flags: number): number => {
      hit("open:" + path);
      if (flags !== 0x100100) throw new Error("Unexpected CPU open flags");
      onOpen?.(path);
      const fd = next++;
      descriptors.set(fd, node(path));
      opened.push(fd);
      return fd;
    },
    closeSync: (fd: number): void => {
      closed.push(fd);
      hit("close:" + fd);
      descriptors.delete(fd);
    },
  };
  const reset = (): void => {
    nodes.clear();
    descriptors.clear();
    faults.clear();
    opened.length = 0;
    closed.length = 0;
    calls.length = 0;
    next = 0;
    onOpen = undefined;
    const add = (
      path: string,
      dev: bigint,
      ino: bigint,
      uid: bigint,
      permissions: bigint,
    ): void => {
      nodes.set(path, {
        dev,
        ino,
        uid,
        mode: 0o40000n | permissions,
        physical: path,
      });
    };
    add("/", 1n, 1n, 0n, 0o755n);
    add("/profiles", 7n, 2n, 0n, 0o755n);
    add("/profiles/selected", 7n, 3n, 501n, 0o700n);
    add("/profiles/selected/computer", 7n, 4n, 501n, 0o700n);
    add("/profiles/selected/chat", 7n, 5n, 501n, 0o700n);
    add("/homes", 9n, 6n, 0n, 0o755n);
    add("/homes/explicit", 9n, 7n, 501n, 0o755n);
  };
  return {
    fs,
    nodes,
    faults,
    calls,
    opened,
    closed,
    node,
    reset,
    setOnOpen: (fn: (path: string) => void): void => {
      onOpen = fn;
    },
  };
});
vi.mock("node:fs", () => ({ default: fixture.fs }));

const selection = {
  profileId: "Selected/profile:One",
  root: "/profiles/selected",
  home: "/homes/explicit",
};
let uid: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fixture.reset();
  uid = vi.spyOn(process, "geteuid").mockReturnValue(501);
});
afterEach(() => {
  vi.restoreAllMocks();
});
function qualified(value: unknown = selection): QualifiedProfileLaunch {
  const result = qualifyProfileLaunch(value);
  expect(result.state).toBe("qualified");
  if (result.state !== "qualified") throw new Error("CPU qualification failed");
  return result.profile;
}
function rejected(
  value: unknown,
  state: ProfileFailure["state"],
  code: ProfileFailure["code"],
): void {
  expect(qualifyProfileLaunch(value)).toEqual({ state, code, retry: "never" });
  expect(fixture.closed).toEqual([...fixture.opened].reverse());
}
function nativeError(code: string): object {
  return Object.assign(new Error("private diagnostic /secret/path"), { code });
}

it("returns literal selection and exact canonical uint64 decimals mapped to Go ProfileBinding", () => {
  const device = 9007199254740993n;
  const inode = 18446744073709551615n;
  for (const path of [
    selection.root,
    selection.root + "/computer",
    selection.root + "/chat",
  ])
    fixture.node(path).dev = device;
  fixture.node(selection.root).ino = inode;
  const input = { ...selection };
  const profile = qualified(input);
  input.profileId = "other";
  input.root = "/other";
  input.home = "/other-home";
  const result = profile.beforeSpawn();
  expect(result).toEqual({
    state: "qualified",
    binding: {
      ...selection,
      device: "9007199254740993",
      inode: "18446744073709551615",
    },
  });
  if (result.state !== "qualified") throw new Error("CPU binding failed");
  // This is a local field mapping assertion, not JSON or a new wire schema.
  expect({
    ProfileID: result.binding.profileId,
    Root: result.binding.root,
    Device: BigInt(result.binding.device),
    Inode: BigInt(result.binding.inode),
  }).toEqual({
    ProfileID: selection.profileId,
    Root: selection.root,
    Device: device,
    Inode: inode,
  });
  expect(result.binding.home).toBe("/homes/explicit");
  expect(Object.isFrozen(result.binding)).toBe(true);
  expect(Object.isFrozen(profile)).toBe(true);
  expect(fixture.closed).toEqual([]);
  expect(profile.beforeSpawn()).toEqual({
    state: "refused",
    code: "PROFILE_LAUNCH_CONSUMED",
    retry: "never",
  });
  expect(profile.close()).toEqual({ state: "closed" });
  expect(profile.close()).toEqual({ state: "closed" });
  expect(fixture.closed).toEqual([...fixture.opened].reverse());
  expect(profile.beforeSpawn()).toEqual({
    state: "refused",
    code: "PROFILE_CLOSED",
    retry: "never",
  });
});

it.each(["A", "a".repeat(120), "Profile._:/-1"])(
  "preserves canonical ID %s",
  (profileId) => {
    const profile = qualified({ ...selection, profileId });
    const result = profile.beforeSpawn();
    expect(result.state === "qualified" && result.binding.profileId).toBe(
      profileId,
    );
    profile.close();
  },
);
it.each([
  "",
  ".profile",
  "_profile",
  " profile",
  "profile ",
  "profile\n",
  "a\0b",
  "a\\b",
  "é",
  "a".repeat(121),
  "a".repeat(128),
])("refuses ID without IO: %s", (profileId) => {
  rejected({ ...selection, profileId }, "refused", "PROFILE_SELECTION_INVALID");
  expect(fixture.calls).toEqual([]);
});
it.each([
  "",
  "/",
  "profiles/selected",
  "/profiles//selected",
  "/profiles/./selected",
  "/profiles/../selected",
  "/profiles/selected/",
  "/profiles/\0selected",
  "/profiles/\nselected",
  "/" + "a".repeat(256),
  "/" + "é".repeat(128),
  "/bad\ud800",
  "/" + "a/".repeat(2048) + "a",
])("refuses canonical-path violations in profile and HOME: %s", (path) => {
  for (const field of ["root", "home"]) {
    rejected(
      { ...selection, [field]: path },
      "refused",
      "PROFILE_SELECTION_INVALID",
    );
    expect(fixture.calls).toEqual([]);
  }
});
it("refuses unknown fields, missing explicit HOME, accessors, symbols and aliases without invoking getters", () => {
  let invoked = false;
  const accessor = {
    root: selection.root,
    home: selection.home,
    get profileId(): string {
      invoked = true;
      return selection.profileId;
    },
  };
  const prototype = Object.create(selection) as unknown;
  for (const value of [
    null,
    [],
    prototype,
    { profileId: selection.profileId, root: selection.root },
    { ...selection, device: "7" },
    { ...selection, ProfileID: selection.profileId },
    { ...selection, [Symbol("extra")]: true },
    accessor,
  ]) {
    rejected(value, "refused", "PROFILE_SELECTION_INVALID");
    expect(fixture.calls).toEqual([]);
  }
  expect(invoked).toBe(false);
});

it.each([
  0n,
  -1n,
  1n << 64n,
  7,
  Number.MAX_SAFE_INTEGER + 1,
  NaN,
  Infinity,
  "7",
  "07",
  true,
  null,
])("refuses invalid or numeric device/inode counters: %s", (value) => {
  for (const field of ["dev", "ino"] as const) {
    fixture.reset();
    fixture.node(selection.root)[field] = value;
    rejected(selection, "refused", "PROFILE_METADATA_INVALID");
  }
});
it.each([7, -1n, 1n << 32n, "501"])(
  "refuses malformed bigint UID/mode metadata: %s",
  (value) => {
    for (const field of ["uid", "mode"] as const) {
      fixture.reset();
      fixture.node(selection.root)[field] = value;
      rejected(selection, "refused", "PROFILE_METADATA_INVALID");
    }
  },
);
it.each([Number.MAX_SAFE_INTEGER + 1, NaN, -1, 0x100000000])(
  "refuses unsafe process UID: %s",
  (value) => {
    uid.mockReturnValue(value);
    rejected(selection, "refused", "PROFILE_METADATA_INVALID");
    expect(fixture.calls).toEqual([]);
  },
);

const physicalViolations: readonly [
  string,
  string,
  "mode" | "uid" | "dev" | "ino" | "physical",
  unknown,
][] = [
  ["root mode", selection.root, "mode", 0o40750n],
  ["root owner", selection.root, "uid", 502n],
  ["child mode", selection.root + "/chat", "mode", 0o40701n],
  ["child special mode", selection.root + "/computer", "mode", 0o42700n],
  ["child owner", selection.root + "/chat", "uid", 502n],
  ["child symlink", selection.root + "/chat", "mode", 0o120700n],
  ["child file", selection.root + "/computer", "mode", 0o100700n],
  ["ancestor symlink", "/profiles", "mode", 0o120755n],
  ["shared ancestor", "/profiles", "mode", 0o40777n],
  ["foreign ancestor", "/profiles", "uid", 502n],
  ["different child device", selection.root + "/computer", "dev", 8n],
  ["aliased children", selection.root + "/chat", "ino", 4n],
  ["aliased parent", selection.root + "/computer", "ino", 3n],
  ["profile physical alias", selection.root, "physical", "/profiles/Selected"],
  ["child physical alias", selection.root + "/chat", "physical", "/other/chat"],
  ["HOME physical alias", selection.home, "physical", "/homes/Explicit"],
  ["HOME owner", selection.home, "uid", 502n],
  ["HOME permissions", selection.home, "mode", 0o40777n],
];
it.each(physicalViolations)(
  "refuses %s with exact cleanup",
  (_name, path, field, value) => {
    Object.assign(fixture.node(path), { [field]: value });
    rejected(selection, "refused", "PROFILE_PATH_REFUSED");
  },
);
it.each([
  selection.root,
  selection.root + "/computer",
  selection.root + "/chat",
  selection.home,
])("missing selected existing directory is unavailable: %s", (path) => {
  fixture.nodes.delete(path);
  rejected(selection, "unavailable", "PROFILE_ROOT_UNAVAILABLE");
});
it("detects a named swap between lstat and open and closes its exact opened descriptors", () => {
  fixture.setOnOpen((path) => {
    if (path === selection.root)
      fixture.nodes.set(path, { ...fixture.node(path), ino: 99n });
  });
  rejected(selection, "refused", "PROFILE_CHANGED");
});

it.each([
  "named swap",
  "inode",
  "mode",
  "UID",
  "physical alias",
  "ancestor",
  "HOME",
  "effective UID",
])(
  "sticks after %s changes before spawn without rereading repaired paths",
  (kind) => {
    const profile = qualified();
    const original = { ...fixture.node(selection.root) };
    if (kind === "named swap")
      fixture.nodes.set(selection.root, { ...original, ino: 99n });
    else if (kind === "inode") fixture.node(selection.root).ino = 99n;
    else if (kind === "mode") fixture.node(selection.root).mode = 0o40750n;
    else if (kind === "UID") fixture.node(selection.root).uid = 502n;
    else if (kind === "physical alias")
      fixture.node(selection.root).physical = "/other/profile";
    else if (kind === "ancestor") fixture.node("/profiles").ino = 99n;
    else if (kind === "HOME") fixture.node(selection.home).ino = 99n;
    else uid.mockReturnValue(502);
    const first = profile.beforeSpawn();
    expect(first).toEqual({
      state: "refused",
      code: "PROFILE_CHANGED",
      retry: "never",
    });
    const count = fixture.calls.length;
    fixture.reset();
    uid.mockReturnValue(501);
    expect(profile.beforeSpawn()).toBe(first);
    expect(fixture.calls.length).toBe(0);
    expect(count).toBeGreaterThan(0);
    // reset deliberately lost fixture fd references; close still consumes ONLY
    // the owner's remembered descriptor numbers and never reopens any directory.
    profile.close();
    expect(fixture.closed).toEqual([6, 5, 4, 3, 2, 1, 0]);
  },
);
it.each([
  ["ENOENT", "unavailable", "PROFILE_ROOT_UNAVAILABLE"],
  ["EACCES", "refused", "PROFILE_PATH_REFUSED"],
  ["EINTR", "unavailable", "PROFILE_ROOT_UNAVAILABLE"],
  ["EIO", "unknown", "PROFILE_BOUNDARY_UNKNOWN"],
] as const)(
  "classifies %s without native path disclosure or retry",
  (code, state, failureCode) => {
    fixture.faults.set("lstat:" + selection.root + "/chat", nativeError(code));
    rejected(selection, state, failureCode);
    expect(
      fixture.calls.filter(
        (call) => call === "lstat:" + selection.root + "/chat",
      ),
    ).toHaveLength(1);
  },
);
it("retains unknown before-spawn failures and never invokes raw error code getters", () => {
  const profile = qualified();
  let invoked = false;
  fixture.faults.set("fstat:0", {
    get code(): string {
      invoked = true;
      return "ENOENT";
    },
  });
  const first = profile.beforeSpawn();
  expect(first).toEqual({
    state: "unknown",
    code: "PROFILE_BOUNDARY_UNKNOWN",
    retry: "never",
  });
  fixture.faults.clear();
  expect(profile.beforeSpawn()).toBe(first);
  expect(invoked).toBe(false);
  expect(JSON.stringify(first)).not.toContain("secret");
  profile.close();
});
it("keeps close uncertainty sticky and never retries a consumed fd, including failed qualification cleanup", () => {
  const profile = qualified();
  fixture.faults.set("close:3", nativeError("EINTR"));
  const first = profile.close();
  expect(first).toEqual({
    state: "unknown",
    code: "PROFILE_CLEANUP_UNKNOWN",
    retry: "never",
  });
  expect(profile.close()).toBe(first);
  expect(profile.beforeSpawn()).toBe(first);
  expect(fixture.closed).toEqual([...fixture.opened].reverse());
  fixture.reset();
  fixture.nodes.delete(selection.root + "/chat");
  fixture.faults.set("close:0", nativeError("EINTR"));
  rejected(selection, "unknown", "PROFILE_CLEANUP_UNKNOWN");
});

it("refuses unknown high mode bits instead of masking them into private permissions", () => {
  fixture.node(selection.root).mode = (1n << 31n) | 0o40700n;
  rejected(selection, "refused", "PROFILE_METADATA_INVALID");
});
