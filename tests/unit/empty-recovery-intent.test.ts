import { describe, expect, it } from "vitest";
import { emptyRecoveryIntent } from "../../src/apps/desktop/closed-empty-chat-recovery";
import type { EmptyRecoverySelectionInput } from "../../apps/desktop/bridge/empty-recovery-child";

const profile = {
  profileId: "profile",
  root: "/synthetic/Farol Dev/farol-next-state/go-core",
  home: "/synthetic",
  device: "1",
  inode: "2",
};
function selection(identity: Record<string, unknown> = {}) {
  const physical = { Device: 1, Inode: 2, OwnerUID: 501 };
  return {
    Selection: {
      OperationID: "835a913b-bc20-42c6-bf56-9b83852cde3c",
      Current: {
        ProfileID: "profile",
        BackendGeneration: "original",
        BuildID: "build",
        HostLifetimeID: "host",
        ChildLaunchID: "child",
        ParentRoot: physical,
        ChatRoot: { ...physical, Inode: 3 },
      },
      HeadDigest: Array(32).fill(1) as number[],
      LifecycleDigest: Array(32).fill(2) as number[],
      Next: { ProfileID: "profile", BackendGeneration: "next" },
      BuildID: "build",
      HostLifetimeID: "maintenance-host",
      ChildLaunchID: "maintenance-child",
    },
    OwnerID: "owner",
    ComputerID: "computer",
    AccessDigest: Array(32).fill(3) as number[],
    Mutations: [1, 2].map((n) => ({
      Key: `mutation-${n}`,
      SHA256: String(n).repeat(64),
      Binding: {
        Identity: {
          OperationID: `operation-${n}`,
          OwnerID: "owner",
          Scope: "connector",
          ProfileID: "profile",
          ComputerID: "computer",
          ...identity,
        },
        Connector: { SessionID: `connector-session-${n}` },
        WorkspaceID: "workspace",
      },
    })),
  } satisfies EmptyRecoverySelectionInput;
}

describe("empty recovery intent Go value codec", () => {
  it("matches materialized Go zero fields for both JS-selected records", () => {
    const input = selection();
    const before = structuredClone(input);
    const expected = selection({
      SessionID: "",
      TaskID: "",
      TaskEpoch: 0,
      ParticipantID: "",
    });
    expect(emptyRecoveryIntent(input, profile)).toEqual({
      ...expected,
      Profile: {
        ProfileID: profile.profileId,
        Root: profile.root,
        Device: 1,
        Inode: 2,
      },
    });
    expect(input).toEqual(before);
  });

  it("retains supplied identity and every other selected field exactly", () => {
    const input = selection({
      SessionID: "task-session",
      TaskID: "task",
      TaskEpoch: 7,
      ParticipantID: "participant",
    });
    const actual = emptyRecoveryIntent(input, profile);
    expect(actual).toMatchObject(input);
    const changed = structuredClone(input);
    changed.Mutations[0]!.Binding.Connector.SessionID = "another-session";
    expect(emptyRecoveryIntent(changed, profile)).not.toEqual(actual);
    changed.Mutations[0]!.SHA256 = "f".repeat(64);
    expect(emptyRecoveryIntent(changed, profile)).not.toEqual(actual);
  });

  it.each([
    ["SessionID", null],
    ["TaskID", 0],
    ["ParticipantID", false],
    ["TaskEpoch", "0"],
    ["TaskEpoch", -1],
    ["TaskEpoch", 0.5],
    ["TaskEpoch", Number.MAX_SAFE_INTEGER + 1],
    ["TaskEpoch", undefined],
  ])(
    "refuses an explicitly invalid %s instead of defaulting it",
    (key, value) => {
      expect(() =>
        emptyRecoveryIntent(selection({ [key]: value }), profile),
      ).toThrow("EMPTY_CHAT_RECOVERY_SELECTION_INVALID");
    },
  );

  it.each([null, [], {}, { Binding: null }, { Binding: { Identity: [] } }])(
    "refuses missing or malformed selected identity before effects",
    (mutation) => {
      const input = { ...selection(), Mutations: [mutation] };
      expect(() => emptyRecoveryIntent(input, profile)).toThrow(
        "EMPTY_CHAT_RECOVERY_SELECTION_INVALID",
      );
    },
  );
});

it("normalizes preserved identities without changing their selected bytes or caller", () => {
  const base = selection();
  const input = {
    ...base,
    Mutations: [],
    InstalledPreserved: true as const,
    Preserved: [
      {
        Key: "a".repeat(64) + ".json",
        SHA256: "b".repeat(64),
        Identity: base.Mutations[0]!.Binding.Identity,
      },
    ],
  };
  const before = structuredClone(input);
  expect(emptyRecoveryIntent(input, profile)).toMatchObject({
    Preserved: [
      {
        ...input.Preserved[0],
        Identity: {
          ...input.Preserved[0]!.Identity,
          SessionID: "",
          TaskID: "",
          TaskEpoch: 0,
          ParticipantID: "",
        },
      },
    ],
  });
  expect(input).toEqual(before);
});
