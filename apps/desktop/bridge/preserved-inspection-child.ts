import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { BridgeError } from "./client.ts";
import { parseJSON } from "./frame.ts";
import type {
  ExactPreservedRecoverySelection,
  PreservedRecoveryRoot,
  PreservedRecoverySelectionInput,
} from "./preserved-recovery-child.ts";
import type { ProfileLaunchBinding } from "./profile.ts";
import { validate } from "./wire.ts";

const digestKeys = [
  "HandoffDigest",
  "LifecycleDigest",
  "ResultsDigest",
] as const;

function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
  )
    throw Error("invalid object");
  return value as Record<string, unknown>;
}
function id(value: unknown): boolean {
  return (
    typeof value === "string" && value.length <= 120 && validate("id", value)
  );
}
function digest(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 32 &&
    Array.from(value).every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  );
}
function root(value: unknown): PreservedRecoveryRoot {
  const v = object(value, ["Device", "Inode", "OwnerUID"]);
  if (
    ![v.Device, v.Inode].every(
      (n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0,
    ) ||
    !validate("uint32", v.OwnerUID)
  )
    throw Error("invalid root");
  return v as unknown as PreservedRecoveryRoot;
}
// Used only after bounded JSON validation, on private copies of caller data.
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

// Read-only transport for one canonical Go observation. Returned digest metadata
// grants no recovery authority, historical ACK or process/terminal proof. Trusted
// composition owns executable attestation and profile/process exclusion; Go owns
// schema, journal and effect qualification. This adapter never prepares recovery.
export function inspectPreservedRecoveryChild(
  executable: string,
  profile: ProfileLaunchBinding,
  selectionInput: PreservedRecoverySelectionInput,
  exact: ExactPreservedRecoverySelection,
): Promise<PreservedRecoverySelectionInput> {
  return runPreservedInspectionChild(
    "observe-preserved-profile",
    executable,
    profile,
    selectionInput,
    exact,
  );
}

// Explicit candidate-scope discovery only. The caller supplies an empty current
// generation; the same attested original child must return its canonical scope.
// The result still grants no preparation, historical terminal or replay right.
export function discoverPreservedRecoveryChild(
  executable: string,
  profile: ProfileLaunchBinding,
  selectionInput: PreservedRecoverySelectionInput,
  exact: ExactPreservedRecoverySelection,
): Promise<PreservedRecoverySelectionInput> {
  return runPreservedInspectionChild(
    "discover-preserved-profile",
    executable,
    profile,
    selectionInput,
    exact,
  );
}

function runPreservedInspectionChild(
  command: "observe-preserved-profile" | "discover-preserved-profile",
  executable: string,
  profile: ProfileLaunchBinding,
  selectionInput: PreservedRecoverySelectionInput,
  exact: ExactPreservedRecoverySelection,
): Promise<PreservedRecoverySelectionInput> {
  const discoverScope = command === "discover-preserved-profile";
  const deadlineAt = performance.now() + 8000;
  let selectedProfile: ProfileLaunchBinding;
  let expected: ExactPreservedRecoverySelection;
  let input: PreservedRecoverySelectionInput;
  let payload: string;
  try {
    selectedProfile = structuredClone(profile);
    expected = structuredClone(exact);
    input = structuredClone(selectionInput);
    object(expected, [
      "buildId",
      "operationId",
      "current",
      "hostLifetimeId",
      "childLaunchId",
      "backendGeneration",
    ]);
    const current = object(expected.current, [
      "Scope",
      "ParentRoot",
      "ChatRoot",
    ]);
    const scope = object(current.Scope, ["ProfileID", "BackendGeneration"]);
    root(current.ParentRoot);
    root(current.ChatRoot);
    if (
      !isAbsolute(executable) ||
      !validate("string", executable) ||
      /[\0\r\n]/u.test(executable) ||
      ![
        expected.buildId,
        expected.hostLifetimeId,
        expected.childLaunchId,
        expected.backendGeneration,
        selectedProfile.profileId,
        scope.ProfileID,
      ].every(id) ||
      (discoverScope
        ? scope.BackendGeneration !== ""
        : !id(scope.BackendGeneration)) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(
        expected.operationId,
      ) ||
      !isAbsolute(selectedProfile.root) ||
      !validate("string", selectedProfile.root) ||
      /[\0\r\n]/u.test(selectedProfile.root) ||
      !validate("decimal", selectedProfile.device) ||
      !validate("decimal", selectedProfile.inode) ||
      BigInt(selectedProfile.device) !==
        BigInt(expected.current.ParentRoot.Device) ||
      BigInt(selectedProfile.inode) !==
        BigInt(expected.current.ParentRoot.Inode) ||
      scope.ProfileID !== selectedProfile.profileId ||
      scope.BackendGeneration === expected.backendGeneration
    )
      throw Error("invalid selection");
    const hasProfile = Object.hasOwn(input, "Profile");
    const v = object(input, [
      "Selection",
      "OwnerID",
      "ComputerID",
      "AccessDigest",
      "Mutations",
      ...(hasProfile ? ["Profile"] : []),
    ]);
    if (
      hasProfile &&
      !isDeepStrictEqual(v.Profile, {
        ProfileID: "",
        Root: "",
        Device: 0,
        Inode: 0,
      })
    )
      throw Error("profile override");
    const selected = object(v.Selection, [
      "OperationID",
      "Current",
      ...digestKeys,
      "Next",
      "BuildID",
      "HostLifetimeID",
      "ChildLaunchID",
    ]);
    if (
      !isDeepStrictEqual(selected.Current, expected.current) ||
      selected.OperationID !== expected.operationId ||
      selected.BuildID !== expected.buildId ||
      selected.HostLifetimeID !== expected.hostLifetimeId ||
      selected.ChildLaunchID !== expected.childLaunchId ||
      !isDeepStrictEqual(selected.Next, {
        ProfileID: selectedProfile.profileId,
        BackendGeneration: expected.backendGeneration,
      }) ||
      !digestKeys.every((key) => {
        const bytes = selected[key];
        return digest(bytes) && bytes.every((n) => n === 0);
      }) ||
      !digest(v.AccessDigest) ||
      !v.AccessDigest.some((n) => n !== 0) ||
      !id(v.OwnerID) ||
      !id(v.ComputerID) ||
      !Array.isArray(v.Mutations) ||
      v.Mutations.length > 128 ||
      !validate("json", input)
    )
      throw Error("input correlation mismatch");
    payload = `${JSON.stringify(input)}\n`;
    if (
      Buffer.byteLength(payload) > 65536 ||
      !isDeepStrictEqual(parseJSON(payload), input)
    )
      throw Error("invalid input JSON");
    freeze(input);
    if (performance.now() >= deadlineAt)
      throw Error("original deadline expired");
  } catch {
    return Promise.reject(
      new BridgeError("refused", "preserved_inspection_selection_invalid"),
    );
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        executable,
        [
          command,
          "--profile",
          selectedProfile.profileId,
          "--profile-root",
          selectedProfile.root,
          "--profile-device",
          selectedProfile.device,
          "--profile-inode",
          selectedProfile.inode,
          "--expected-build",
          expected.buildId,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch {
      reject(
        new BridgeError("unknown", "preserved_inspection_launch_unconfirmed"),
      );
      return;
    }
    let pending = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let result: PreservedRecoverySelectionInput | undefined;
    let written = false;
    let closed = false;
    let failed = false;
    let settled = false;
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(
      () => fail(),
      Math.max(1, deadlineAt - performance.now()),
    );
    const rejectUnknown = (code: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(cleanupDeadline);
      reject(new BridgeError("unknown", code));
    };
    const complete = (): void => {
      if (settled || !closed) return;
      if (failed) {
        rejectUnknown("preserved_inspection_unconfirmed");
        return;
      }
      if (performance.now() >= deadlineAt || !result || pending.length !== 0) {
        fail();
        return;
      }
      // A same-child normal close may precede the original end callback.
      if (!written) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(cleanupDeadline);
      resolve(result);
    };
    const fail = (): void => {
      if (failed || settled) return;
      failed = true;
      pending = Buffer.alloc(0);
      clearTimeout(deadline);
      if (closed) {
        complete();
        return;
      }
      // Signal only this retained handle, once. A forced or missing close stays
      // UNKNOWN regardless of kill's return value or a later successful reply.
      cleanupDeadline = setTimeout(
        () => rejectUnknown("preserved_inspection_cleanup_unconfirmed"),
        1000,
      );
      try {
        child.kill("SIGKILL");
      } catch {
        /* Only the original child's close event is an observation. */
      }
    };
    child.once("close", (code, signal) => {
      closed = true;
      if (code !== 0 || signal !== null) failed = true;
      complete();
    });
    child.once("error", fail);
    if (!child.stdin || !child.stdout || !child.stderr) {
      fail();
      return;
    }
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stderr.on("data", (chunk: Buffer) => {
      if (failed || settled) return;
      if (!Buffer.isBuffer(chunk) || chunk.length > 8192 - stderrBytes) fail();
      else stderrBytes += chunk.length; // Count only; never retain diagnostics.
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (failed || settled) return;
      if (
        performance.now() >= deadlineAt ||
        !Buffer.isBuffer(chunk) ||
        chunk.length > 16384 - stdoutBytes
      ) {
        fail();
        return;
      }
      stdoutBytes += chunk.length;
      pending = Buffer.concat([pending, chunk]);
      try {
        const newline = pending.indexOf(10);
        if (newline === -1) {
          if (result && pending.length !== 0) throw Error("extra stdout");
          return;
        }
        if (result || newline !== pending.length - 1)
          throw Error("extra stdout");
        const reply = object(
          parseJSON(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              pending.subarray(0, newline),
            ),
          ),
          ["schema", "buildId", "selection", "recoveryAuthorized"],
        );
        if (
          reply.schema !== "farol-preserved-profile-inspection/1" ||
          reply.buildId !== expected.buildId ||
          reply.recoveryAuthorized !== false
        )
          throw Error("invalid inspection envelope");
        const selected = object(reply.selection, Object.keys(input.Selection));
        let observedCurrent = input.Selection.Current;
        if (discoverScope) {
          const current = object(selected.Current, [
            "Scope",
            "ParentRoot",
            "ChatRoot",
          ]);
          const scope = object(current.Scope, [
            "ProfileID",
            "BackendGeneration",
          ]);
          if (
            scope.ProfileID !== input.Selection.Current.Scope.ProfileID ||
            !id(scope.BackendGeneration) ||
            scope.BackendGeneration === expected.backendGeneration
          )
            throw Error("invalid discovered scope");
          observedCurrent = {
            ...input.Selection.Current,
            Scope: {
              ProfileID: input.Selection.Current.Scope.ProfileID,
              BackendGeneration: scope.BackendGeneration as string,
            },
          };
        }
        for (const [key, value] of Object.entries(input.Selection)) {
          if (!digestKeys.some((digestKey) => digestKey === key)) {
            if (
              !isDeepStrictEqual(
                selected[key],
                key === "Current" ? observedCurrent : value,
              )
            )
              throw Error("selection correlation mismatch");
          }
        }
        for (const key of digestKeys) {
          const bytes = selected[key];
          if (
            !digest(bytes) ||
            (key !== "HandoffDigest" && !bytes.some((n) => n !== 0))
          )
            throw Error("invalid observation digest");
        }
        result = freeze({
          ...input,
          Selection: {
            ...input.Selection,
            Current: structuredClone(observedCurrent),
            HandoffDigest: [...(selected.HandoffDigest as number[])],
            LifecycleDigest: [...(selected.LifecycleDigest as number[])],
            ResultsDigest: [...(selected.ResultsDigest as number[])],
          },
        });
        pending = Buffer.alloc(0);
        if (performance.now() >= deadlineAt) fail();
      } catch {
        fail();
      }
    });
    child.stdout.on("end", () => {
      if (!result || pending.length !== 0) fail();
    });
    try {
      // Closing stdin is part of this one request, never a second operation.
      if (performance.now() >= deadlineAt) fail();
      else
        child.stdin.end(payload, (error?: Error | null) => {
          if (error || performance.now() >= deadlineAt) fail();
          else if (!failed && !settled) {
            written = true;
            complete();
          }
        });
    } catch {
      fail();
    }
  });
}
