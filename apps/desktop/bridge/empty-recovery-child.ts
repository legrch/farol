import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BridgeError } from "./client.ts";
import { parseJSON } from "./frame.ts";
import type { ProfileLaunchBinding } from "./profile.ts";
import {
  validate,
  type CoreRetirementAcknowledged,
  type CoreTerminalObservation,
} from "./wire.ts";

// Go's private JSON uses numeric uint64 roots. Refuse unsafe JS integers rather
// than round a physical identity; this adapter does not change the Go codec.
export interface EmptyRecoveryRoot {
  readonly Device: number;
  readonly Inode: number;
  readonly OwnerUID: number;
}
export interface EmptyRecoveryBinding {
  readonly ProfileID: string;
  readonly BackendGeneration: string;
  readonly BuildID: string;
  readonly HostLifetimeID: string;
  readonly ChildLaunchID: string;
  readonly ParentRoot: EmptyRecoveryRoot;
  readonly ChatRoot: EmptyRecoveryRoot;
}
export interface EmptyRecoveryPublication {
  readonly Binding: EmptyRecoveryBinding;
  readonly HandoffID: string;
  readonly ReceiptDigest: readonly number[];
}
export interface ExactEmptyRecoverySelection {
  readonly buildId: string;
  readonly operationId: string;
  readonly current: EmptyRecoveryBinding;
  readonly hostLifetimeId: string;
  readonly childLaunchId: string;
  readonly backendGeneration: string;
}
export interface EmptyRecoverySelectionInput {
  readonly UnacknowledgedDev?: true;
  readonly InstalledEmpty?: true;
  readonly InstalledPreserved?: true;
  readonly Preserved?: readonly unknown[];
  readonly Interrupted?: {
    readonly OriginalHandoffID: string;
    readonly ExpectedACKDigest: readonly number[];
  };
  readonly Profile?: {
    readonly ProfileID: "";
    readonly Root: "";
    readonly Device: 0;
    readonly Inode: 0;
  };
  readonly Selection: {
    readonly OperationID: string;
    readonly Current: EmptyRecoveryBinding;
    readonly HeadDigest: readonly number[];
    readonly LifecycleDigest: readonly number[];
    readonly Next: {
      readonly ProfileID: string;
      readonly BackendGeneration: string;
    };
    readonly BuildID: string;
    readonly HostLifetimeID: string;
    readonly ChildLaunchID: string;
  };
  readonly OwnerID: string;
  readonly ComputerID: string;
  readonly AccessDigest: readonly number[];
  // The Go owner validates these complete retained records; no TS settlement policy.
  readonly Mutations: readonly unknown[];
}
export interface EmptyRecoveryChildResult {
  readonly acknowledgement: CoreRetirementAcknowledged;
  readonly terminal: CoreTerminalObservation;
  readonly publication: EmptyRecoveryPublication;
}

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
    validate("id", value) && typeof value === "string" && value.length <= 120
  );
}
function digest(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 32 &&
    value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) &&
    value.some((v) => v !== 0)
  );
}
function root(value: unknown): EmptyRecoveryRoot {
  const v = object(value, ["Device", "Inode", "OwnerUID"]);
  if (
    ![v.Device, v.Inode].every(
      (n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0,
    ) ||
    !validate("uint32", v.OwnerUID)
  )
    throw Error("invalid root");
  return v as unknown as EmptyRecoveryRoot;
}
function binding(value: unknown): EmptyRecoveryBinding {
  const v = object(value, [
    "ProfileID",
    "BackendGeneration",
    "BuildID",
    "HostLifetimeID",
    "ChildLaunchID",
    "ParentRoot",
    "ChatRoot",
  ]);
  if (
    ![
      v.ProfileID,
      v.BackendGeneration,
      v.BuildID,
      v.HostLifetimeID,
      v.ChildLaunchID,
    ].every(id)
  )
    throw Error("invalid binding");
  root(v.ParentRoot);
  root(v.ChatRoot);
  return v as unknown as EmptyRecoveryBinding;
}

// Caller owns executable attestation, the current profile lease and independent
// host/process closure. No recorder, profile operation, provider or retry here.
export function prepareEmptyRecoveryChild(
  executable: string,
  profile: ProfileLaunchBinding,
  selectionInput: EmptyRecoverySelectionInput,
  exactSelectionCorrelation: ExactEmptyRecoverySelection,
): Promise<EmptyRecoveryChildResult> {
  let expected: ExactEmptyRecoverySelection;
  let selectedProfile: ProfileLaunchBinding;
  let payload: string;
  let preparationMode:
    "prepare-empty-recovery" | "prepare-installed-empty-recovery";
  try {
    selectedProfile = structuredClone(profile);
    expected = structuredClone(exactSelectionCorrelation);
    object(expected, [
      "buildId",
      "operationId",
      "current",
      "hostLifetimeId",
      "childLaunchId",
      "backendGeneration",
    ]);
    binding(expected.current);
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
      ].every(id) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(
        expected.operationId,
      ) ||
      !isAbsolute(selectedProfile.root) ||
      !validate("decimal", selectedProfile.device) ||
      !validate("decimal", selectedProfile.inode) ||
      BigInt(selectedProfile.device) !==
        BigInt(expected.current.ParentRoot.Device) ||
      BigInt(selectedProfile.inode) !==
        BigInt(expected.current.ParentRoot.Inode) ||
      expected.current.ProfileID !== selectedProfile.profileId
    )
      throw Error("invalid selection");
    // Snapshot before spawn; no caller mutation can change the selected exchange.
    payload = JSON.stringify(selectionInput);
    if (typeof payload !== "string" || Buffer.byteLength(payload) > 65536)
      throw Error("invalid input size");
    const input = parseJSON(payload);
    if (!validate("json", input)) throw Error("invalid input JSON");
    const fields = Object.keys(input as object);
    const v = object(input, [
      "Selection",
      "OwnerID",
      "ComputerID",
      "AccessDigest",
      "Mutations",
      ...(fields.includes("Profile") ? ["Profile"] : []),
      ...(fields.includes("Interrupted") ? ["Interrupted"] : []),
      ...(fields.includes("UnacknowledgedDev") ? ["UnacknowledgedDev"] : []),
      ...(fields.includes("InstalledEmpty") ? ["InstalledEmpty"] : []),
      ...(fields.includes("InstalledPreserved") ? ["InstalledPreserved"] : []),
      ...(fields.includes("Preserved") ? ["Preserved"] : []),
    ]);
    if (
      fields.includes("UnacknowledgedDev") &&
      (v.UnacknowledgedDev !== true || fields.includes("Interrupted"))
    )
      throw Error("invalid unacknowledged Dev selection");
    if (
      fields.includes("InstalledEmpty") &&
      (v.InstalledEmpty !== true ||
        fields.includes("Interrupted") ||
        fields.includes("UnacknowledgedDev") ||
        !Array.isArray(v.Mutations) ||
        v.Mutations.length !== 0)
    )
      throw Error("invalid installed empty selection");
    if (fields.includes("InstalledPreserved")) {
      if (
        v.InstalledPreserved !== true ||
        fields.includes("InstalledEmpty") ||
        fields.includes("Interrupted") ||
        fields.includes("UnacknowledgedDev") ||
        !Array.isArray(v.Mutations) ||
        v.Mutations.length !== 0 ||
        !Array.isArray(v.Preserved) ||
        v.Preserved.length < 1 ||
        v.Preserved.length > 128
      )
        throw Error("invalid installed preserved selection");
    } else if (fields.includes("Preserved")) {
      throw Error("preserved records require explicit maintenance selection");
    }
    if (fields.includes("Interrupted")) {
      const interrupted = object(v.Interrupted, [
        "OriginalHandoffID",
        "ExpectedACKDigest",
      ]);
      if (
        !id(interrupted.OriginalHandoffID) ||
        !digest(interrupted.ExpectedACKDigest)
      )
        throw Error("invalid interrupted retirement");
    }
    if (
      fields.includes("Profile") &&
      !isDeepStrictEqual(v.Profile, {
        ProfileID: "",
        Root: "",
        Device: 0,
        Inode: 0,
      })
    )
      throw Error("profile override");
    const s = object(v.Selection, [
      "OperationID",
      "Current",
      "HeadDigest",
      "LifecycleDigest",
      "Next",
      "BuildID",
      "HostLifetimeID",
      "ChildLaunchID",
    ]);
    if (
      !isDeepStrictEqual(s.Current, expected.current) ||
      s.OperationID !== expected.operationId ||
      s.BuildID !== expected.buildId ||
      s.HostLifetimeID !== expected.hostLifetimeId ||
      s.ChildLaunchID !== expected.childLaunchId ||
      !isDeepStrictEqual(s.Next, {
        ProfileID: selectedProfile.profileId,
        BackendGeneration: expected.backendGeneration,
      }) ||
      !digest(s.HeadDigest) ||
      !digest(s.LifecycleDigest) ||
      !digest(v.AccessDigest) ||
      !id(v.OwnerID) ||
      !id(v.ComputerID) ||
      !Array.isArray(v.Mutations)
    )
      throw Error("input correlation mismatch");
    preparationMode =
      v.InstalledEmpty === true || v.InstalledPreserved === true
        ? "prepare-installed-empty-recovery"
        : "prepare-empty-recovery";
  } catch {
    return Promise.reject(
      new BridgeError("refused", "empty_recovery_selection_invalid"),
    );
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        executable,
        [
          preparationMode,
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
      reject(new BridgeError("unknown", "empty_recovery_launch_unconfirmed"));
      return;
    }
    let pending = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let messages = 0;
    let publication: EmptyRecoveryPublication | undefined;
    let acknowledgement: CoreRetirementAcknowledged | undefined;
    let ackWritten = false;
    let failed = false;
    let forced = false;
    let closed = false;
    let settled = false;
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => fail(), 8000);
    const complete = (): void => {
      if (settled || !closed) return;
      if (
        failed ||
        forced ||
        messages !== 2 ||
        pending.length !== 0 ||
        !publication ||
        !acknowledgement
      ) {
        settled = true;
        clearTimeout(deadline);
        clearTimeout(cleanupDeadline);
        reject(new BridgeError("unknown", "empty_recovery_unconfirmed"));
        return;
      }
      // Original close may precede the write callback. Keep the original total
      // deadline until both observations qualify this same exchange.
      if (!ackWritten) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(cleanupDeadline);
      const terminal: CoreTerminalObservation = {
        ...acknowledgement,
        backendGeneration: expected.backendGeneration,
        hostLifetimeId: expected.hostLifetimeId,
        childLaunchId: expected.childLaunchId,
        exitCode: "0",
        signal: "",
        forced: false,
      };
      if (!validate("CoreTerminalObservation", terminal)) {
        reject(new BridgeError("unknown", "empty_recovery_unconfirmed"));
        return;
      }
      resolve({ acknowledgement, terminal, publication });
    };
    const fail = (): void => {
      if (settled || failed) return;
      failed = true;
      pending = Buffer.alloc(0);
      if (closed) {
        complete();
        return;
      }
      forced = true;
      // One second to observe ORIGINAL close after signalling only this handle.
      cleanupDeadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(
          new BridgeError("unknown", "empty_recovery_cleanup_unconfirmed"),
        );
      }, 1000);
      try {
        child.kill("SIGKILL");
      } catch {
        /* Close, never kill return, is proof. */
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
      stderrBytes = Math.min(8193, stderrBytes + chunk.length);
      if (stderrBytes > 8192) fail(); // Count only; never retain/log diagnostics.
    });
    const receive = (value: unknown): void => {
      if (messages === 0) {
        const reply = object(value, ["schema", "buildId", "publication"]);
        if (
          reply.schema !== "farol-empty-recovery-prepared/1" ||
          reply.buildId !== expected.buildId
        )
          throw Error("invalid prepared envelope");
        const p = object(reply.publication, [
          "Binding",
          "HandoffID",
          "ReceiptDigest",
        ]);
        const b = binding(p.Binding);
        const fresh = b.ChatRoot;
        if (
          p.HandoffID !== expected.operationId ||
          !digest(p.ReceiptDigest) ||
          b.ProfileID !== selectedProfile.profileId ||
          b.BuildID !== expected.buildId ||
          b.BackendGeneration !== expected.backendGeneration ||
          b.HostLifetimeID !== expected.hostLifetimeId ||
          b.ChildLaunchID !== expected.childLaunchId ||
          !isDeepStrictEqual(b.ParentRoot, expected.current.ParentRoot) ||
          fresh.Device !== expected.current.ChatRoot.Device ||
          fresh.OwnerUID !== expected.current.ChatRoot.OwnerUID ||
          fresh.Inode === expected.current.ChatRoot.Inode ||
          fresh.Inode === b.ParentRoot.Inode
        )
          throw Error("publication correlation mismatch");
        publication = p as unknown as EmptyRecoveryPublication;
        messages = 1;
        // Explicit initiating-host ACK of the actual validated publication.
        child.stdin.end(
          `${JSON.stringify({ Publication: publication })}\n`,
          (error?: Error | null) => {
            if (error) fail();
            else if (!failed && !settled) {
              ackWritten = true;
              complete();
            }
          },
        );
      } else if (messages === 1 && publication) {
        const reply = object(value, ["schema", "buildId", "acknowledgement"]);
        if (
          reply.schema !== "farol-empty-recovery-acknowledged/1" ||
          reply.buildId !== expected.buildId ||
          !validate("CoreRetirementAcknowledged", reply.acknowledgement)
        )
          throw Error("invalid ACK envelope");
        const ack = reply.acknowledgement as CoreRetirementAcknowledged;
        if (
          ack.handoffId !== publication.HandoffID ||
          ack.receiptDigest !==
            Buffer.from(publication.ReceiptDigest).toString("hex") ||
          !/^[a-f0-9]{64}$/u.test(ack.ackDigest) ||
          /^0{64}$/u.test(ack.ackDigest)
        )
          throw Error("ACK correlation mismatch");
        acknowledgement = ack;
        messages = 2;
      } else throw Error("unexpected message");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (failed || settled) return;
      if (!Buffer.isBuffer(chunk) || chunk.length > 16384 - stdoutBytes) {
        fail();
        return;
      }
      stdoutBytes += chunk.length;
      pending = Buffer.concat([pending, chunk]);
      try {
        let newline: number;
        while ((newline = pending.indexOf(10)) !== -1) {
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          receive(
            parseJSON(new TextDecoder("utf-8", { fatal: true }).decode(line)),
          );
          if (failed || settled) return;
        }
        if (messages === 2 && pending.length !== 0) throw Error("extra stdout");
      } catch {
        fail();
      }
    });
    try {
      child.stdin.write(`${payload}\n`, (error?: Error | null) => {
        if (error) fail();
      });
    } catch {
      fail();
    }
  });
}
