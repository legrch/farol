import { describe, expect, it } from "vitest";
import {
  knownEmptyRecoveryChild,
  type KnownEmptyRecoveryFailure,
  type PreparedEmptyRecoveryObservation,
} from "../../src/apps/desktop/closed-empty-chat-recovery";
import type { ExactEmptyRecoverySelection } from "../../apps/desktop/bridge/empty-recovery-child";

// Pure correlation only. The known original execution is a declared fixture;
// no stored record, callback Boolean, or mock proves physical process closure.
const exact: ExactEmptyRecoverySelection = {
  operationId: "835a913b-bc20-42c6-bf56-9b83852cde3c",
  buildId: "b".repeat(64),
  hostLifetimeId: "original-maintenance-host",
  childLaunchId: "original-maintenance-child",
  backendGeneration: "original-maintenance-generation",
  current: {
    ProfileID: "profile",
    BackendGeneration: "predecessor-generation",
    BuildID: "predecessor-build",
    HostLifetimeID: "predecessor-host",
    ChildLaunchID: "predecessor-child",
    ParentRoot: { Device: 1, Inode: 2, OwnerUID: 501 },
    ChatRoot: { Device: 1, Inode: 3, OwnerUID: 501 },
  },
};
const failure: KnownEmptyRecoveryFailure = {
  sourceCommit: "4dbeef4523241326c7d674a57dca1fc6e0bee30c",
  originalHostExitCode: 1,
  originalDiagnostic: "EMPTY_CHAT_RECOVERY_INTENT_CHANGED",
  originalOperationId: exact.operationId,
  originalBuildId: exact.buildId,
  originalChildClose: { exitCode: "0", signal: "", forced: false },
  recorderStarted: false,
  receiptSha256: "c".repeat(64),
  pendingSha256: "d".repeat(64),
  completionOperationId: "9a72670c-6355-47ae-9ee2-2dd666899efc",
};
const observed: PreparedEmptyRecoveryObservation = {
  publication: {
    Binding: {
      ...exact.current,
      BuildID: exact.buildId,
      BackendGeneration: exact.backendGeneration,
      HostLifetimeID: exact.hostLifetimeId,
      ChildLaunchID: exact.childLaunchId,
      ChatRoot: { Device: 1, Inode: 4, OwnerUID: 501 },
    },
    HandoffID: exact.operationId,
    ReceiptDigest: Array(32).fill(17) as number[],
  },
  acknowledgement: {
    handoffId: exact.operationId,
    receiptDigest: "11".repeat(32),
    ackDigest: "a".repeat(64),
  },
  archiveDigest: "e".repeat(64),
};
const newChat = { dev: 1, ino: 4 };

describe("known pre-recorder empty maintenance correlation", () => {
  it("uses original selected identity and independently known terminal scalars", () => {
    const result = knownEmptyRecoveryChild(exact, failure, observed, newChat);
    expect(result.terminal).toEqual({
      ...observed.acknowledgement,
      backendGeneration: exact.backendGeneration,
      hostLifetimeId: exact.hostLifetimeId,
      childLaunchId: exact.childLaunchId,
      exitCode: "0",
      signal: "",
      forced: false,
    });
    expect(result.publication).toEqual(observed.publication);
    expect(result.publication).not.toBe(observed.publication);
  });

  it.each([
    ["sourceCommit", "f".repeat(40)],
    ["originalHostExitCode", 0],
    ["originalDiagnostic", "EMPTY_CHAT_RECOVERY_REFUSED_OR_UNKNOWN"],
    ["originalOperationId", failure.completionOperationId],
    ["originalBuildId", "f".repeat(64)],
    ["recorderStarted", true],
    ["receiptSha256", "invalid"],
    ["pendingSha256", "invalid"],
    ["completionOperationId", exact.operationId],
  ])("refuses a different or missing known boundary: %s", (key, value) => {
    const bad = { ...failure, [key]: value } as KnownEmptyRecoveryFailure;
    expect(() =>
      knownEmptyRecoveryChild(exact, bad, observed, newChat),
    ).toThrow("EMPTY_CHAT_KNOWN_COMPLETION_REFUSED");
  });

  it.each([
    { exitCode: "1", signal: "", forced: false },
    { exitCode: "0", signal: "SIGTERM", forced: false },
    { exitCode: "0", signal: "", forced: true },
    {},
  ])(
    "never turns unknown/abnormal original closure into a terminal",
    (close) => {
      const bad = {
        ...failure,
        originalChildClose: close,
      } as KnownEmptyRecoveryFailure;
      expect(() =>
        knownEmptyRecoveryChild(exact, bad, observed, newChat),
      ).toThrow();
    },
  );

  it.each([
    { dev: 1, ino: 3 },
    { dev: 2, ino: 4 },
    { dev: 1, ino: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses old/crossed/unsafe Chat identity", (root) => {
    expect(() =>
      knownEmptyRecoveryChild(exact, failure, observed, root),
    ).toThrow();
  });

  it.each([
    "BuildID",
    "BackendGeneration",
    "HostLifetimeID",
    "ChildLaunchID",
    "ProfileID",
  ])(
    "refuses mismatched persisted %s without replacing the original identity",
    (key) => {
      const bad = structuredClone(observed);
      Object.assign(bad.publication.Binding, { [key]: "another" });
      expect(() =>
        knownEmptyRecoveryChild(exact, failure, bad, newChat),
      ).toThrow();
    },
  );

  it("requires receipt/ACK correlation and preserves supplied observations", () => {
    const before = structuredClone(observed);
    const bad = {
      ...structuredClone(observed),
      acknowledgement: {
        ...observed.acknowledgement,
        receiptDigest: "f".repeat(64),
      },
    };
    expect(() =>
      knownEmptyRecoveryChild(exact, failure, bad, newChat),
    ).toThrow();
    knownEmptyRecoveryChild(exact, failure, observed, newChat);
    expect(observed).toEqual(before);
  });
});
